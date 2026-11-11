import type { SourceAdapter } from "./adapter-freshness";
import { isInstrumentCommand } from "../cli/job-registry";
import { type InstrumentIdentity } from "../domain/instrument";
import { isMarketUpdateJobType, type AssetClass } from "../domain/job-type";
import {
  type MarketBenchmark,
  type MarketFundamentals,
  type MarketSnapshot,
} from "../domain/market-data";
import { type SourceGap } from "../domain/sources";
import { EQUITY_REGIME_SYMBOLS, isEquityRegimeSymbol } from "../domain/regime-symbols";
import { exchangeProfileFor } from "../domain/exchange-profile";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import { dedupeMoversBySymbol } from "../movers/dedupe";
import { cleanResearchProxySymbol } from "../domain/research-subject";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type FetchLike,
  type MarketCollectionResult,
  type MarketDataAdapter,
  type SourceRequest,
} from "./types";
import { isRecord, optionalString, readNumber, readString } from "../guards";
import { isUsListing } from "./instrument-capability";
import { fetchMassiveQuoteFallback } from "./massive-fallback";
import { YAHOO_QUOTE_URL, yahooCredentialFetch } from "./yahoo-resilience";

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
  // Capture Yahoo fundamental fields once at the single parse point so downstream
  // Evidence can derive ratios from the normalized snapshot rather than re-reading
  // The raw payload (immune to the Massive quote fallback, which replaces the
  // Yahoo payload with a non-Yahoo shape carrying none of these fields). See ADR 0004.
  const fundamentals = readYahooFundamentals(value);
  const quoteTimeUtc = readYahooQuoteTimeUtc(value);
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
    ...(fundamentals !== undefined ? { fundamentals } : {}),
    observedAt: fetchedAt,
    ...(quoteTimeUtc !== undefined ? { quoteTimeUtc } : {}),
  };
}

