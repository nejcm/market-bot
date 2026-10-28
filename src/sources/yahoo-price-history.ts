import {
  verifiedMarketSnapshotFromChart,
  type VerifiedSnapshotResult,
} from "./verified-market-snapshot";
import { sourceGapWithContext } from "../domain/source-gaps";
import type { Source, SourceGap } from "../domain/sources";
import { isRecord, readString } from "../guards";
import type { MetricContext } from "./extended-evidence/metric-engine";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "./types";
import {
  classifyLatestSession,
  readYahooRegularSession,
  splitAdjustedObservationsFromYahooChart,
  yahooChartSplitDates,
  yahooScoringWindowUrl,
  yahooResilientFetchWrapper,
} from "./yahoo";

const LOOKBACK_YEARS = 5;
const ANNIVERSARY_MARGIN_DAYS = 14;
const OPTIONAL_BENCHMARK_TIMEOUT_MS = 3000;

export async function collectPriceHistory(
  ctx: CollectContext,
  symbol: string,
  // Relative Predictions cite SPY or QQQ; any other benchmark keeps the declared forecast-baseline gap.
  relativeBenchmarks: readonly string[] = ["QQQ"],
): Promise<{
  readonly priceHistory: NonNullable<MetricContext["priceHistory"]>;
  readonly verifiedSnapshot: VerifiedSnapshotResult;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}> {
  const to = new Date(ctx.fetchedAt.slice(0, 10));
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - LOOKBACK_YEARS);
  from.setUTCDate(from.getUTCDate() - ANNIVERSARY_MARGIN_DAYS);
  const collectTicker = async (ticker: string, optional = false) => {
    const url = yahooScoringWindowUrl(ticker, from, to);
    const fetched = await ctx.request.json({
      url,
      adapter: "yahoo-price-history",
      fetch: yahooResilientFetchWrapper,
      ...(optional ? { timeoutMs: OPTIONAL_BENCHMARK_TIMEOUT_MS, retryDelaysMs: [] } : {}),
    });
    const sourceId = `price-history-${ticker}`;
    if (!isFetchJsonResult(fetched)) {
      const benchmark = ticker !== symbol.toUpperCase();
      const gap = sourceGapWithContext(
        {
          ...fetched,
          source: "yahoo-price-history",
          symbol: ticker,
          message: benchmark ? `${ticker}: ${fetched.message}` : fetched.message,
        },
        {
          provider: "yahoo",
          capability: "market-data",
          evidenceQualityImpact: benchmark ? "no-cap" : "core-cap",
        },
      );
      return {
        sourceGaps: benchmark ? [gap] : [],
        verifiedSnapshot: {
          sourceGaps: benchmark ? [] : [gap],
        },
        history: {
          symbol: ticker,
          sourceId,
          priceMode: "split-adjusted-close" as const,
          bars: [],
          reason: fetched.message,
        },
      };
    }
    const schedule = readYahooRegularSession(fetched.payload);
    const adjusted = splitAdjustedObservationsFromYahooChart(ticker, fetched.payload);
    const bars = adjusted
      .filter(
        ({ date }) =>
          date <= to.toISOString().slice(0, 10) &&
          classifyLatestSession(schedule, date, fetched.rawSnapshot.fetchedAt).status ===
            "complete",
      )
      .map(({ date, value }) => ({ date, close: value, completed: true }));
    const splitDates = yahooChartSplitDates(fetched.payload);
    const chart =
      isRecord(fetched.payload) && isRecord(fetched.payload.chart)
        ? fetched.payload.chart
        : undefined;
    const result =
      Array.isArray(chart?.result) && isRecord(chart.result[0]) ? chart.result[0] : undefined;
    const currency = isRecord(result?.meta) ? readString(result.meta, "currency") : undefined;
    const returnedSymbol = isRecord(result?.meta) ? readString(result.meta, "symbol") : undefined;
    const mismatch = returnedSymbol !== undefined && returnedSymbol.toUpperCase() !== ticker;
    let reason: string | undefined = undefined;
    if (mismatch) {
      reason = `Yahoo returned ${returnedSymbol} for ${ticker}`;
    } else if (adjusted.length === 0) {
      reason =
        Array.isArray(result?.timestamp) && result.timestamp.length > 0
          ? "split-adjusted history unavailable: invalid closes or split metadata"
          : "price history unavailable: no rows returned";
    }
    return {
      verifiedSnapshot: mismatch
        ? {
            sourceGaps: [
              sourceGapWithContext(
                {
                  source: fetched.rawSnapshot.adapter,
                  symbol: ticker,
                  message: `Yahoo returned ${returnedSymbol} for ${ticker}`,
                },
                {
                  provider: "yahoo",
                  capability: "market-data",
                  cause: "validation-failed",
                  evidenceQualityImpact: "core-cap",
                },
              ),
            ],
          }
        : verifiedMarketSnapshotFromChart(fetched, ticker, to.toISOString().slice(0, 10)),
      history: {
        symbol: ticker,
        sourceId,
        priceMode: "split-adjusted-close" as const,
        requestedFrom: from.toISOString().slice(0, 10),
        bars: mismatch ? [] : bars,
        ...(mismatch || splitDates === undefined ? {} : { splitDates }),
        ...(reason === undefined ? {} : { reason }),
        ...(currency === undefined ? {} : { currency }),
      },
      rawSnapshot: { ...fetched.rawSnapshot, id: `${fetched.rawSnapshot.id}-${ticker}` },
      source: {
        id: sourceId,
        title: `${ticker} daily price history`,
        url,
        provider: "yahoo",
        fetchedAt: fetched.rawSnapshot.fetchedAt,
        kind: "market-data" as const,
        assetClass: "equity" as const,
        symbol: ticker,
      },
    };
  };
  const coreTickers = [...new Set([symbol.toUpperCase(), "SPY"])];
  const core = await Promise.all(coreTickers.map((ticker) => collectTicker(ticker)));
  // Optional benchmarks wait for issuer and SPY retries, so their failures cannot open the shared Yahoo circuit first.
  const optional = await Promise.all(
    relativeBenchmarks
      .filter((ticker) => !coreTickers.includes(ticker))
      .map((ticker) => collectTicker(ticker, true)),
  );
  const results = [...core, ...optional];
  return {
    priceHistory: results.map(({ history }) => history),
    sourceGaps: results.flatMap((result) => result.sourceGaps ?? []),
    verifiedSnapshot: results[0]!.verifiedSnapshot,
    rawSnapshots: results.flatMap((result) =>
      result.rawSnapshot === undefined ? [] : [result.rawSnapshot],
    ),
    sources: results.flatMap((result) => (result.source === undefined ? [] : [result.source])),
  };
}
