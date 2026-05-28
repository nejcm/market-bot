import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { MarketSnapshot, Source, SourceGap } from "../domain/types";
import { withCache, type CacheOptions, type FetchOrGapFn } from "./cache";
import type { FetchJsonResult, FetchLike, RawSourceSnapshot } from "./types";
import { createSourceRegistry } from "./registry";

export interface SourceCollection {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

async function fetchJson(
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<FetchJsonResult> {
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
}

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
    const status = /status (\d+)/u.exec(error.message)?.[1];
    if (status !== undefined) {
      const code = Number(status);
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

  const ctx = {
    command,
    fetchedAt,
    sourceTimeoutMs: sourceOptions.sourceTimeoutMs,
    newsLimit: sourceOptions.newsLimit,
    cryptoMoverLimit: sourceOptions.cryptoMoverLimit,
    fetchImpl,
    fetchOrGap,
    retryDelaysMs,
  };

  const [marketResult, newsResult] = await Promise.all([
    marketAdapter.collect(ctx),
    newsAdapter.collect(ctx),
  ]);

  return {
    rawSnapshots: [...marketResult.rawSnapshots, ...newsResult.rawSnapshots],
    marketSnapshots: marketResult.marketSnapshots,
    newsSources: newsResult.newsSources,
    sourceGaps: [...marketResult.sourceGaps, ...newsResult.sourceGaps, ...staleFallbackGaps],
  };
}
