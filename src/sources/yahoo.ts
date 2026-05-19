import type { AssetClass, MarketSnapshot } from "../domain/types";
import type { MarketDataAdapter } from "./types";
import { isRecord, optionalString, readNumber, readString } from "./guards";

function readYahooResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.quoteResponse)) {
    return [];
  }

  return Array.isArray(payload.quoteResponse.result) ? payload.quoteResponse.result : [];
}

function normalizeYahooQuote(
  value: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): MarketSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = readString(value, "symbol")?.trim().toUpperCase();
  const price = readNumber(value, "regularMarketPrice");
  const changePercent24h = readNumber(value, "regularMarketChangePercent");
  const volume = readNumber(value, "regularMarketVolume");

  if (
    symbol === undefined ||
    price === undefined ||
    changePercent24h === undefined ||
    volume === undefined
  ) {
    return undefined;
  }

  const name = optionalString(value, "shortName") ?? optionalString(value, "longName");
  const marketCap = readNumber(value, "marketCap");

  return {
    sourceId: `market-yahoo-${assetClass}-${symbol.toLowerCase()}`,
    assetClass,
    symbol,
    ...(name !== undefined ? { name } : {}),
    price,
    changePercent24h,
    volume,
    ...(marketCap !== undefined ? { marketCap } : {}),
    observedAt: fetchedAt,
  };
}

export function normalizeYahooQuotePayload(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly MarketSnapshot[] {
  return readYahooResults(payload)
    .map((value) => normalizeYahooQuote(value, assetClass, fetchedAt))
    .filter((snapshot): snapshot is MarketSnapshot => snapshot !== undefined);
}

export const yahooMarketDataAdapter: MarketDataAdapter = {
  name: "yahoo",
  assetClass: "equity",
  normalizeMarkets: (payload, fetchedAt) =>
    normalizeYahooQuotePayload(payload, "equity", fetchedAt),
};

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

function yahooChartCloseUrl(symbol: string, date: Date): string {
  const start = Math.floor(date.getTime() / 1000);
  const end = start + 86_400;
  const params = new URLSearchParams({
    period1: String(start),
    period2: String(end),
    interval: "1d",
    events: "history",
  });
  return `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?${params.toString()}`;
}

function extractCloseFromChartPayload(payload: unknown): number | undefined {
  if (!isRecord(payload) || !isRecord(payload.chart)) {
    return undefined;
  }
  const { result } = payload.chart as Record<string, unknown>;
  if (!Array.isArray(result) || result.length === 0) {
    return undefined;
  }
  const [first] = result;
  if (!isRecord(first) || !isRecord(first.indicators)) {
    return undefined;
  }
  const { quote } = first.indicators as Record<string, unknown>;
  if (!Array.isArray(quote) || quote.length === 0) {
    return undefined;
  }
  const [firstQuote] = quote;
  if (!isRecord(firstQuote)) {
    return undefined;
  }
  const closes = firstQuote.close;
  if (!Array.isArray(closes) || closes.length === 0) {
    return undefined;
  }
  const last = closes.at(-1);
  return typeof last === "number" ? last : undefined;
}

export async function fetchYahooClose(
  symbol: string,
  date: Date,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(yahooChartCloseUrl(symbol, date), {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as unknown;
    return extractCloseFromChartPayload(payload);
  } catch {
    return undefined;
  }
}
