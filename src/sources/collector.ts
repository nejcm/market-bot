import type { CliCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import type { AssetClass, MarketSnapshot, Source } from "../domain/types";
import { normalizeNewsPayload } from "./news";
import type { RawSourceSnapshot } from "./types";
import { createSourceRegistry } from "./registry";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SourceCollection {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
}

interface FetchJsonResult {
  readonly rawSnapshot: RawSourceSnapshot;
  readonly payload: unknown;
}

const EQUITY_DAILY_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function fetchJson(url: string, adapter: string, fetchedAt: string, fetchImpl: FetchLike): Promise<FetchJsonResult> {
  const response = await fetchImpl(url, {
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

function readYahooScreenerQuotes(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("finance" in payload)) {
    return { quoteResponse: { result: [] } };
  }

  const finance = (payload as { finance?: { result?: readonly { quotes?: readonly unknown[] }[] } }).finance;
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

function yahooQuoteUrl(symbol: string): string {
  return `${YAHOO_QUOTE_URL}?${encodeQuery({ symbols: symbol })}`;
}

function yahooNewsQuery(command: CliCommand): string {
  if (command.jobType === "ticker") {
    return command.symbol;
  }

  return command.assetClass === "equity" ? "stock market" : "crypto market";
}

function yahooNewsUrl(command: CliCommand, limit: number): string {
  return `${YAHOO_SEARCH_URL}?${encodeQuery({ q: yahooNewsQuery(command), newsCount: String(limit) })}`;
}

function normalizeYahooNewsPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("news" in payload)) {
    return { articles: [] };
  }

  const news = (payload as { news?: readonly Record<string, unknown>[] }).news ?? [];
  const articles = news.map((item) => {
    const providerPublishTime = typeof item.providerPublishTime === "number" ? new Date(item.providerPublishTime * 1000).toISOString() : undefined;

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

function filterTickerSnapshots(command: CliCommand, snapshots: readonly MarketSnapshot[]): readonly MarketSnapshot[] {
  if (command.jobType === "daily") {
    return snapshots;
  }

  return snapshots.filter((snapshot) => snapshot.symbol === command.symbol);
}

function cryptoFetchLimit(command: CliCommand, sourceOptions: SourceOptions): number {
  if (command.jobType === "daily") {
    return Math.max(sourceOptions.cryptoMoverLimit * 10, 50);
  }

  return 250;
}

async function collectMarketData(
  command: CliCommand,
  fetchedAt: string,
  sourceOptions: SourceOptions,
  fetchImpl: FetchLike,
): Promise<{ readonly rawSnapshots: readonly RawSourceSnapshot[]; readonly marketSnapshots: readonly MarketSnapshot[] }> {
  const registry = createSourceRegistry();
  const adapter = registry.marketDataFor(command.assetClass);

  if (command.assetClass === "equity") {
    const url = command.jobType === "daily" ? EQUITY_DAILY_URL : yahooQuoteUrl(command.symbol);
    const fetched = await fetchJson(url, adapter.name, fetchedAt, fetchImpl);
    const payload = command.jobType === "daily" ? readYahooScreenerQuotes(fetched.payload) : fetched.payload;

    return {
      rawSnapshots: [fetched.rawSnapshot],
      marketSnapshots: adapter.normalizeMarkets(payload, fetchedAt),
    };
  }

  const fetched = await fetchJson(coinGeckoUrl(cryptoFetchLimit(command, sourceOptions)), adapter.name, fetchedAt, fetchImpl);

  return {
    rawSnapshots: [fetched.rawSnapshot],
    marketSnapshots: filterTickerSnapshots(command, adapter.normalizeMarkets(fetched.payload, fetchedAt)),
  };
}

async function collectNewsData(
  command: CliCommand,
  fetchedAt: string,
  sourceOptions: SourceOptions,
  fetchImpl: FetchLike,
): Promise<{ readonly rawSnapshot: RawSourceSnapshot; readonly newsSources: readonly Source[] }> {
  const adapter = createSourceRegistry().newsFor(command.assetClass);
  const fetched = await fetchJson(yahooNewsUrl(command, sourceOptions.newsLimit), adapter.name, fetchedAt, fetchImpl);

  return {
    rawSnapshot: fetched.rawSnapshot,
    newsSources: normalizeNewsPayload(normalizeYahooNewsPayload(fetched.payload), command.assetClass, fetchedAt),
  };
}

export async function collectSources(
  command: CliCommand,
  sourceOptions: SourceOptions,
  now: Date = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<SourceCollection> {
  const fetchedAt = now.toISOString();
  const [marketData, newsData] = await Promise.all([
    collectMarketData(command, fetchedAt, sourceOptions, fetchImpl),
    collectNewsData(command, fetchedAt, sourceOptions, fetchImpl),
  ]);

  return {
    rawSnapshots: [...marketData.rawSnapshots, newsData.rawSnapshot],
    marketSnapshots: marketData.marketSnapshots,
    newsSources: newsData.newsSources,
  };
}
