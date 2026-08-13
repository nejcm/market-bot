// Source request execution: per-host resilience (serialized queues, minimum delay, circuit
// Breaker), capped response reads, retry/gap handling, response caching, and the
// CollectContext/SourceRequestExecutor factories built on top. Sits below the source
// Registry so adapters and the collector can depend on it without import cycles.
import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { SourceGap, SourceGapAttemptFailure, SourceGapAttempts } from "../domain/types";
import { fetchFailureSourceGap } from "../domain/source-gaps";
import { progressDetail } from "../progress";
import { withCache, type CacheOptions } from "./cache";
import {
  classifyTransientFailure,
  DEFAULT_RETRY_DELAYS_MS,
  isTransientError,
  sleep,
} from "./retry-utils";
import type {
  CollectContext,
  FetchJsonRequestFn,
  FetchJsonResult,
  FetchLike,
  FetchTextRequestFn,
  FetchTextResult,
  RawSourceSnapshot,
  SourceRequest,
  SourceRequestExecutor,
} from "./types";

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
// Global default response-byte ceiling, applied to every adapter unless a `SourceRequest`
// Supplies its own `maxResponseBytes` (see `SourceRequest.maxResponseBytes`). Do not relax this
// Default for a specific adapter's needs — pass a scoped `maxResponseBytes` on that adapter's
// Request instead (see `SEC_FILING_TEXT_MAX_RESPONSE_BYTES` for the one adapter that needs it).
export const DEFAULT_MAX_SOURCE_RESPONSE_BYTES = 5_000_000;
// Scoped ceiling for the `sec-filing-text` adapter only. MSFT's FY2026 10-K decompresses to
// 8.6M bytes; 16M gives ~2x headroom while bounding the transient memory a single filing fetch
// Can hold (chunk copy + decode), since `collectSecFilingEvidence` fans out 10-K/10-Q/8-K/6-K
// Fetches concurrently with no shared memory budget across them. Section-selective retrieval (a
// Smaller per-request fix) is not available: SEC serves one monolithic primary document with no
// Per-section endpoint, and a byte Range has no relation to section boundaries (see the A2
// Remediation plan).
export const SEC_FILING_TEXT_MAX_RESPONSE_BYTES = 16_000_000;
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
  maxResponseBytes: number,
  chunks: Uint8Array[] = [],
  total = 0,
): Promise<{ readonly chunks: readonly Uint8Array[]; readonly total: number }> {
  const { done, value } = await reader.read();
  if (done) {
    return { chunks, total };
  }
  const nextTotal = total + value.byteLength;
  if (nextTotal > maxResponseBytes) {
    throw new Error(`${adapter} source response exceeded ${String(maxResponseBytes)} bytes`);
  }
  chunks.push(value);
  return readCappedChunks(reader, adapter, maxResponseBytes, chunks, nextTotal);
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

async function readCappedResponseText(
  response: Response,
  adapter: string,
  maxResponseBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxResponseBytes) {
    throw new Error(`${adapter} source response exceeded ${String(maxResponseBytes)} bytes`);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
      throw new Error(`${adapter} source response exceeded ${String(maxResponseBytes)} bytes`);
    }
    return text;
  }

  const { chunks, total } = await readCappedChunks(reader, adapter, maxResponseBytes);
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
    async (response) =>
      JSON.parse(
        await readCappedResponseText(response, adapter, DEFAULT_MAX_SOURCE_RESPONSE_BYTES),
      ) as unknown,
    init,
  );
}

