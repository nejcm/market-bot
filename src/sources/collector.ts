import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import {
  isMarketUpdateJobType,
  type ExtendedEvidence,
  type MarketSnapshot,
  type Source,
  type SourceGap,
  type VerifiedMarketSnapshot,
} from "../domain/types";
import { fetchFailureSourceGap } from "../domain/source-gaps";
import { rankMovers } from "../movers/ranking";
import { withCache, type CacheOptions } from "./cache";
import type {
  CollectContext,
  CollectedSources,
  EarningsSetupCollected,
  FetchJsonRequestFn,
  FetchJsonResult,
  FetchLike,
  FetchTextRequestFn,
  FetchTextResult,
  RawSourceSnapshot,
  SourceRequest,
  SourceRequestExecutor,
  NewsRelevanceTarget,
  ThematicNewsQuery,
} from "./types";
import { createSourceRegistry } from "./registry";
import { DEFAULT_RETRY_DELAYS_MS, isTransientError, sleep } from "./retry-utils";
import { collectVerifiedMarketSnapshot } from "./verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "./instrument-identity";
import { addFinancialLensEvidence } from "./extended-evidence/financial-lens";
import { addBusinessFrameworkEvidence } from "./extended-evidence/business-framework";
import { addValuationEvidence } from "./extended-evidence/valuation";
import { buildYahooFundamentals } from "./extended-evidence/yahoo-fundamentals";
import { collectValuationComps } from "./extended-evidence/valuation-comps";
import { createPeerUniverseProposer } from "../research/peer-universe-proposal";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
} from "../research/peer-universe-cache";
import { parseNearEarningsEvent, computeImpliedMove } from "./extended-evidence/earnings-setup";
import { evidenceSource } from "./extended-evidence/common";
import type { ModelProvider } from "../model/types";
import type { PeerUniverseFallbackContext } from "../research/peer-universe";
import type { ResolvedResearchSubject } from "../research/research-subject-identity";
import { mergeModelInputSanitization } from "./model-input-sanitizer";
import {
  sanitizeInstrumentIdentityMetadata,
  sanitizeMarketSnapshotMetadata,
} from "./metadata-sanitization";

interface HostState {
  queue: Promise<void>;
  lastStartedAt: number;
  consecutiveFailures: number;
  openedUntil: number;
}

class SourceCircuitOpenError extends Error {
  constructor(adapter: string, host: string) {
    super(`${adapter} circuit open for ${host}`);
    this.name = "SourceCircuitOpenError";
  }
}

const DEFAULT_HOST_MIN_DELAY_MS = 1000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const MAX_SOURCE_RESPONSE_BYTES = 5_000_000;
const hostStates = new Map<string, HostState>();

let hostMinDelayMs = DEFAULT_HOST_MIN_DELAY_MS;

function noop(): void {}

function buildImpliedMoveSource(
  command: ResearchCommand,
  impliedMove: EarningsSetupCollected["impliedMove"],
): Source | undefined {
  const sourceId = impliedMove?.sourceIds[0];
  if (impliedMove === undefined || sourceId === undefined) {
    return undefined;
  }
  const label = isInstrumentCommand(command) ? command.symbol : "earnings";
  return evidenceSource(
    sourceId,
    `${label} earnings implied move`,
    "tradier",
    command,
    impliedMove.observedAt,
  );
}

function hostForUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function statusCode(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const status = /status (\d+)/u.exec(error.message)?.[1];
  return status !== undefined ? Number(status) : undefined;
}

function isLimitError(error: unknown): boolean {
  const code = statusCode(error);
  return code === 402 || code === 429;
}

function shouldRecordCircuitFailure(error: unknown): boolean {
  return isLimitError(error) || isTransientError(error);
}

async function readCappedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  adapter: string,
  chunks: Uint8Array[] = [],
  total = 0,
): Promise<{ readonly chunks: readonly Uint8Array[]; readonly total: number }> {
  const { done, value } = await reader.read();
  if (done) {
    return { chunks, total };
  }
  const nextTotal = total + value.byteLength;
  if (nextTotal > MAX_SOURCE_RESPONSE_BYTES) {
    throw new Error(
      `${adapter} source response exceeded ${String(MAX_SOURCE_RESPONSE_BYTES)} bytes`,
    );
  }
  chunks.push(value);
  return readCappedChunks(reader, adapter, chunks, nextTotal);
}

