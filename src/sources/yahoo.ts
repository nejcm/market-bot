import type { AssetClass, InstrumentIdentity, MarketSnapshot, SourceGap } from "../domain/types";
import type { Observation } from "../forecast/observable";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type MarketCollectionResult,
  type MarketDataAdapter,
} from "./types";
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
  const exchange = optionalString(value, "fullExchangeName") ?? optionalString(value, "exchange");
  const quoteCurrency = optionalString(value, "currency");
  const identity: InstrumentIdentity = {
    ...(exchange !== undefined ? { exchange } : {}),
    ...(quoteCurrency !== undefined ? { quoteCurrency } : {}),
    ...(name !== undefined ? { displayName: name } : {}),
    aliases: [{ provider: "yahoo", idKind: "symbol", value: symbol }],
  };

  return {
    sourceId: `market-yahoo-${assetClass}-${symbol.toLowerCase()}`,
    assetClass,
    symbol,
    ...(name !== undefined ? { name } : {}),
    identity,
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

const EQUITY_DAILY_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const EQUITY_REGIME_SYMBOLS = "SPY,QQQ,IWM,DIA,^VIX";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function yahooQuoteUrl(symbols: string): string {
  return `${YAHOO_QUOTE_URL}?${encodeQuery({ symbols })}`;
}

function readYahooScreenerQuotes(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("finance" in payload)) {
    return { quoteResponse: { result: [] } };
  }

  const { finance } = payload as {
    finance?: { result?: readonly { quotes?: readonly unknown[] }[] };
  };
  const quotes = finance?.result?.[0]?.quotes ?? [];

  return { quoteResponse: { result: quotes } };
}

type EquityRole = "movers" | "regime";

async function collectEquity(ctx: CollectContext): Promise<MarketCollectionResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;

  const requests: readonly { readonly role: EquityRole; readonly url: string }[] =
    command.jobType === "ticker"
      ? [{ role: "regime", url: yahooQuoteUrl(command.symbol ?? "") }]
      : [
          { role: "movers", url: EQUITY_DAILY_URL },
          { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS) },
        ];

  const results = await Promise.all(
    requests.map(async (req) => ({
      role: req.role,
      result: await fetchOrGap(
        req.url,
        `yahoo-${req.role}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    })),
  );

  const fetched = results.filter((e): e is { role: EquityRole; result: FetchJsonResult } =>
    isFetchJsonResult(e.result),
  );
  const sourceGaps = results
    .map((e) => e.result)
    .filter((r): r is SourceGap => !isFetchJsonResult(r));

  const isMarketUpdate = command.jobType === "daily" || command.jobType === "weekly";
  const snapshots = fetched.flatMap((e) => {
    const payload =
      isMarketUpdate && e.role === "movers"
        ? readYahooScreenerQuotes(e.result.payload)
        : e.result.payload;
    return normalizeYahooQuotePayload(payload, "equity", fetchedAt);
  });

  return {
    rawSnapshots: fetched.map((e) => e.result.rawSnapshot),
    marketSnapshots: snapshots,
    sourceGaps,
  };
}

export const yahooMarketDataAdapter: MarketDataAdapter = {
  name: "yahoo",
  assetClass: "equity",
  normalizeMarkets: (payload, fetchedAt) =>
    normalizeYahooQuotePayload(payload, "equity", fetchedAt),
  collect: collectEquity,
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

function yahooChartWindowUrl(symbol: string, from: Date, to: Date): string {
  const start = Math.floor(from.getTime() / 1000);
  const end = Math.floor(to.getTime() / 1000) + 86_400;
  const params = new URLSearchParams({
    period1: String(start),
    period2: String(end),
    interval: "1d",
    events: "history",
  });
  return `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?${params.toString()}`;
}

function dateFromUnixSeconds(value: unknown): string | undefined {
  return typeof value === "number" ? new Date(value * 1000).toISOString().slice(0, 10) : undefined;
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

export async function fetchYahooCloseWindow(
  symbol: string,
  from: Date,
  to: Date,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<readonly Observation[]> {
  try {
    const response = await fetchImpl(yahooChartWindowUrl(symbol, from, to), {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !isRecord(payload.chart)) {
      return [];
    }
    const result = Array.isArray(payload.chart.result) ? payload.chart.result[0] : undefined;
    if (!isRecord(result) || !Array.isArray(result.timestamp) || !isRecord(result.indicators)) {
      return [];
    }
    const quote = Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : undefined;
    const closes = isRecord(quote) && Array.isArray(quote.close) ? quote.close : [];
    return result.timestamp.flatMap((timestamp, index) => {
      const date = dateFromUnixSeconds(timestamp);
      const value = closes[index];
      return date !== undefined && typeof value === "number"
        ? [{ subject: symbol, date, value }]
        : [];
    });
  } catch {
    return [];
  }
}
