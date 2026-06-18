import type {
  AssetClass,
  InstrumentIdentity,
  MarketBenchmark,
  MarketSnapshot,
  OhlcvBar,
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
import { fetchMassiveCloseWindow, fetchMassiveQuoteFallback } from "./massive-fallback";
import {
  fetchYahooJsonWithResilience,
  YAHOO_QUOTE_URL,
  yahooCredentialFetch,
} from "./yahoo-resilience";

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

export function yahooResilientFetchWrapper(baseFetch: FetchLike): FetchLike {
  return (request, init) => yahooCredentialFetch(request, init, baseFetch);
}

export function yahooQuoteSourceRequest(
  symbols: readonly string[],
  adapter: string,
): SourceRequest {
  return {
    url: yahooQuoteUrl(symbols.join(",")),
    adapter,
    fetch: yahooResilientFetchWrapper,
  };
}

type EquityRole = "gainers" | "losers" | "actives" | "regime" | "ticker" | "research-proxy";

function isMoverRole(role: EquityRole): boolean {
  return role === "gainers" || role === "losers" || role === "actives";
}

function equityRoleAdapter(role: EquityRole): string {
  if (role === "regime") {
    return "yahoo-regime";
  }
  if (role === "ticker") {
    return "yahoo-ticker";
  }
  if (role === "research-proxy") {
    return "yahoo-research-proxy";
  }
  return `yahoo-${role}`;
}

function usesQuoteFallback(role: EquityRole): boolean {
  return role === "regime" || role === "ticker" || role === "research-proxy";
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

function equityRequestsFor(
  command: CollectContext["command"],
): readonly { readonly role: EquityRole; readonly url: string }[] {
  if (command.jobType === "ticker") {
    return [
      { role: "ticker", url: yahooQuoteUrl(command.symbol ?? "") },
      { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS.join(",")) },
    ];
  }

  const researchProxy =
    command.jobType === "research"
      ? command.predictionProxySymbol?.trim().toUpperCase()
      : undefined;
  if (researchProxy !== undefined && researchProxy !== "") {
    return [
      { role: "research-proxy", url: yahooQuoteUrl(researchProxy) },
      { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS.join(",")) },
    ];
  }

  return [
    { role: "gainers", url: EQUITY_DAILY_URL },
    { role: "losers", url: EQUITY_DAILY_LOSERS_URL },
    { role: "actives", url: EQUITY_MOST_ACTIVES_URL },
    { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS.join(",")) },
  ];
}