async function runWithHostResilience<T>(
  url: string,
  adapter: string,
  task: () => Promise<T>,
): Promise<T> {
  const host = hostForUrl(url);
  const state = hostStates.get(host) ?? {
    queue: Promise.resolve(),
    lastStartedAt: 0,
    consecutiveFailures: 0,
    openedUntil: 0,
  };
  hostStates.set(host, state);

  const previous = state.queue;
  let release = noop;
  state.queue = previous
    .catch(() => {})
    .then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

  await previous.catch(() => {});

  try {
    const now = Date.now();
    if (state.openedUntil > now) {
      throw new SourceCircuitOpenError(adapter, host);
    }

    const waitMs = Math.max(0, hostMinDelayMs - (now - state.lastStartedAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    state.lastStartedAt = Date.now();

    const result = await task();
    state.consecutiveFailures = 0;
    return result;
  } catch (error: unknown) {
    if (shouldRecordCircuitFailure(error)) {
      state.consecutiveFailures += 1;
      if (isLimitError(error) || state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
        state.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
    }
    throw error;
  } finally {
    release();
  }
}

async function fetchPayload<TPayload>(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  accept: string,
  parse: (response: Response) => Promise<TPayload>,
  init: RequestInit = {},
): Promise<{ readonly rawSnapshot: RawSourceSnapshot; readonly payload: TPayload }> {
  return runWithHostResilience(url, adapter, async () => {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) {
      headers.set("accept", accept);
    }
    if (!headers.has("user-agent")) {
      headers.set("user-agent", "market-bot/0.1 research-cli");
    }

    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });

    if (!response.ok) {
      throw new Error(`${adapter} source request failed with status ${response.status}`);
    }

    const payload = await parse(response);

    return {
      rawSnapshot: {
        id: `raw-${adapter}-${fetchedAt}`,
        adapter,
        fetchedAt,
        payload,
      },
      payload,
    };
  });
}

async function readCappedResponseText(response: Response, adapter: string): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_SOURCE_RESPONSE_BYTES) {
    throw new Error(
      `${adapter} source response exceeded ${String(MAX_SOURCE_RESPONSE_BYTES)} bytes`,
    );
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_RESPONSE_BYTES) {
      throw new Error(
        `${adapter} source response exceeded ${String(MAX_SOURCE_RESPONSE_BYTES)} bytes`,
      );
    }
    return text;
  }

  const { chunks, total } = await readCappedChunks(reader, adapter);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchJson(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  init: RequestInit = {},
): Promise<FetchJsonResult> {
  return fetchPayload(
    url,
    adapter,
    fetchedAt,
    timeoutMs,
    fetchImpl,
    "application/json",
    async (response) => JSON.parse(await readCappedResponseText(response, adapter)) as unknown,
    init,
  );
}

async function fetchText(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  init: RequestInit = {},
): Promise<FetchTextResult> {
  return fetchPayload(
    url,
    adapter,
    fetchedAt,
    timeoutMs,
    fetchImpl,
    "text/html, text/plain;q=0.9, */*;q=0.1",
    async (response) => readCappedResponseText(response, adapter),
    init,
  );
}

export function resetSourceResilienceForTests(): void {
  hostStates.clear();
}

export function setSourceHostMinDelayMsForTests(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("source host minimum delay must be a finite non-negative number");
  }
  hostMinDelayMs = ms;
}

export { DEFAULT_RETRY_DELAYS_MS } from "./retry-utils";

function moverLimit(command: ResearchCommand, sourceOptions: SourceOptions): number {
  return command.assetClass === "crypto"
    ? sourceOptions.cryptoMoverLimit
    : sourceOptions.equityMoverLimit;
}

function moverNewsRelevanceTargets(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  marketSnapshots: readonly MarketSnapshot[],
): readonly NewsRelevanceTarget[] {
  if (!isMarketUpdateJobType(command.jobType)) {
    return [];
  }
  return rankMovers(
    marketSnapshots.filter((snapshot) => snapshot.assetClass === command.assetClass),
    moverLimit(command, sourceOptions),
  ).map(({ snapshot }) => ({
    symbol: snapshot.symbol,
    ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
  }));
}

function tickerNewsRelevanceTargets(
  command: ResearchCommand,
  displayName: string | undefined,
): readonly NewsRelevanceTarget[] {
  if (!isInstrumentCommand(command)) {
    return [];
  }
  return [
    {
      symbol: command.symbol,
      ...(displayName !== undefined ? { name: displayName } : {}),
    },
  ];
}

