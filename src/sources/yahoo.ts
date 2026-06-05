import type {
  AssetClass,
  InstrumentIdentity,
  MarketBenchmark,
  MarketSnapshot,
  SourceGap,
} from "../domain/types";
import { EQUITY_REGIME_SYMBOLS, isEquityRegimeSymbol } from "../domain/regime-symbols";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import type { Observation } from "../forecast/observable";
import { dedupeMoversBySymbol } from "../movers/dedupe";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type FetchLike,
  type MarketCollectionResult,
  type MarketDataAdapter,
  type SourceRequest,
} from "./types";
import { isRecord, optionalString, readNumber, readString } from "./guards";

function readYahooResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.quoteResponse)) {
    return [];
  }

  return Array.isArray(payload.quoteResponse.result) ? payload.quoteResponse.result : [];
}

function readYahooScreenerQuoteValues(payload: unknown): readonly unknown[] {
  if (typeof payload !== "object" || payload === null || !("finance" in payload)) {
    return [];
  }

  const { finance } = payload as {
    finance?: { result?: readonly { quotes?: readonly unknown[] }[] };
  };
  return finance?.result?.[0]?.quotes ?? [];
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
  const open = readNumber(value, "regularMarketOpen");
  const previousClose = readNumber(value, "regularMarketPreviousClose");
  const averageVolume =
    readNumber(value, "averageDailyVolume10Day") ??
    readNumber(value, "averageDailyVolume3Month") ??
    readNumber(value, "averageVolume");
  const fiftyDayAverage = readNumber(value, "fiftyDayAverage");
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
    ...(open !== undefined ? { open } : {}),
    ...(previousClose !== undefined ? { previousClose } : {}),
    ...(averageVolume !== undefined ? { averageVolume } : {}),
    ...(fiftyDayAverage !== undefined ? { fiftyDayAverage } : {}),
    observedAt: fetchedAt,
  };
}

