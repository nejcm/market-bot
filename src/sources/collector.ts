import type { ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import { isMarketUpdateJobType } from "../domain/types";
import type { MarketSnapshot, Source, SourceGap } from "../domain/types";
import { normalizeNewsPayload } from "./news";
import type { RawSourceSnapshot } from "./types";
import { createSourceRegistry } from "./registry";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SourceCollection {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

interface FetchJsonResult {
  readonly rawSnapshot: RawSourceSnapshot;
  readonly payload: unknown;
}

interface MarketCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
}

interface NewsCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

type EquityDailyRole = "movers" | "regime";

interface EquityFetchResult {
  readonly role: EquityDailyRole;
  readonly result: FetchJsonResult | SourceGap;
}

const EQUITY_DAILY_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";
const EQUITY_REGIME_SYMBOLS = "SPY,QQQ,IWM,DIA,^VIX";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
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
    const status = /status (\d+)/.exec(error.message)?.[1];
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
    const nextDelay = remainingDelays[0];
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

function isFetchJsonResult(value: FetchJsonResult | SourceGap): value is FetchJsonResult {
  return "rawSnapshot" in value;
}

function readYahooScreenerQuotes(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("finance" in payload)) {
    return { quoteResponse: { result: [] } };
  }

  const { finance } = payload as {
    finance?: { result?: readonly { quotes?: readonly unknown[] }[] };
  };
  const quotes = finance?.result?.[0]?.quotes ?? [];

  return {
    quoteResponse: {
      result: quotes,
    },
  };
}

function coinGeckoUrl(perPage: number): string {
  return `${COINGECKO_MARKETS_URL}?${encodeQuery({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: String(perPage),
    page: "1",
    sparkline: "false",
    price_change_percentage: "24h",
  })}`;
}

function yahooQuoteUrl(symbols: string): string {
  return `${YAHOO_QUOTE_URL}?${encodeQuery({ symbols })}`;
}

function yahooNewsQuery(command: ResearchCommand): string {
  if (command.jobType === "ticker") {
    return command.symbol;
  }

  return command.assetClass === "equity" ? "stock market" : "crypto market";
}

function yahooNewsUrl(command: ResearchCommand, limit: number): string {
  return `${YAHOO_SEARCH_URL}?${encodeQuery({ q: yahooNewsQuery(command), newsCount: String(limit) })}`;
}

function normalizeYahooNewsPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("news" in payload)) {
    return { articles: [] };
  }

  const news = (payload as { news?: readonly Record<string, unknown>[] }).news ?? [];
  const articles = news.map((item) => {
    const providerPublishTime =
      typeof item.providerPublishTime === "number"
        ? new Date(item.providerPublishTime * 1000).toISOString()
        : undefined;

    return {
      title: item.title,
      url: item.link,
      source: {
        name: item.publisher,
      },
      publishedAt: providerPublishTime,
    };
  });

  return {
    articles,
  };
}

function filterTickerSnapshots(
  command: ResearchCommand,
  snapshots: readonly MarketSnapshot[],
): readonly MarketSnapshot[] {
  if (command.jobType === "ticker") {
    return snapshots.filter((snapshot) => snapshot.symbol === command.symbol);
  }

  return snapshots;
}

function cryptoFetchLimit(command: ResearchCommand, sourceOptions: SourceOptions): number {
  if (isMarketUpdateJobType(command.jobType)) {
    return Math.max(sourceOptions.cryptoMoverLimit * 10, 50);
  }

  return 250;
}

async function collectMarketData(
  command: ResearchCommand,
  fetchedAt: string,
  sourceOptions: SourceOptions,
  fetchImpl: FetchLike,
  retryDelaysMs: readonly number[],
): Promise<MarketCollectionResult> {
  const registry = createSourceRegistry();
  const adapter = registry.marketDataFor(command.assetClass);

  if (command.assetClass === "equity") {
    const requests: readonly { readonly role: EquityDailyRole; readonly url: string }[] =
      command.jobType === "ticker"
        ? [{ role: "regime", url: yahooQuoteUrl(command.symbol) }]
        : [
            { role: "movers", url: EQUITY_DAILY_URL },
            { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS) },
          ];
    const results: readonly EquityFetchResult[] = await Promise.all(
      requests.map(async (request) => ({
        role: request.role,
        result: await fetchJsonOrGap(
          request.url,
          `${adapter.name}-${request.role}`,
          fetchedAt,
          sourceOptions.sourceTimeoutMs,
          fetchImpl,
          retryDelaysMs,
        ),
      })),
    );
    const fetchedResults = results.filter(
      (entry): entry is EquityFetchResult & { readonly result: FetchJsonResult } =>
        isFetchJsonResult(entry.result),
    );
    const sourceGaps = results
      .map((entry) => entry.result)
      .filter((result): result is SourceGap => !isFetchJsonResult(result));
    const snapshots = fetchedResults.flatMap((entry) => {
      const payload =
        isMarketUpdateJobType(command.jobType) && entry.role === "movers"
          ? readYahooScreenerQuotes(entry.result.payload)
          : entry.result.payload;

      return adapter.normalizeMarkets(payload, fetchedAt);
    });

    return {
      rawSnapshots: fetchedResults.map((entry) => entry.result.rawSnapshot),
      marketSnapshots: snapshots,
      sourceGaps,
    };
  }

  const fetched = await fetchJsonOrGap(
    coinGeckoUrl(cryptoFetchLimit(command, sourceOptions)),
    adapter.name,
    fetchedAt,
    sourceOptions.sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
  );

  if (!isFetchJsonResult(fetched)) {
    return {
      rawSnapshots: [],
      marketSnapshots: [],
      sourceGaps: [fetched],
    };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    marketSnapshots: filterTickerSnapshots(
      command,
      adapter.normalizeMarkets(fetched.payload, fetchedAt),
    ),
    sourceGaps: [],
  };
}

async function collectNewsData(
  command: ResearchCommand,
  fetchedAt: string,
  sourceOptions: SourceOptions,
  fetchImpl: FetchLike,
  retryDelaysMs: readonly number[],
): Promise<NewsCollectionResult> {
  const adapter = createSourceRegistry().newsFor(command.assetClass);
  const fetched = await fetchJsonOrGap(
    yahooNewsUrl(command, sourceOptions.newsLimit),
    adapter.name,
    fetchedAt,
    sourceOptions.sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
  );

  if (!isFetchJsonResult(fetched)) {
    return {
      rawSnapshots: [],
      newsSources: [],
      sourceGaps: [fetched],
    };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    newsSources: normalizeNewsPayload(
      normalizeYahooNewsPayload(fetched.payload),
      command.assetClass,
      fetchedAt,
    ),
    sourceGaps: [],
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
  const [marketData, newsData] = await Promise.all([
    collectMarketData(command, fetchedAt, sourceOptions, fetchImpl, retryDelaysMs),
    collectNewsData(command, fetchedAt, sourceOptions, fetchImpl, retryDelaysMs),
  ]);

  return {
    rawSnapshots: [...marketData.rawSnapshots, ...newsData.rawSnapshots],
    marketSnapshots: marketData.marketSnapshots,
    newsSources: newsData.newsSources,
    sourceGaps: [...marketData.sourceGaps, ...newsData.sourceGaps],
  };
}