function symbolsFromQuoteUrl(url: string): readonly string[] {
  try {
    const symbols = new URL(url).searchParams.get("symbols");
    if (symbols === null || symbols.trim() === "") {
      return [];
    }
    return symbols
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function requestJsonWithQuoteFallback(
  ctx: CollectContext,
  request: SourceRequest,
): Promise<FetchJsonResult | SourceGap> {
  const result = await ctx.request.json({
    ...request,
    fetch: request.fetch ?? yahooResilientFetchWrapper,
  });
  if (isFetchJsonResult(result)) {
    return result;
  }

  const symbols = symbolsFromQuoteUrl(request.url);
  if (symbols.length === 0) {
    return result;
  }

  const fallback = await fetchMassiveQuoteFallback(
    symbols,
    ctx.massiveApiKey,
    fetch,
    ctx.fetchedAt,
  );
  if (fallback === undefined) {
    return result;
  }

  return {
    rawSnapshot: {
      id: `raw-${request.adapter}-massive-fallback-${ctx.fetchedAt}`,
      adapter: request.adapter,
      fetchedAt: ctx.fetchedAt,
      payload: fallback.payload,
    },
    payload: fallback.payload,
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

  const fetched = await requestJsonWithQuoteFallback(ctx, {
    url: yahooQuoteUrl(benchmarkSymbols.join(",")),
    adapter: "yahoo-benchmarks",
    fetch: yahooResilientFetchWrapper,
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

async function collectEquity(ctx: CollectContext): Promise<MarketCollectionResult> {
  const { command } = ctx;
  const requests = equityRequestsFor(command);

  const results = await Promise.all(
    requests.map(async (req) => {
      const request: SourceRequest = {
        url: req.url,
        adapter: equityRoleAdapter(req.role),
        fetch: yahooResilientFetchWrapper,
      };
      const result = usesQuoteFallback(req.role)
        ? await requestJsonWithQuoteFallback(ctx, request)
        : await ctx.request.json(request);
      return { role: req.role, result };
    }),
  );

  const fetched = results.filter((e): e is { role: EquityRole; result: FetchJsonResult } =>
    isFetchJsonResult(e.result),
  );
  const sourceGaps = results
    .map((e) => e.result)
    .filter((r): r is SourceGap => !isFetchJsonResult(r));

  const isMarketUpdate =
    command.jobType === "market-overview" ||
    command.jobType === "daily" ||
    command.jobType === "weekly";
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

export function yahooChartWindowUrl(symbol: string, from: Date, to: Date): string {
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

interface YahooChartQuote {
  readonly timestamps: readonly unknown[];
  readonly quote: Record<string, unknown>;
}

// Unwrap chart.result[0].timestamp + indicators.quote[0] from a Yahoo chart payload.
function readYahooChartQuote(payload: unknown): YahooChartQuote | undefined {
  if (!isRecord(payload) || !isRecord(payload.chart)) {
    return undefined;
  }
  const result = Array.isArray(payload.chart.result) ? payload.chart.result[0] : undefined;
  if (!isRecord(result) || !Array.isArray(result.timestamp) || !isRecord(result.indicators)) {
    return undefined;
  }
  const quote = Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : undefined;
  if (!isRecord(quote)) {
    return undefined;
  }
  return { timestamps: result.timestamp, quote };
}

function observationsFromYahooChartPayload(
  symbol: string,
  payload: unknown,
): readonly Observation[] {
  const chart = readYahooChartQuote(payload);
  if (chart === undefined) {
    return [];
  }
  const closes: readonly unknown[] = Array.isArray(chart.quote.close) ? chart.quote.close : [];
  return chart.timestamps.flatMap((timestamp, index) => {
    const date = dateFromUnixSeconds(timestamp);
    const value = closes[index];
    return date !== undefined && typeof value === "number"
      ? [{ subject: symbol, date, value }]
      : [];
  });
}

// Parse full OHLCV daily bars from a Yahoo chart API payload.
// Skips bars with any null OHLCV slot (Yahoo halts / sparse names).
// Filters to bars with date <= analysisDate when provided.
// Returns bars sorted oldest -> newest.
export function parseYahooChartOhlcv(payload: unknown, analysisDate?: string): readonly OhlcvBar[] {
  const chart = readYahooChartQuote(payload);
  if (chart === undefined) {
    return [];
  }
  const { timestamps, quote } = chart;
  const opens: readonly unknown[] = Array.isArray(quote.open) ? quote.open : [];
  const highs: readonly unknown[] = Array.isArray(quote.high) ? quote.high : [];
  const lows: readonly unknown[] = Array.isArray(quote.low) ? quote.low : [];
  const closes: readonly unknown[] = Array.isArray(quote.close) ? quote.close : [];
  const volumes: readonly unknown[] = Array.isArray(quote.volume) ? quote.volume : [];

  const bars: OhlcvBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const date = dateFromUnixSeconds(timestamps[i]);
    if (date === undefined) {
      continue;
    }
    if (analysisDate !== undefined && date > analysisDate) {
      continue;
    }
    const rawOpen = opens[i];
    const rawHigh = highs[i];
    const rawLow = lows[i];
    const rawClose = closes[i];
    const rawVolume = volumes[i];
    if (
      typeof rawOpen !== "number" ||
      typeof rawHigh !== "number" ||
      typeof rawLow !== "number" ||
      typeof rawClose !== "number" ||
      typeof rawVolume !== "number"
    ) {
      // Yahoo emits null slots on halts; skip to keep arrays aligned
      continue;
    }
    bars.push({
      date,
      open: rawOpen,
      high: rawHigh,
      low: rawLow,
      close: rawClose,
      volume: rawVolume,
    });
  }
  return bars;
}

export async function fetchYahooCloseWindow(
  symbol: string,
  from: Date,
  to: Date,
  fetchImpl: FetchLike = fetch,
  massiveApiKey?: string,
): Promise<readonly Observation[]> {
  const url = yahooChartWindowUrl(symbol, from, to);
  const fetched = await fetchYahooJsonWithResilience(url, fetchImpl, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
  });

  if (fetched.ok) {
    const observations = observationsFromYahooChartPayload(symbol, fetched.payload);
    if (observations.length > 0) {
      return observations;
    }
  }

  const massiveObservations = await fetchMassiveCloseWindow(
    symbol,
    from,
    to,
    massiveApiKey,
    fetchImpl,
  );
  return massiveObservations ?? [];
}

export { yahooCredentialFetch, createYahooResilientFetch } from "./yahoo-resilience";