// Build news relevance targets for research runs from the subject registry (Phase 2.3).
// Uses the proxy symbol + subject display name/aliases for topic-level news matching,
// Plus each non-proxy representative instrument by symbol and name.
// Exported for testing; internal callers use this directly.
export function researchNewsRelevanceTargets(
  command: ResearchCommand,
  resolvedSubject?: ResolvedResearchSubject,
): readonly NewsRelevanceTarget[] {
  if (command.jobType !== "research") {
    return [];
  }
  if (
    resolvedSubject?.representativeInstruments === undefined ||
    resolvedSubject.subjectKey === undefined
  ) {
    return [];
  }
  const targets: NewsRelevanceTarget[] = [];

  // Proxy target: use the subject display name + aliases as the name for broad topic matching
  if (resolvedSubject.predictionProxySymbol !== undefined) {
    const topicName = [resolvedSubject.displayName, ...(resolvedSubject.aliases ?? [])]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    targets.push({ symbol: resolvedSubject.predictionProxySymbol, name: topicName });
  }

  // Non-proxy representative instruments by symbol and name
  for (const instrument of resolvedSubject.representativeInstruments) {
    if (instrument.symbol === resolvedSubject.predictionProxySymbol) {
      continue;
    }
    targets.push({
      symbol: instrument.symbol,
      ...(instrument.name !== undefined ? { name: instrument.name } : {}),
    });
  }

  return targets;
}

export function researchThematicNewsQuery(
  resolvedSubject: ResolvedResearchSubject | undefined,
): ThematicNewsQuery | undefined {
  if (
    resolvedSubject?.status !== "resolved" ||
    resolvedSubject.subjectKey === undefined ||
    resolvedSubject.displayName === undefined
  ) {
    return undefined;
  }
  const terms: string[] = [];
  const normalizedTerms = new Set<string>();
  for (const value of [resolvedSubject.displayName, ...(resolvedSubject.aliases ?? [])]) {
    const term = value.trim();
    const normalized = term.toLowerCase();
    if (term === "" || normalizedTerms.has(normalized)) {
      continue;
    }
    normalizedTerms.add(normalized);
    terms.push(term);
  }
  return terms.length === 0
    ? undefined
    : {
        subjectId: resolvedSubject.subjectKey,
        subjectLabel: resolvedSubject.displayName,
        terms,
      };
}

function contextWithNewsRelevanceTargets(
  ctx: CollectContext,
  targets: readonly NewsRelevanceTarget[],
): CollectContext {
  return targets.length === 0 ? ctx : { ...ctx, newsRelevanceTargets: targets };
}

