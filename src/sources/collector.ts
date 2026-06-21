import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { MarketSnapshot, Source, SourceGap } from "../domain/types";
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
} from "./types";
import { createSourceRegistry } from "./registry";
import { DEFAULT_RETRY_DELAYS_MS, isTransientError, sleep } from "./retry-utils";
import { collectVerifiedMarketSnapshot } from "./verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "./instrument-identity";
import { addValuationEvidence } from "./extended-evidence/valuation";
import { resolveResearchSubjectProxy } from "../research/subject-registry";
import { parseNearEarningsEvent, computeImpliedMove } from "./extended-evidence/earnings-setup";
import { evidenceSource } from "./extended-evidence/common";

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
  const label = command.jobType === "ticker" ? command.symbol : "earnings";
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

function isMarketUpdateCommand(command: ResearchCommand): boolean {
  return (
    command.jobType === "market-overview" ||
    command.jobType === "daily" ||
    command.jobType === "weekly"
  );
}

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
  if (!isMarketUpdateCommand(command)) {
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
  if (command.jobType !== "ticker") {
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
): readonly NewsRelevanceTarget[] {
  if (command.jobType !== "research") {
    return [];
  }
  const resolution = resolveResearchSubjectProxy(command.subject);
  if (resolution.subject === undefined) {
    return [];
  }
  const entry = resolution.subject;
  const targets: NewsRelevanceTarget[] = [];

  // Proxy target: use the subject display name + aliases as the name for broad topic matching
  if (entry.predictionProxy !== undefined) {
    const topicName = [entry.displayName, ...entry.aliases].join(" ");
    targets.push({ symbol: entry.predictionProxy.symbol, name: topicName });
  }

  // Non-proxy representative instruments by symbol and name
  for (const instrument of entry.representativeInstruments) {
    if (instrument.symbol === entry.predictionProxy?.symbol) {
      continue;
    }
    targets.push({
      symbol: instrument.symbol,
      ...(instrument.name !== undefined ? { name: instrument.name } : {}),
    });
  }

  return targets;
}

function contextWithNewsRelevanceTargets(
  ctx: CollectContext,
  targets: readonly NewsRelevanceTarget[],
): CollectContext {
  return targets.length === 0 ? ctx : { ...ctx, newsRelevanceTargets: targets };
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
    json: withCache(json, options.cacheOptions),
    text: cachedTextFetch(text, options.cacheOptions),
  };
}

