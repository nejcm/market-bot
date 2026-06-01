import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type {
  ExtendedEvidence,
  MarketContext,
  MarketSnapshot,
  Source,
  SourceGap,
} from "../domain/types";
import { withCache, type CacheOptions, type FetchOrGapFn } from "./cache";
import type {
  FetchJsonResult,
  FetchLike,
  FetchTextOrGapFn,
  FetchTextResult,
  RawSourceSnapshot,
} from "./types";
import { createSourceRegistry } from "./registry";

export interface SourceCollection {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly supplementalMarketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly extendedSources: readonly Source[];
  readonly extendedEvidence?: ExtendedEvidence;
  readonly marketContext?: MarketContext;
  readonly marketContextSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

interface HostState {
  queue: Promise<void>;
  lastStartedAt: number;
  consecutiveFailures: number;
  openedUntil: number;
}

const HOST_MIN_DELAY_MS = 1000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 60_000;
const hostStates = new Map<string, HostState>();

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
      throw new Error(`${adapter} circuit open for ${host}`);
    }

    const waitMs = Math.max(0, HOST_MIN_DELAY_MS - (now - state.lastStartedAt));
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
    async (response) => (await response.json()) as unknown,
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
    async (response) => response.text(),
    init,
  );
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
    const code = statusCode(error);
    if (code !== undefined) {
      return code >= 500 && code < 600;
    }
    if (
      error.message.includes("fetch failed") ||
      error.message.includes("network") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT")
    ) {
      return true;
    }
  }
  return false;
}

export function resetSourceResilienceForTests(): void {
  hostStates.clear();
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 9000];

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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
    return { source: adapter, message };
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
    return { source: adapter, message };
  }
}

function cachedTextFetch(inner: FetchTextOrGapFn, options: CacheOptions): FetchTextOrGapFn {
  const cached = withCache(inner as FetchOrGapFn, options);
  return async (url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs, init) => {
    const result = await cached(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs, init);
    if ("rawSnapshot" in result && typeof result.payload === "string") {
      return result as FetchTextResult;
    }
    if ("rawSnapshot" in result) {
      return { source: adapter, message: "cached text payload was not a string" };
    }
    return result;
  };
}

export async function collectSources(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<SourceCollection> {
  const fetchedAt = now.toISOString();

  const staleFallbackGaps: SourceGap[] = [];
  const { cacheDir } = sourceOptions;
  const fetchOrGap: FetchOrGapFn =
    cacheDir !== undefined
      ? withCache(fetchJsonOrGap, {
          dir: cacheDir,
          disabled: sourceOptions.cacheDisabled ?? false,
          fallbackDays: sourceOptions.cacheFallbackDays ?? 7,
          now: () => now,
          onStaleFallback: (gap) => {
            staleFallbackGaps.push(gap);
          },
        } satisfies CacheOptions)
      : fetchJsonOrGap;
  const fetchTextOrGapCached: FetchTextOrGapFn =
    cacheDir !== undefined
      ? cachedTextFetch(fetchTextOrGap, {
          dir: cacheDir,
          disabled: sourceOptions.cacheDisabled ?? false,
          fallbackDays: sourceOptions.cacheFallbackDays ?? 7,
          now: () => now,
          onStaleFallback: (gap) => {
            staleFallbackGaps.push(gap);
          },
        } satisfies CacheOptions)
      : fetchTextOrGap;

  const registry = createSourceRegistry();
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const supplementalMarketAdapters = registry.supplementalMarketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const extendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);
  const marketContextAdapter = registry.marketContextFor(command.assetClass);

  const ctx = {
    command,
    fetchedAt,
    sourceTimeoutMs: sourceOptions.sourceTimeoutMs,
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
    fetchImpl,
    fetchOrGap,
    fetchTextOrGap: fetchTextOrGapCached,
    retryDelaysMs,
  };

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