interface EquityMoverSnapshot {
  readonly snapshot: MarketSnapshot;
  readonly sector?: string;
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

function normalizeYahooMoverQuoteValues(
  values: readonly unknown[],
  fetchedAt: string,
): readonly EquityMoverSnapshot[] {
  return values
    .map((value): EquityMoverSnapshot | undefined => {
      const snapshot = normalizeYahooQuote(value, "equity", fetchedAt);
      if (snapshot === undefined || !isRecord(value)) {
        return undefined;
      }
      const sector = optionalString(value, "sector");
      return {
        snapshot,
        ...(sector !== undefined ? { sector } : {}),
      };
    })
    .filter((snapshot): snapshot is EquityMoverSnapshot => snapshot !== undefined);
}

const EQUITY_DAILY_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50";
const EQUITY_DAILY_LOSERS_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_losers&count=50";
const EQUITY_MOST_ACTIVES_URL =
  "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=50";
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const BROAD_EQUITY_BENCHMARK = "SPY";
const SECTOR_BENCHMARKS: Readonly<Record<string, string>> = {
  "Basic Materials": "XLB",
  "Communication Services": "XLC",
  "Consumer Cyclical": "XLY",
  "Consumer Defensive": "XLP",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  Energy: "XLE",
  Financial: "XLF",
  "Financial Services": "XLF",
  Healthcare: "XLV",
  Industrials: "XLI",
  "Real Estate": "XLRE",
  Technology: "XLK",
  Utilities: "XLU",
};

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function yahooQuoteUrl(symbols: string): string {
  return `${YAHOO_QUOTE_URL}?${encodeQuery({ symbols })}`;
}

export function yahooQuoteSourceRequest(
  symbols: readonly string[],
  adapter: string,
): SourceRequest {
  return {
    url: yahooQuoteUrl(symbols.join(",")),
    adapter,
    fetch: (baseFetch) => (request, init) => yahooCredentialFetch(request, init, baseFetch),
  };
}

type EquityRole = "gainers" | "losers" | "actives" | "regime";

function isMoverRole(role: EquityRole): boolean {
  return role === "gainers" || role === "losers" || role === "actives";
}

interface BenchmarkSelection {
  readonly symbol: string;
  readonly basis: MarketBenchmark["basis"];
  readonly sector?: string;
}

function benchmarkSelectionForSector(sector: string | undefined): BenchmarkSelection {
  const benchmark = sector !== undefined ? SECTOR_BENCHMARKS[sector] : undefined;
  return {
    symbol: benchmark ?? BROAD_EQUITY_BENCHMARK,
    basis: benchmark !== undefined ? "sector-etf" : "broad-index",
    ...(sector !== undefined ? { sector } : {}),
  };
}

function benchmarkSourceId(symbol: string): string {
  return `market-yahoo-equity-${symbol.toLowerCase()}`;
}

function benchmarkFromSnapshot(
  snapshot: MarketSnapshot,
  selection: BenchmarkSelection,
): MarketBenchmark {
  return {
    sourceId: benchmarkSourceId(snapshot.symbol),
    symbol: snapshot.symbol,
    ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
    basis: selection.basis,
    ...(selection.sector !== undefined ? { sector: selection.sector } : {}),
    changePercent24h: snapshot.changePercent24h,
    observedAt: snapshot.observedAt,
  };
}

async function enrichMoverBenchmarks(
  ctx: CollectContext,
  movers: readonly EquityMoverSnapshot[],
): Promise<{
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly rawSnapshots: readonly FetchJsonResult["rawSnapshot"][];
  readonly sourceGaps: readonly SourceGap[];
}> {
  if (movers.length === 0) {
    return { marketSnapshots: [], rawSnapshots: [], sourceGaps: [] };
  }

  const selections = new Map(
    movers.flatMap((mover) => {
      const selection = benchmarkSelectionForSector(mover.sector);
      return selection.symbol === mover.snapshot.symbol ? [] : [[mover.snapshot.symbol, selection]];
    }),
  );
  const benchmarkSymbols = [...new Set([...selections.values()].map((item) => item.symbol))];
  if (benchmarkSymbols.length === 0) {
    return {
      marketSnapshots: movers.map((mover) => mover.snapshot),
      rawSnapshots: [],
      sourceGaps: [],
    };
  }
  const fetched = await ctx.request.json({
    url: yahooQuoteUrl(benchmarkSymbols.join(",")),
    adapter: "yahoo-benchmarks",
    fetch: (baseFetch) => (request, init) => yahooCredentialFetch(request, init, baseFetch),
  });

  if (!isFetchJsonResult(fetched)) {
    return {
      marketSnapshots: movers.map((mover) => mover.snapshot),
      rawSnapshots: [],
      sourceGaps: [
        sourceGapWithContext(fetched, {
          capability: "market-data",
          evidenceQualityImpact: "no-cap",
        }),
      ],
    };
  }

  const benchmarks = new Map(
    normalizeYahooQuotePayload(fetched.payload, "equity", fetched.rawSnapshot.fetchedAt).map(
      (snapshot) => [snapshot.symbol, snapshot],
    ),
  );
  const missing = benchmarkSymbols
    .filter((symbol) => !benchmarks.has(symbol))
    .map((symbol) =>
      sourceGap({
        source: "yahoo-benchmarks",
        message: `Yahoo benchmark quote missing for ${symbol}`,
        provider: "yahoo",
        capability: "market-data",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      }),
    );
  const marketSnapshots = movers.map((mover) => {
    const selection = selections.get(mover.snapshot.symbol);
    const benchmark = selection !== undefined ? benchmarks.get(selection.symbol) : undefined;
    return selection !== undefined && benchmark !== undefined
      ? { ...mover.snapshot, benchmark: benchmarkFromSnapshot(benchmark, selection) }
      : mover.snapshot;
  });

  return {
    marketSnapshots,
    rawSnapshots: [fetched.rawSnapshot],
    sourceGaps: missing,
  };
}

interface YahooCredentials {
  readonly cookie: string;
  readonly crumb: string;
}

let yahooCredentialsPromise: Promise<YahooCredentials> | null = null;

function cookiePairs(headers: Headers): readonly string[] {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = headersWithSetCookie.getSetCookie?.() ?? [];
  const fallback = headers.get("set-cookie");
  const setCookies = values.length > 0 ? values : [];
  const rawCookies = setCookies.length > 0 || fallback === null ? setCookies : [fallback];
  return rawCookies
    .map((value) => value.split(";")[0])
    .filter((value): value is string => value !== undefined && value.includes("="));
}

function headersWith(init: RequestInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

async function yahooCredentials(
  fetchImpl: FetchLike,
  init: RequestInit | undefined,
): Promise<YahooCredentials> {
  if (yahooCredentialsPromise !== null) {
    return yahooCredentialsPromise;
  }

  yahooCredentialsPromise = (async () => {
    const credentialInit = {
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      headers: headersWith(undefined, { "user-agent": "Mozilla/5.0 market-bot" }),
    };
    const cookieResponse = await fetchImpl("https://fc.yahoo.com", {
      ...credentialInit,
    });
    const cookie = cookiePairs(cookieResponse.headers).join("; ");
    const crumbInit = {
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      headers: headersWith(
        undefined,
        cookie !== ""
          ? { cookie, "user-agent": "Mozilla/5.0 market-bot" }
          : { "user-agent": "Mozilla/5.0 market-bot" },
      ),
    };
    const crumbResponse = await fetchImpl("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      ...crumbInit,
    });
    if (!crumbResponse.ok) {
      throw new Error(`Yahoo crumb request failed with status ${crumbResponse.status}`);
    }
    const crumb = await crumbResponse.text();
    return { cookie, crumb: crumb.trim() };
  })();

  return yahooCredentialsPromise;
}

function quoteUrlWithCrumb(url: string, crumb: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("crumb", crumb);
  return parsed.toString();
}

async function yahooCredentialFetch(
  input: string | URL | Request,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = String(input);
  const response = await fetchImpl(input, init);
  if (!url.startsWith(YAHOO_QUOTE_URL) || response.status !== 401) {
    return response;
  }

  try {
    const credentials = await yahooCredentials(fetchImpl, init);
    const retry = await fetchImpl(quoteUrlWithCrumb(url, credentials.crumb), {
      ...init,
      headers: headersWith(init, credentials.cookie !== "" ? { cookie: credentials.cookie } : {}),
    });
    if (retry.status === 401) {
      yahooCredentialsPromise = null;
    }
    return retry;
  } catch {
    yahooCredentialsPromise = null;
    return response;
  }
}

async function collectEquity(ctx: CollectContext): Promise<MarketCollectionResult> {
  const { command } = ctx;

  const requests: readonly { readonly role: EquityRole; readonly url: string }[] =
    command.jobType === "ticker"
      ? [{ role: "regime", url: yahooQuoteUrl(command.symbol ?? "") }]
      : [
          { role: "gainers", url: EQUITY_DAILY_URL },
          { role: "losers", url: EQUITY_DAILY_LOSERS_URL },
          { role: "actives", url: EQUITY_MOST_ACTIVES_URL },
          { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS.join(",")) },
        ];