export async function collectSources(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<CollectedSources> {
  const { context: ctx, staleFallbackGaps } = createCollectContext(
    command,
    sourceOptions,
    now,
    fetchImpl,
    retryDelaysMs,
  );

  const registry = createSourceRegistry();
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const supplementalMarketAdapters = registry.supplementalMarketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const extendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);
  const marketContextAdapter = registry.marketContextFor(command.assetClass);

  // Verified Market Snapshot: equity ticker only (ADR 0019); joins the parallel batch
  const isEquityTicker = command.jobType === "ticker" && command.assetClass === "equity";

  // Market updates and ticker runs sequence market first so current ranked movers or resolved
  // Instrument identity can steer news selection.
  // Research runs resolve registry-based relevance targets without waiting on market data.
  // Other run types keep the parallel source collection path.
  const shouldCollectMarketBeforeNews =
    isMarketUpdateCommand(command) || command.jobType === "ticker";
  const marketResult = shouldCollectMarketBeforeNews ? await marketAdapter.collect(ctx) : undefined;
  const preliminaryIdentityResult =
    isEquityTicker && marketResult !== undefined
      ? deriveCanonicalInstrumentIdentity(marketResult.marketSnapshots, command.symbol)
      : undefined;
  let newsContext: CollectContext = ctx;
  if (marketResult !== undefined) {
    const targets = isMarketUpdateCommand(command)
      ? moverNewsRelevanceTargets(command, sourceOptions, marketResult.marketSnapshots)
      : tickerNewsRelevanceTargets(command, preliminaryIdentityResult?.identity?.displayName);
    newsContext = contextWithNewsRelevanceTargets(ctx, targets);
  } else if (command.jobType === "research") {
    newsContext = contextWithNewsRelevanceTargets(ctx, researchNewsRelevanceTargets(command));
  }
  const [
    resolvedMarketResult,
    newsResult,
    extendedResult,
    marketContextResult,
    verifiedSnapshotResult,
  ] = await Promise.all([
    marketResult ?? marketAdapter.collect(ctx),
    newsAdapter.collect(newsContext),
    extendedEvidenceAdapter.collect(ctx),
    marketContextAdapter.collect(ctx),
    isEquityTicker
      ? collectVerifiedMarketSnapshot(ctx, command.symbol, ctx.fetchedAt.slice(0, 10))
      : undefined,
  ]);
  const supplementalMarketResults = await Promise.all(
    supplementalMarketAdapters.map((adapter) =>
      adapter.collect(ctx, resolvedMarketResult.marketSnapshots),
    ),
  );
  const supplementalMarketSnapshots = supplementalMarketResults.flatMap(
    (result) => result.supplementalMarketSnapshots,
  );

  // Canonical identity is a pure selection from the already-fetched ticker quote
  const identityResult =
    preliminaryIdentityResult ??
    (isEquityTicker
      ? deriveCanonicalInstrumentIdentity(resolvedMarketResult.marketSnapshots, command.symbol)
      : undefined);
  const valuationResult = addValuationEvidence(
    command,
    resolvedMarketResult.marketSnapshots,
    extendedResult.extendedEvidence,
  );

  // Earnings Setup: equity ticker deep only — parse Finnhub calendar for a
  // Near upcoming event, then compute deterministic implied move from Tradier.
  let earningsSetup: EarningsSetupCollected | undefined = undefined;
  const earningsExtraSources: Source[] = [];
  if (isEquityTicker && command.depth === "deep") {
    const earningsCalendarSnapshot = extendedResult.rawSnapshots.find(
      (snapshot) => snapshot.adapter === "finnhub-events-1",
    );
    if (earningsCalendarSnapshot !== undefined) {
      const earningsSourceId = `extended-finnhub-events-${command.symbol.toLowerCase()}`;
      const event = parseNearEarningsEvent(
        earningsCalendarSnapshot.payload,
        command.symbol,
        earningsCalendarSnapshot.fetchedAt,
        earningsSourceId,
      );
      if (event !== undefined) {
        const tickerSnapshot = resolvedMarketResult.marketSnapshots.find(
          (snapshot) => snapshot.symbol === command.symbol,
        );
        const spot = tickerSnapshot?.price;
        const earningsGaps: string[] = [];
        const earningsSourceGaps: SourceGap[] = [];

        if (spot !== undefined && spot > 0) {
          const moveResult = await computeImpliedMove(ctx, event, spot);
          earningsSetup = {
            event,
            ...(moveResult.impliedMove !== undefined
              ? { impliedMove: moveResult.impliedMove }
              : {}),
            gaps: moveResult.gaps.map((gap) => gap.message),
          };
          // Register a citeable Source for the implied move to avoid orphaned IDs.
          const impliedMoveSource = buildImpliedMoveSource(command, moveResult.impliedMove);
          earningsExtraSources.push(
            ...(impliedMoveSource !== undefined ? [impliedMoveSource] : []),
          );
          earningsSourceGaps.push(...moveResult.gaps);
        } else {
          earningsGaps.push("Spot price unavailable; implied move could not be computed");
          earningsSetup = { event, gaps: earningsGaps };
        }
        // Push earnings source gaps into the main gap array below.
        earningsSourceGaps.forEach((gap) => staleFallbackGaps.push(gap));
      }
    }
  }

  return {
    rawSnapshots: [
      ...resolvedMarketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...extendedResult.rawSnapshots,
      ...marketContextResult.rawSnapshots,
      ...supplementalMarketResults.flatMap((result) => result.rawSnapshots),
      ...(verifiedSnapshotResult?.rawSnapshot !== undefined
        ? [verifiedSnapshotResult.rawSnapshot]
        : []),
    ],
    marketSnapshots: resolvedMarketResult.marketSnapshots,
    supplementalMarketSnapshots,
    newsSources: newsResult.newsSources,
    extendedSources: [...extendedResult.sources, ...earningsExtraSources],
    ...(valuationResult.extendedEvidence !== undefined
      ? { extendedEvidence: valuationResult.extendedEvidence }
      : {}),
    ...(marketContextResult.marketContext !== undefined
      ? { marketContext: marketContextResult.marketContext }
      : {}),
    marketContextSources: marketContextResult.sources,
    ...(newsResult.newsAnalytics !== undefined ? { newsAnalytics: newsResult.newsAnalytics } : {}),
    ...(verifiedSnapshotResult?.snapshot !== undefined
      ? { verifiedMarketSnapshot: verifiedSnapshotResult.snapshot }
      : {}),
    ...(identityResult?.identity !== undefined
      ? { resolvedInstrumentIdentity: identityResult.identity }
      : {}),
    ...(earningsSetup !== undefined ? { earningsSetup } : {}),
    sourceGaps: [
      ...resolvedMarketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...extendedResult.sourceGaps,
      ...valuationResult.sourceGaps,
      ...marketContextResult.sourceGaps,
      ...supplementalMarketResults.flatMap((result) => result.sourceGaps),
      ...(verifiedSnapshotResult?.sourceGaps ?? []),
      ...(identityResult?.gap !== undefined ? [identityResult.gap] : []),
      ...staleFallbackGaps,
    ],
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
