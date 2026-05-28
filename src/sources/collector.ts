import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { ExtendedEvidence, MarketSnapshot, Source, SourceGap } from "../domain/types";
import { withCache, type CacheOptions, type FetchOrGapFn } from "./cache";
import type { FetchJsonResult, FetchLike, RawSourceSnapshot } from "./types";
import { createSourceRegistry } from "./registry";

export interface SourceCollection {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly extendedSources: readonly Source[];
  readonly extendedEvidence?: ExtendedEvidence;
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

async function fetchJson(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<FetchJsonResult> {
  return runWithHostResilience(url, adapter, async () => {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": "market-bot/0.1 research-cli",
      },
    });

    if (!response.ok) {
      throw new Error(`${adapter} source request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as unknown;

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
): Promise<FetchJsonResult> {
  try {
    return await fetchJson(url, adapter, fetchedAt, timeoutMs, fetchImpl);
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
): Promise<FetchJsonResult | SourceGap> {
  try {
    return await fetchJsonWithRetry(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "source request failed";
    return { source: adapter, message };
  }
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

  const registry = createSourceRegistry();
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const extendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);

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
    ...(sourceOptions.secUserAgent !== undefined
      ? { secUserAgent: sourceOptions.secUserAgent }
      : {}),
    fetchImpl,
    fetchOrGap,
    retryDelaysMs,
  };

  const [marketResult, newsResult, extendedResult] = await Promise.all([
    marketAdapter.collect(ctx),
    newsAdapter.collect(ctx),
    extendedEvidenceAdapter.collect(ctx),
  ]);

  return {
    rawSnapshots: [
      ...marketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...extendedResult.rawSnapshots,
    ],
    marketSnapshots: marketResult.marketSnapshots,
    newsSources: newsResult.newsSources,
    extendedSources: extendedResult.sources,
    ...(extendedResult.extendedEvidence !== undefined
      ? { extendedEvidence: extendedResult.extendedEvidence }
      : {}),
    sourceGaps: [
      ...marketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...extendedResult.sourceGaps,
      ...staleFallbackGaps,
    ],
  };
}