async function fetchText(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  maxResponseBytes: number,
  init: RequestInit = {},
): Promise<FetchTextResult> {
  return fetchPayload(
    url,
    adapter,
    fetchedAt,
    timeoutMs,
    fetchImpl,
    "text/html, text/plain;q=0.9, */*;q=0.1",
    async (response) => readCappedResponseText(response, adapter, maxResponseBytes),
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

// Mutable per-call accumulator threaded through the retry recursion below. Not part of any
// Public API: `fetchJsonOrGap`/`fetchTextOrGap` create one, read it after the retry chain
// Settles, and use it to attach `SourceGap.attempts` telemetry (attempt count, elapsed time,
// Per-attempt failure classification) without changing retry count, delays, or the thrown
// Error's identity/message.
interface RetryAttemptState {
  readonly failures: SourceGapAttemptFailure[];
  readonly startedAt: number;
}

function newRetryAttemptState(): RetryAttemptState {
  return { failures: [], startedAt: performance.now() };
}

function recordRetryAttemptFailure(state: RetryAttemptState, error: unknown): void {
  state.failures.push({
    // 1-based attempt number: this is the (failures.length + 1)-th time the retry loop
    // Tried something, whether or not the attempt actually reached the network (a
    // "Circuit-open" classification means it did not — see `SourceGapAttemptClassification`).
    attempt: state.failures.length + 1,
    classification: classifyTransientFailure(error),
    message: error instanceof Error ? error.message : "source request failed",
  });
}

// Only populated once at least one retry actually happened. A single failed attempt with no
// Retry (the overwhelming majority of fetch-failure gaps today) carries no new information
// Here, so it stays silent and every existing single-attempt gap is unchanged.
function retryAttemptsTelemetry(state: RetryAttemptState): SourceGapAttempts | undefined {
  return state.failures.length > 1
    ? {
        count: state.failures.length,
        elapsedMs: Math.round(performance.now() - state.startedAt),
        failures: state.failures,
      }
    : undefined;
}

async function fetchJsonWithRetry(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  remainingDelays: readonly number[],
  attemptState: RetryAttemptState,
  init?: RequestInit,
): Promise<FetchJsonResult> {
  try {
    return await fetchJson(url, adapter, fetchedAt, timeoutMs, fetchImpl, init);
  } catch (error: unknown) {
    recordRetryAttemptFailure(attemptState, error);
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
      attemptState,
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
  maxResponseBytes: number,
  remainingDelays: readonly number[],
  attemptState: RetryAttemptState,
  init?: RequestInit,
): Promise<FetchTextResult> {
  try {
    return await fetchText(url, adapter, fetchedAt, timeoutMs, fetchImpl, maxResponseBytes, init);
  } catch (error: unknown) {
    recordRetryAttemptFailure(attemptState, error);
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
      maxResponseBytes,
      remainingDelays.slice(1),
      attemptState,
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
  const attemptState = newRetryAttemptState();
  try {
    return await fetchJsonWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      retryDelaysMs,
      attemptState,
      init,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "source request failed";
    return fetchFailureSourceGap(
      adapter,
      message,
      error instanceof SourceCircuitOpenError ? "circuit-open" : "fetch-failed",
      retryAttemptsTelemetry(attemptState),
    );
  }
}

async function fetchTextOrGap(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  maxResponseBytes: number,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  init?: RequestInit,
): Promise<FetchTextResult | SourceGap> {
  const attemptState = newRetryAttemptState();
  try {
    return await fetchTextWithRetry(
      url,
      adapter,
      fetchedAt,
      timeoutMs,
      fetchImpl,
      maxResponseBytes,
      retryDelaysMs,
      attemptState,
      init,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "source request failed";
    return fetchFailureSourceGap(
      adapter,
      message,
      error instanceof SourceCircuitOpenError ? "circuit-open" : "fetch-failed",
      retryAttemptsTelemetry(attemptState),
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
  const json: FetchJsonRequestFn = (request: SourceRequest) => {
    progressDetail(`fetch ${request.adapter} ${request.url}`);
    return fetchJsonOrGap(
      request.url,
      request.adapter,
      options.fetchedAt,
      options.sourceTimeoutMs,
      request.fetch?.(options.fetchImpl) ?? options.fetchImpl,
      options.retryDelaysMs,
      request.init,
    );
  };
  const text: FetchTextRequestFn = (request: SourceRequest) => {
    progressDetail(`fetch ${request.adapter} ${request.url}`);
    return fetchTextOrGap(
      request.url,
      request.adapter,
      options.fetchedAt,
      options.sourceTimeoutMs,
      request.fetch?.(options.fetchImpl) ?? options.fetchImpl,
      request.maxResponseBytes ?? DEFAULT_MAX_SOURCE_RESPONSE_BYTES,
      options.retryDelaysMs,
      request.init,
    );
  };

  if (options.cacheOptions === undefined) {
    return { json, text };
  }

  return {
    json: cachedJsonFetch(json, options.cacheOptions),
    text: cachedTextFetch(text, options.cacheOptions),
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