// This converts the Yahoo quote's own timestamp into an ISO 8601 UTC string.
// Yahoo regularMarketTime uses epoch seconds, unlike firstTradeDateMilliseconds on the same payload.
// The function returns undefined when the field is absent or is not a finite number.
// The caller then omits the key instead of emitting a null or a fabricated time.
function readYahooQuoteTimeUtc(value: Record<string, unknown>): string | undefined {
  const regularMarketTime = readNumber(value, "regularMarketTime");
  if (regularMarketTime === undefined) {
    return undefined;
  }
  const date = new Date(regularMarketTime * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// Reads the pre-computed fundamental fields the Yahoo quote endpoint carries
// Alongside price/volume. dividendYield is whole-percent (verified against captured
// RR.L/AAPL fixtures); trailingAnnualDividendRate is per share in financialCurrency.
// Returns undefined when no fundamental field is present, so the snapshot omits the
// Key entirely (no fundamentals for Massive fallback / ETF / ADR payloads).
function readYahooFundamentals(value: Record<string, unknown>): MarketFundamentals | undefined {
  const trailingPE = readNumber(value, "trailingPE");
  const forwardPE = readNumber(value, "forwardPE");
  const priceToBook = readNumber(value, "priceToBook");
  const bookValue = readNumber(value, "bookValue");
  const dividendYield = readNumber(value, "dividendYield");
  const epsTrailingTwelveMonths = readNumber(value, "epsTrailingTwelveMonths");
  const epsForward = readNumber(value, "epsForward");
  const sharesOutstanding = readNumber(value, "sharesOutstanding");
  const trailingAnnualDividendRate = readNumber(value, "trailingAnnualDividendRate");
  const financialCurrency = readString(value, "financialCurrency");
  const fundamentals: MarketFundamentals = {
    ...(trailingPE !== undefined ? { trailingPE } : {}),
    ...(forwardPE !== undefined ? { forwardPE } : {}),
    ...(priceToBook !== undefined ? { priceToBook } : {}),
    ...(bookValue !== undefined ? { bookValue } : {}),
    ...(dividendYield !== undefined ? { dividendYield } : {}),
    ...(epsTrailingTwelveMonths !== undefined ? { epsTrailingTwelveMonths } : {}),
    ...(epsForward !== undefined ? { epsForward } : {}),
    ...(sharesOutstanding !== undefined ? { sharesOutstanding } : {}),
    ...(trailingAnnualDividendRate !== undefined ? { trailingAnnualDividendRate } : {}),
  };
  if (Object.keys(fundamentals).length === 0) {
    return undefined;
  }
  return financialCurrency === undefined ? fundamentals : { ...fundamentals, financialCurrency };
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
  adapter: SourceAdapter,
): SourceRequest {
  return {
    url: yahooQuoteUrl(symbols.join(",")),
    adapter,
    fetch: yahooResilientFetchWrapper,
  };
}

type EquityRole =
  | "gainers"
  | "losers"
  | "actives"
  | "regime"
  | "ticker"
  | "research-proxy"
  | "research-snapshots";

function isMoverRole(role: EquityRole): boolean {
  return role === "gainers" || role === "losers" || role === "actives";
}

function equityRoleAdapter(role: EquityRole): SourceAdapter {
  if (role === "regime") {
    return "yahoo-regime";
  }
  if (role === "ticker") {
    return "yahoo-ticker";
  }
  if (role === "research-proxy") {
    return "yahoo-research-proxy";
  }
  if (role === "research-snapshots") {
    return "yahoo-research-snapshots";
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

function researchSnapshotSymbols(ctx: CollectContext): readonly string[] {
  const proxy =
    ctx.command.jobType === "research"
      ? cleanResearchProxySymbol(ctx.command.predictionProxySymbol)
      : undefined;
  return [
    ...new Set(
      [proxy, ...(ctx.requiredMarketSnapshotSymbols ?? [])].filter(
        (symbol): symbol is string => symbol !== undefined && symbol !== "",
      ),
    ),
  ];
}

function equityRequestsFor(
  ctx: CollectContext,
): readonly { readonly role: EquityRole; readonly url: string }[] {
  const { command } = ctx;
  if (isInstrumentCommand(command)) {
    const localBenchmark = exchangeProfileFor(command.symbol)?.benchmark;
    return [
      { role: "ticker", url: yahooQuoteUrl(command.symbol ?? "") },
      {
        role: "regime",
        url: yahooQuoteUrl(localBenchmark ?? EQUITY_REGIME_SYMBOLS.join(",")),
      },
    ];
  }

  if ((ctx.requiredMarketSnapshotSymbols?.length ?? 0) > 0) {
    const researchSymbols = researchSnapshotSymbols(ctx);
    return [
      { role: "research-snapshots", url: yahooQuoteUrl(researchSymbols.join(",")) },
      { role: "regime", url: yahooQuoteUrl(EQUITY_REGIME_SYMBOLS.join(",")) },
    ];
  }
  const researchProxy =
    command.jobType === "research"
      ? cleanResearchProxySymbol(command.predictionProxySymbol)
      : undefined;
  if (researchProxy !== undefined) {
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

export async function requestJsonWithQuoteFallback(
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

  const symbols = symbolsFromQuoteUrl(request.url).filter((symbol) => isUsListing(symbol));
  if (symbols.length === 0) {
    return result;
  }

  const fallback = await fetchMassiveQuoteFallback(
    symbols,
    ctx.massiveApiKey,
    ctx.request.fetch,
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

function researchSnapshotGap(symbol: string, cause: SourceGap["cause"], detail: string): SourceGap {
  return sourceGap({
    source: `yahoo-research-snapshot-${symbol.toLowerCase()}`,
    message: `Yahoo market snapshot unavailable for ${symbol}: ${detail}`,
    provider: "yahoo",
    capability: "market-data",
    ...(cause !== undefined ? { cause } : {}),
    evidenceQualityImpact: "no-cap",
  });
}

async function collectEquity(ctx: CollectContext): Promise<MarketCollectionResult> {
  const { command } = ctx;
  const requests = equityRequestsFor(ctx);

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
  const sourceGaps = results.flatMap(({ role, result }): readonly SourceGap[] => {
    if (role !== "research-snapshots") {
      return isFetchJsonResult(result) ? [] : [result];
    }
    const expectedSymbols = researchSnapshotSymbols(ctx);
    if (!isFetchJsonResult(result)) {
      return expectedSymbols.map((symbol) =>
        researchSnapshotGap(symbol, result.cause, result.message),
      );
    }
    const collectedSymbols = new Set(
      normalizeYahooQuotePayload(result.payload, "equity", result.rawSnapshot.fetchedAt).map(
        (snapshot) => snapshot.symbol.trim().toUpperCase(),
      ),
    );
    return expectedSymbols
      .filter((symbol) => !collectedSymbols.has(symbol))
      .map((symbol) =>
        researchSnapshotGap(symbol, "provider-data-missing", "provider response omitted symbol"),
      );
  });

  const isMarketUpdate = isMarketUpdateJobType(command.jobType);
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