function representativeSnapshotSymbols(
  resolvedSubject: ResolvedResearchSubject | undefined,
): readonly string[] {
  if (resolvedSubject?.status !== "resolved") {
    return [];
  }
  return [
    ...new Set(
      (resolvedSubject.representativeInstruments ?? [])
        .map((instrument) => instrument.symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

interface PromotedMarketSnapshots {
  readonly marketSnapshots: readonly {
    readonly snapshot: MarketSnapshot;
    readonly adapter: string;
  }[];
  readonly promotedSnapshots: ReadonlySet<MarketSnapshot>;
}

function promoteRequiredMarketSnapshots(
  primarySnapshots: readonly MarketSnapshot[],
  primaryAdapter: string,
  supplementalResults: readonly {
    readonly adapter: string;
    readonly snapshots: readonly MarketSnapshot[];
  }[],
  requiredSymbols: readonly string[],
): PromotedMarketSnapshots {
  const marketSnapshots = primarySnapshots.map((snapshot) => ({
    snapshot,
    adapter: primaryAdapter,
  }));
  const collectedSymbols = new Set(
    primarySnapshots.map((snapshot) => snapshot.symbol.trim().toUpperCase()),
  );
  const required = new Set(requiredSymbols);
  const promotedSnapshots = new Set<MarketSnapshot>();

  for (const result of supplementalResults) {
    for (const snapshot of result.snapshots) {
      const symbol = snapshot.symbol.trim().toUpperCase();
      if (!required.has(symbol) || collectedSymbols.has(symbol)) {
        continue;
      }
      marketSnapshots.push({ snapshot, adapter: result.adapter });
      promotedSnapshots.add(snapshot);
      collectedSymbols.add(symbol);
    }
  }

  return { marketSnapshots, promotedSnapshots };
}

async function fetchJsonWithRetry(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  remainingDelays: readonly number[],
  init?: RequestInit,
): Promise<FetchJsonResult> {
  try {
    return await fetchJson(url, adapter, fetchedAt, timeoutMs, fetchImpl, init);
  } catch (error: unknown) {
    const [nextDelay] = remainingDelays;
    if (nextDelay === undefined || !isTransientError(error)) {
      throw error;
    }
    await sleep(nextDelay);
    return fetchJsonWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      remainingDelays.slice(1),
      init,
    );
  }
}

async function fetchTextWithRetry(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  remainingDelays: readonly number[],
  init?: RequestInit,
): Promise<FetchTextResult> {
  try {
    return await fetchText(url, adapter, fetchedAt, timeoutMs, fetchImpl, init);
  } catch (error: unknown) {
    const [nextDelay] = remainingDelays;
    if (nextDelay === undefined || !isTransientError(error)) {
      throw error;
    }
    await sleep(nextDelay);
    return fetchTextWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      remainingDelays.slice(1),
      init,
    );
  }
}

async function fetchJsonOrGap(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  init?: RequestInit,
): Promise<FetchJsonResult | SourceGap> {
  try {
    return await fetchJsonWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      retryDelaysMs,
      init,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "source request failed";
    return fetchFailureSourceGap(
      adapter,
      message,
      error instanceof SourceCircuitOpenError ? "circuit-open" : "fetch-failed",
    );
  }
}

async function fetchTextOrGap(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  init?: RequestInit,
): Promise<FetchTextResult | SourceGap> {
  try {
    return await fetchTextWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      retryDelaysMs,
      init,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "source request failed";
    return fetchFailureSourceGap(
      adapter,
      message,
      error instanceof SourceCircuitOpenError ? "circuit-open" : "fetch-failed",
    );
  }
}

function cachedTextFetch(inner: FetchTextRequestFn, options: CacheOptions): FetchTextRequestFn {
  return withCache(inner, options, {
    isPayload: (payload): payload is string => typeof payload === "string",
    invalidMessage: "cached text payload was not a string",
  });
}

function cachedJsonFetch(inner: FetchJsonRequestFn, options: CacheOptions): FetchJsonRequestFn {
  return withCache(inner, options, {
    isPayload: (payload): payload is unknown[] | Record<string, unknown> =>
      (typeof payload === "object" && payload !== null) || Array.isArray(payload),
    invalidMessage: "cached JSON payload was not an object or array",
  });
}

interface SourceRequestExecutorOptions {
  readonly fetchedAt: string;
  readonly sourceTimeoutMs: number;
  readonly fetchImpl: FetchLike;
  readonly retryDelaysMs: readonly number[];
  readonly cacheOptions?: CacheOptions;
}

function createSourceRequestExecutor(options: SourceRequestExecutorOptions): SourceRequestExecutor {
  const json: FetchJsonRequestFn = (request: SourceRequest) =>
    fetchJsonOrGap(
      request.url,
      request.adapter,
      options.fetchedAt,
      options.sourceTimeoutMs,
      request.fetch?.(options.fetchImpl) ?? options.fetchImpl,
      options.retryDelaysMs,
      request.init,
    );
  const text: FetchTextRequestFn = (request: SourceRequest) =>
    fetchTextOrGap(
      request.url,
      request.adapter,
      options.fetchedAt,
      options.sourceTimeoutMs,
      request.fetch?.(options.fetchImpl) ?? options.fetchImpl,
      options.retryDelaysMs,
      request.init,
    );

  if (options.cacheOptions === undefined) {
    return { json, text };
  }

  return {
    json: cachedJsonFetch(json, options.cacheOptions),
    text: cachedTextFetch(text, options.cacheOptions),
  };
}

export interface PeerUniverseSeam {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly cachePath: string;
  readonly ttlDays?: number;
}

export interface CollectSourcesRuntimeOptions {
  readonly now?: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly peerUniverse?: PeerUniverseSeam;
  readonly resolvedSubject?: ResolvedResearchSubject;
}

function peerUniverseFallbackFor(
  peerUniverse: PeerUniverseSeam | undefined,
  ctx: CollectContext,
  now: Date,
): PeerUniverseFallbackContext | undefined {
  return peerUniverse === undefined
    ? undefined
    : {
        cacheRead: makePeerUniverseCacheReader(peerUniverse.cachePath, peerUniverse.ttlDays, now),
        cacheWrite: makePeerUniverseCacheWriter(
          peerUniverse.cachePath,
          peerUniverse.ttlDays,
          peerUniverse.provider.name,
          now,
        ),
        propose: createPeerUniverseProposer({
          provider: peerUniverse.provider,
          model: peerUniverse.model,
          request: ctx.request,
          ...(ctx.secUserAgent !== undefined ? { secUserAgent: ctx.secUserAgent } : {}),
          ...(ctx.instrumentIdentity?.displayName !== undefined
            ? { targetName: ctx.instrumentIdentity.displayName }
            : {}),
        }),
      };
}

export async function collectSources(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  runtime: CollectSourcesRuntimeOptions = {},
): Promise<CollectedSources> {
  const now = runtime.now ?? new Date();
  const requestFetchImpl = runtime.fetchImpl ?? fetch;
  const requestRetryDelaysMs = runtime.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const peerUniverseSeam = runtime.peerUniverse;
  const resolvedSubject = "resolvedSubject" in runtime ? runtime.resolvedSubject : undefined;
  const { context: ctx, staleFallbackGaps } = createCollectContext(
    command,
    sourceOptions,
    now,
    requestFetchImpl,
    requestRetryDelaysMs,
  );

  const registry = createSourceRegistry();
  const requiredMarketSnapshotSymbols = representativeSnapshotSymbols(resolvedSubject);
  const marketCtx =
    requiredMarketSnapshotSymbols.length === 0 ? ctx : { ...ctx, requiredMarketSnapshotSymbols };
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const supplementalMarketAdapters = registry.supplementalMarketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const extendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);
  const marketContextAdapter = registry.marketContextFor(command.assetClass);

  // Verified Market Snapshot: equity ticker only (ADR 0019); joins the parallel batch
  const isEquityTicker = isInstrumentCommand(command) && command.assetClass === "equity";
  const isTicker = isInstrumentCommand(command);

  // Market updates and ticker runs sequence market first so current ranked movers or resolved
  // Instrument identity can steer news selection.
  // Research runs resolve registry-based relevance targets without waiting on market data.
  // Other run types keep the parallel source collection path.
  const shouldCollectMarketBeforeNews =
    isMarketUpdateJobType(command.jobType) || isInstrumentCommand(command);
  const marketResult = shouldCollectMarketBeforeNews
    ? await marketAdapter.collect(marketCtx)
    : undefined;
  const preliminaryIdentityResult =
    isTicker && marketResult !== undefined
      ? deriveCanonicalInstrumentIdentity(marketResult.marketSnapshots, command.symbol)
      : undefined;
  // Thread resolved identity (exchange/quoteCurrency) into the source-collection context so
  // US-only collectors can gate on the primary instrument-capability signal, not just the suffix.
  const identityCtx: CollectContext =
    preliminaryIdentityResult?.identity !== undefined
      ? { ...ctx, instrumentIdentity: preliminaryIdentityResult.identity }
      : ctx;
  let newsContext: CollectContext = identityCtx;
  if (marketResult !== undefined) {
    const targets = isMarketUpdateJobType(command.jobType)
      ? moverNewsRelevanceTargets(command, sourceOptions, marketResult.marketSnapshots)
      : tickerNewsRelevanceTargets(command, preliminaryIdentityResult?.identity?.displayName);
    newsContext = contextWithNewsRelevanceTargets(identityCtx, targets);
  } else if (command.jobType === "research") {
    const thematicNewsQuery = researchThematicNewsQuery(resolvedSubject);
    newsContext = contextWithNewsRelevanceTargets(
      identityCtx,
      researchNewsRelevanceTargets(command, resolvedSubject),
    );
    if (thematicNewsQuery !== undefined) {
      newsContext = { ...newsContext, thematicNewsQuery };
    }
  }
  const [
    resolvedMarketResult,
    newsResult,
    extendedResult,
    marketContextResult,
    verifiedSnapshotResult,
  ] = await Promise.all([
    marketResult ?? marketAdapter.collect(marketCtx),
    newsAdapter.collect(newsContext),
    extendedEvidenceAdapter.collect(identityCtx),
    marketContextAdapter.collect(ctx),
    isEquityTicker
      ? collectVerifiedMarketSnapshot(ctx, command.symbol, ctx.fetchedAt.slice(0, 10))
      : undefined,
  ]);
  const supplementalMarketResults = await Promise.all(
    supplementalMarketAdapters.map((adapter) =>
      adapter.collect(marketCtx, resolvedMarketResult.marketSnapshots),
    ),
  );
  const promotedMarket = promoteRequiredMarketSnapshots(
    resolvedMarketResult.marketSnapshots,
    marketAdapter.name,
    supplementalMarketResults.map((result, index) => ({
      adapter: supplementalMarketAdapters[index]?.name ?? "supplemental-market-data",
      snapshots: result.supplementalMarketSnapshots,
    })),
    requiredMarketSnapshotSymbols,
  );
  const sanitizedMarket = promotedMarket.marketSnapshots.map(({ snapshot, adapter }) =>
    sanitizeMarketSnapshotMetadata(snapshot, adapter),
  );
  const sanitizedSupplemental = supplementalMarketResults.flatMap((result, index) =>
    result.supplementalMarketSnapshots
      .filter((snapshot) => !promotedMarket.promotedSnapshots.has(snapshot))
      .map((snapshot) =>
        sanitizeMarketSnapshotMetadata(
          snapshot,
          supplementalMarketAdapters[index]?.name ?? "supplemental-market-data",
        ),
      ),
  );

  const enrichmentResult = await collectEquityEnrichment({
    command,
    marketSnapshots: resolvedMarketResult.marketSnapshots,
    extendedEvidence: extendedResult.extendedEvidence,
    extendedRawSnapshots: extendedResult.rawSnapshots,
    verifiedMarketSnapshot: verifiedSnapshotResult?.snapshot,
    fetchedAt: ctx.fetchedAt,
    context: ctx,
    identityContext: identityCtx,
    preliminaryIdentityResult,
    now,
    peerUniverse: peerUniverseSeam,
  });
  staleFallbackGaps.push(...enrichmentResult.earningsSourceGaps);
  const rawIdentity = enrichmentResult.identityResult?.identity;
  const sanitizedIdentity =
    rawIdentity === undefined
      ? undefined
      : sanitizeInstrumentIdentityMetadata(rawIdentity, "instrument-identity");
  const resolvedInstrumentIdentity = sanitizedIdentity?.identity;

  return {
    rawSnapshots: [
      ...resolvedMarketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...extendedResult.rawSnapshots,
      ...(enrichmentResult.valuationCompsResult?.rawSnapshots ?? []),
      ...marketContextResult.rawSnapshots,
      ...supplementalMarketResults.flatMap((result) => result.rawSnapshots),
      ...(verifiedSnapshotResult?.rawSnapshot !== undefined
        ? [verifiedSnapshotResult.rawSnapshot]
        : []),
    ],
    marketSnapshots: sanitizedMarket.map((result) => result.snapshot),
    supplementalMarketSnapshots: sanitizedSupplemental.map((result) => result.snapshot),
    newsSources: newsResult.newsSources,
    extendedSources: [
      ...extendedResult.sources,
      ...(enrichmentResult.valuationCompsResult?.sources ?? []),
      ...enrichmentResult.earningsExtraSources,
    ],
    ...(enrichmentResult.businessFrameworkResult.extendedEvidence !== undefined
      ? { extendedEvidence: enrichmentResult.businessFrameworkResult.extendedEvidence }
      : {}),
    ...(marketContextResult.marketContext !== undefined
      ? { marketContext: marketContextResult.marketContext }
      : {}),
    marketContextSources: marketContextResult.sources,
    ...(newsResult.newsAnalytics !== undefined ? { newsAnalytics: newsResult.newsAnalytics } : {}),
    modelInputSanitization: mergeModelInputSanitization(newsResult.modelInputSanitization, {
      entries: [
        ...sanitizedMarket.flatMap((result) => result.entries),
        ...sanitizedSupplemental.flatMap((result) => result.entries),
        ...(sanitizedIdentity?.entries ?? []),
      ],
    }),
    ...(verifiedSnapshotResult?.snapshot !== undefined
      ? { verifiedMarketSnapshot: verifiedSnapshotResult.snapshot }
      : {}),
    ...(resolvedInstrumentIdentity !== undefined ? { resolvedInstrumentIdentity } : {}),
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    ...(enrichmentResult.earningsSetup !== undefined
      ? { earningsSetup: enrichmentResult.earningsSetup }
      : {}),
    ...(enrichmentResult.valuationCompsResult?.artifact !== undefined
      ? { valuationComps: enrichmentResult.valuationCompsResult.artifact }
      : {}),
    ...(enrichmentResult.financialLensResult.artifact !== undefined
      ? { financialLenses: enrichmentResult.financialLensResult.artifact }
      : {}),
    ...(enrichmentResult.businessFrameworkResult.artifact !== undefined
      ? { businessFramework: enrichmentResult.businessFrameworkResult.artifact }
      : {}),
    sourceGaps: [
      ...resolvedMarketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...extendedResult.sourceGaps,
      ...enrichmentResult.valuationResult.sourceGaps,
      ...(enrichmentResult.valuationCompsResult?.gaps ?? []),
      ...enrichmentResult.financialLensResult.sourceGaps,
      ...enrichmentResult.businessFrameworkResult.sourceGaps,
      ...marketContextResult.sourceGaps,
      ...supplementalMarketResults.flatMap((result) => result.sourceGaps),
      ...(verifiedSnapshotResult?.sourceGaps ?? []),
      ...(enrichmentResult.identityResult?.gap !== undefined
        ? [enrichmentResult.identityResult.gap]
        : []),
      ...staleFallbackGaps,
    ],
  };
}

type InstrumentIdentityResult = ReturnType<typeof deriveCanonicalInstrumentIdentity>;
type ValuationResult = ReturnType<typeof addValuationEvidence>;
type ValuationCompsResult = Awaited<ReturnType<typeof collectValuationComps>>;
type FinancialLensResult = ReturnType<typeof addFinancialLensEvidence>;
type BusinessFrameworkResult = ReturnType<typeof addBusinessFrameworkEvidence>;

interface EquityEnrichmentInput {
  readonly command: ResearchCommand;
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly extendedRawSnapshots: readonly RawSourceSnapshot[];
  readonly verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined;
  readonly fetchedAt: string;
  readonly context: CollectContext;
  readonly identityContext: CollectContext;
  readonly preliminaryIdentityResult: InstrumentIdentityResult | undefined;
  readonly now: Date;
  readonly peerUniverse: PeerUniverseSeam | undefined;
}

interface EquityEnrichmentResult {
  readonly identityResult: InstrumentIdentityResult | undefined;
  readonly valuationResult: ValuationResult;
  readonly valuationCompsResult: ValuationCompsResult | undefined;
  readonly financialLensResult: FinancialLensResult;
  readonly businessFrameworkResult: BusinessFrameworkResult;
  readonly earningsSetup: EarningsSetupCollected | undefined;
  readonly earningsExtraSources: readonly Source[];
  readonly earningsSourceGaps: readonly SourceGap[];
}

async function collectEquityEnrichment(
  input: EquityEnrichmentInput,
): Promise<EquityEnrichmentResult> {
  const identityResult =
    input.preliminaryIdentityResult ??
    (isInstrumentCommand(input.command)
      ? deriveCanonicalInstrumentIdentity(input.marketSnapshots, input.command.symbol)
      : undefined);
  if (isMarketUpdateJobType(input.command.jobType)) {
    return noEquityEnrichment(identityResult, input.extendedEvidence);
  }
  if (!isInstrumentCommand(input.command) || input.command.assetClass !== "equity") {
    return noEquityEnrichment(identityResult, input.extendedEvidence);
  }

  const valuationResult = addValuationEvidence(
    input.command,
    input.marketSnapshots,
    input.extendedEvidence,
  );
  const peerUniverseFallback =
    input.command.depth === "deep"
      ? peerUniverseFallbackFor(input.peerUniverse, input.identityContext, input.now)
      : undefined;
  const valuationCompsResult =
    input.command.depth === "deep" &&
    valuationResult.extendedEvidence?.items.some((item) => item.category === "valuation") === true
      ? await collectValuationComps(
          input.identityContext,
          input.command,
          input.marketSnapshots,
          valuationResult.extendedEvidence,
          peerUniverseFallback !== undefined ? { peerUniverseFallback } : undefined,
        )
      : undefined;
  const evidenceWithComps =
    valuationCompsResult?.extendedEvidence ?? valuationResult.extendedEvidence;
  const evidenceWithYahooFundamentals = addYahooFundamentals(
    input.command,
    input.marketSnapshots,
    evidenceWithComps,
    input.fetchedAt,
  );
  const financialLensResult = addFinancialLensEvidence(
    input.command,
    input.marketSnapshots,
    evidenceWithYahooFundamentals,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
  );
  const businessFrameworkResult = addBusinessFrameworkEvidence(
    input.command,
    input.marketSnapshots,
    financialLensResult.extendedEvidence,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
  );
  const earningsResult =
    input.command.depth === "deep"
      ? await collectEarningsSetup(
          input.command,
          input.marketSnapshots,
          input.extendedRawSnapshots,
          input.context,
        )
      : { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };

  return {
    identityResult,
    valuationResult,
    valuationCompsResult,
    financialLensResult,
    businessFrameworkResult,
    ...earningsResult,
  };
}

function noEquityEnrichment(
  identityResult: InstrumentIdentityResult | undefined,
  extendedEvidence: ExtendedEvidence | undefined,
): EquityEnrichmentResult {
  const valuationResult = passthroughValuationResult(extendedEvidence);
  const financialLensResult = passthroughFinancialLensResult(extendedEvidence);
  const businessFrameworkResult = passthroughBusinessFrameworkResult(extendedEvidence);
  return {
    identityResult,
    valuationResult,
    valuationCompsResult: undefined,
    financialLensResult,
    businessFrameworkResult,
    earningsSetup: undefined,
    earningsExtraSources: [],
    earningsSourceGaps: [],
  };
}

function passthroughValuationResult(
  extendedEvidence: ExtendedEvidence | undefined,
): ValuationResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function passthroughFinancialLensResult(
  extendedEvidence: ExtendedEvidence | undefined,
): FinancialLensResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function passthroughBusinessFrameworkResult(
  extendedEvidence: ExtendedEvidence | undefined,
): BusinessFrameworkResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function addYahooFundamentals(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  fetchedAt: string,
): ExtendedEvidence | undefined {
  const yahooFundamentalsItem = buildYahooFundamentals(command, marketSnapshots, fetchedAt);
  if (yahooFundamentalsItem === undefined || extendedEvidence === undefined) {
    return extendedEvidence;
  }
  return {
    ...(extendedEvidence.instrument !== undefined
      ? { instrument: extendedEvidence.instrument }
      : {}),
    ...(extendedEvidence.subject !== undefined ? { subject: extendedEvidence.subject } : {}),
    items: [...extendedEvidence.items, yahooFundamentalsItem],
    gaps: extendedEvidence.gaps,
  };
}

async function collectEarningsSetup(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedRawSnapshots: readonly RawSourceSnapshot[],
  context: CollectContext,
): Promise<{
  readonly earningsSetup: EarningsSetupCollected | undefined;
  readonly earningsExtraSources: readonly Source[];
  readonly earningsSourceGaps: readonly SourceGap[];
}> {
  const earningsCalendarSnapshot = extendedRawSnapshots.find(
    (snapshot) => snapshot.adapter === "finnhub-events-1",
  );
  if (earningsCalendarSnapshot === undefined) {
    return { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };
  }
  const earningsSourceId = `extended-finnhub-events-${command.symbol.toLowerCase()}`;
  const event = parseNearEarningsEvent(
    earningsCalendarSnapshot.payload,
    command.symbol,
    earningsCalendarSnapshot.fetchedAt,
    earningsSourceId,
  );
  if (event === undefined) {
    return { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };
  }

  const tickerSnapshot = marketSnapshots.find((snapshot) => snapshot.symbol === command.symbol);
  const spot = tickerSnapshot?.price;
  if (spot === undefined || spot <= 0) {
    return {
      earningsSetup: {
        event,
        gaps: ["Spot price unavailable; implied move could not be computed"],
      },
      earningsExtraSources: [],
      earningsSourceGaps: [],
    };
  }

  const moveResult = await computeImpliedMove(context, event, spot);
  const impliedMoveSource = buildImpliedMoveSource(command, moveResult.impliedMove);
  return {
    earningsSetup: {
      event,
      ...(moveResult.impliedMove !== undefined ? { impliedMove: moveResult.impliedMove } : {}),
      gaps: moveResult.gaps.map((gap) => gap.message),
    },
    earningsExtraSources: impliedMoveSource !== undefined ? [impliedMoveSource] : [],
    earningsSourceGaps: moveResult.gaps,
  };
}

export interface CollectContextBundle {
  readonly context: CollectContext;
  readonly staleFallbackGaps: SourceGap[];
}

export interface SourceRequestContextBundle {
  readonly request: SourceRequestExecutor;
  readonly staleFallbackGaps: SourceGap[];
}

export function createSourceRequestContext(
  sourceOptions: SourceOptions,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): SourceRequestContextBundle {
  const fetchedAt = now.toISOString();
  const staleFallbackGaps: SourceGap[] = [];
  const { cacheDir } = sourceOptions;
  const cacheOptions = {
    dir: cacheDir ?? "",
    disabled: sourceOptions.cacheDisabled ?? false,
    fallbackDays: sourceOptions.cacheFallbackDays ?? 7,
    now: () => now,
    onStaleFallback: (gap) => {
      staleFallbackGaps.push(gap);
    },
  } satisfies CacheOptions;
  const request = createSourceRequestExecutor({
    fetchedAt,
    sourceTimeoutMs: sourceOptions.sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    ...(cacheDir !== undefined ? { cacheOptions } : {}),
  });

  return { request, staleFallbackGaps };
}

export function createCollectContext(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): CollectContextBundle {
  const fetchedAt = now.toISOString();
  const { request, staleFallbackGaps } = createSourceRequestContext(
    sourceOptions,
    now,
    fetchImpl,
    retryDelaysMs,
  );

  return {
    context: {
      command,
      fetchedAt,
      newsLimit: sourceOptions.newsLimit,
      cryptoMoverLimit: sourceOptions.cryptoMoverLimit,
      ...(sourceOptions.marketauxApiToken !== undefined
        ? { marketauxApiToken: sourceOptions.marketauxApiToken }
        : {}),
      ...(sourceOptions.finnhubApiToken !== undefined
        ? { finnhubApiToken: sourceOptions.finnhubApiToken }
        : {}),
      ...(sourceOptions.fredApiKey !== undefined ? { fredApiKey: sourceOptions.fredApiKey } : {}),
      ...(sourceOptions.tradierApiToken !== undefined
        ? { tradierApiToken: sourceOptions.tradierApiToken }
        : {}),
      ...(sourceOptions.glassnodeApiKey !== undefined
        ? { glassnodeApiKey: sourceOptions.glassnodeApiKey }
        : {}),
      ...(sourceOptions.massiveApiKey !== undefined
        ? { massiveApiKey: sourceOptions.massiveApiKey }
        : {}),
      ...(sourceOptions.exaApiKey !== undefined ? { exaApiKey: sourceOptions.exaApiKey } : {}),
      ...(sourceOptions.firecrawlApiKey !== undefined
        ? { firecrawlApiKey: sourceOptions.firecrawlApiKey }
        : {}),
      ...(sourceOptions.secUserAgent !== undefined
        ? { secUserAgent: sourceOptions.secUserAgent }
        : {}),
      ...(sourceOptions.newsSeenPath !== undefined
        ? { newsSeenPath: sourceOptions.newsSeenPath }
        : {}),
      ...(sourceOptions.newsSeenRetentionDays !== undefined
        ? { newsSeenRetentionDays: sourceOptions.newsSeenRetentionDays }
        : {}),
      request,
    },
    staleFallbackGaps,
  };
}
