import { SEC_TICKERS_URL } from "../config/shared";
import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import {
  findSecTicker,
  secRequestInit,
  summarizeSecFundamentals,
} from "../sources/extended-evidence/sec-edgar";
import {
  isFetchJsonResult,
  type RawSourceSnapshot,
  type SourceRequestExecutor,
} from "../sources/types";
import type { AlphaSearchLead } from "./report-extras";

export interface AlphaSearchFundamentals {
  readonly symbol: string;
  readonly secCik: string;
  readonly sourceIds: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

export interface AlphaSearchFundamentalsResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly fundamentals: readonly AlphaSearchFundamentals[];
  readonly sourceGaps: readonly SourceGap[];
}

function factsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
}

function sourceId(symbol: string): string {
  return `alpha-sec-fundamentals-${symbol.toLowerCase()}`;
}

function noSecMappingGap(symbol: string): SourceGap {
  return sourceGap({
    source: "sec-alpha-fundamentals",
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "no-cap",
    message: `No SEC CIK match for alpha-search candidate ${symbol}`,
  });
}

function noFundamentalsGap(symbol: string): SourceGap {
  return sourceGap({
    source: "sec-alpha-fundamentals",
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
    message: `No SEC company facts found for alpha-search candidate ${symbol}`,
  });
}

export async function collectAlphaSearchFundamentals(options: {
  readonly leads: readonly AlphaSearchLead[];
  readonly request: SourceRequestExecutor;
  readonly analysisAsOf: string;
  readonly secUserAgent?: string;
}): Promise<AlphaSearchFundamentalsResult> {
  const symbols = [...new Set(options.leads.map((lead) => lead.symbol))].toSorted();
  if (symbols.length === 0) {
    return { rawSnapshots: [], fundamentals: [], sourceGaps: [] };
  }

  const secInit = secRequestInit(options.secUserAgent);
  const tickers = await options.request.json({
    url: SEC_TICKERS_URL,
    adapter: "sec-alpha-fundamentals-tickers",
    init: secInit,
  });
  if (!isFetchJsonResult(tickers)) {
    return { rawSnapshots: [], fundamentals: [], sourceGaps: [tickers] };
  }

  const rawSnapshots: RawSourceSnapshot[] = [tickers.rawSnapshot];
  const mapped = symbols.flatMap((symbol) => {
    const match = findSecTicker(tickers.payload, symbol);
    return match === undefined
      ? []
      : [{ symbol, cik: match.cik, url: factsUrl(match.cik), sourceId: sourceId(symbol) }];
  });
  const missingMappingGaps = symbols.flatMap((symbol) =>
    mapped.some((entry) => entry.symbol === symbol) ? [] : [noSecMappingGap(symbol)],
  );

  const facts = await Promise.all(
    mapped.map(async (entry) => ({
      entry,
      result: await options.request.json({
        url: entry.url,
        adapter: "sec-alpha-fundamentals-companyfacts",
        init: secInit,
      }),
    })),
  );

  const fetchGaps: SourceGap[] = [];
  const missingFactsGaps: SourceGap[] = [];
  const fundamentalGaps: SourceGap[] = [];
  const fundamentals: AlphaSearchFundamentals[] = [];
  for (const { entry, result } of facts) {
    if (!isFetchJsonResult(result)) {
      fetchGaps.push({ ...result, symbol: entry.symbol });
      continue;
    }
    rawSnapshots.push(result.rawSnapshot);
    const summary = summarizeSecFundamentals(result.payload, options.analysisAsOf);
    if (summary === undefined) {
      missingFactsGaps.push(noFundamentalsGap(entry.symbol));
      continue;
    }
    fundamentalGaps.push(...summary.gaps.map((gap) => ({ ...gap, symbol: entry.symbol })));
    fundamentals.push({
      symbol: entry.symbol,
      secCik: entry.cik,
      sourceIds: [entry.sourceId],
      metrics: numericMetrics(summary.metrics),
    });
  }

  return {
    rawSnapshots,
    fundamentals,
    sourceGaps: [...missingMappingGaps, ...fetchGaps, ...missingFactsGaps, ...fundamentalGaps],
  };
}

function numericMetrics(
  metrics: Readonly<Record<string, number | string>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(metrics).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}
