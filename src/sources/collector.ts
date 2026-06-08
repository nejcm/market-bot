import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { SourceGap } from "../domain/types";
import { fetchFailureSourceGap } from "../domain/source-gaps";
import { withCache, type CacheOptions } from "./cache";
import type {
  CollectContext,
  CollectedSources,
  FetchJsonRequestFn,
  FetchJsonResult,
  FetchLike,
  FetchTextRequestFn,
  FetchTextResult,
  RawSourceSnapshot,
  SourceRequest,
  SourceRequestExecutor,
} from "./types";
import { createSourceRegistry } from "./registry";
import { DEFAULT_RETRY_DELAYS_MS, isTransientError, sleep } from "./retry-utils";

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

  const [marketResult, newsResult, extendedResult, marketContextResult] = await Promise.all([
    marketAdapter.collect(ctx),
    newsAdapter.collect(ctx),
    extendedEvidenceAdapter.collect(ctx),
    marketContextAdapter.collect(ctx),
  ]);
  const supplementalMarketResults = await Promise.all(
    supplementalMarketAdapters.map((adapter) => adapter.collect(ctx, marketResult.marketSnapshots)),
  );
  const supplementalMarketSnapshots = supplementalMarketResults.flatMap(
    (result) => result.supplementalMarketSnapshots,
  );

  return {
    rawSnapshots: [
      ...marketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...extendedResult.rawSnapshots,
      ...marketContextResult.rawSnapshots,
      ...supplementalMarketResults.flatMap((result) => result.rawSnapshots),
    ],
    marketSnapshots: marketResult.marketSnapshots,
    supplementalMarketSnapshots,
    newsSources: newsResult.newsSources,
    extendedSources: extendedResult.sources,
    ...(extendedResult.extendedEvidence !== undefined
      ? { extendedEvidence: extendedResult.extendedEvidence }
      : {}),
    ...(marketContextResult.marketContext !== undefined
      ? { marketContext: marketContextResult.marketContext }
      : {}),
    marketContextSources: marketContextResult.sources,
    ...(newsResult.newsAnalytics !== undefined ? { newsAnalytics: newsResult.newsAnalytics } : {}),
    sourceGaps: [
      ...marketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...extendedResult.sourceGaps,
      ...marketContextResult.sourceGaps,
      ...supplementalMarketResults.flatMap((result) => result.sourceGaps),
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