  const results = await Promise.all(
    requests.map(async (req) => ({
      role: req.role,
      result: await ctx.request.json({
        url: req.url,
        adapter: req.role === "regime" ? "yahoo-regime" : `yahoo-${req.role}`,
        fetch: (baseFetch) => (request, init) => yahooCredentialFetch(request, init, baseFetch),
      }),
    })),
  );

  const fetched = results.filter((e): e is { role: EquityRole; result: FetchJsonResult } =>
    isFetchJsonResult(e.result),
  );
  const sourceGaps = results
    .map((e) => e.result)
    .filter((r): r is SourceGap => !isFetchJsonResult(r));

  const isMarketUpdate = command.jobType === "daily" || command.jobType === "weekly";
  const moverResults = fetched.filter((e) => isMarketUpdate && isMoverRole(e.role));
  const regimeSnapshots = fetched.flatMap((e) =>
    isMarketUpdate && isMoverRole(e.role)
      ? []
      : normalizeYahooQuotePayload(e.result.payload, "equity", e.result.rawSnapshot.fetchedAt),
  );
  const moverSnapshots = dedupeMoversBySymbol(
    moverResults.flatMap((e) =>
      normalizeYahooMoverQuoteValues(
        readYahooScreenerQuoteValues(e.result.payload),
        e.result.rawSnapshot.fetchedAt,
      ).filter((mover) => !isEquityRegimeSymbol(mover.snapshot.symbol)),
    ),
  );
  const benchmarkResult = isMarketUpdate
    ? await enrichMoverBenchmarks(ctx, moverSnapshots)
    : { marketSnapshots: [], rawSnapshots: [], sourceGaps: [] };

  return {
    rawSnapshots: [...fetched.map((e) => e.result.rawSnapshot), ...benchmarkResult.rawSnapshots],
    marketSnapshots: [...benchmarkResult.marketSnapshots, ...regimeSnapshots],
    sourceGaps: [...sourceGaps, ...benchmarkResult.sourceGaps],
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
