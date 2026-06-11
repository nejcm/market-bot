/**
 * Verified Market Snapshot collector (ADR 0019).
 *
 * Fetches ≥400 calendar days of daily OHLCV bars for an equity ticker via
 * ctx.request.json (cache + rate-limit + circuit-breaker), computes canonical
 * technical indicators, and returns a VerifiedMarketSnapshot or a SourceGap.
 *
 * Strict fetch discipline:
 * - MUST go through ctx.request.json (collector seam) with adapter
 *   "yahoo-verified-chart" and yahooResilientFetchWrapper.
 * - MUST NOT call fetchYahooCloseWindow or fetchYahooJsonWithResilience directly.
 * - On failure → SourceGap with evidenceQualityImpact "core-cap", no Massive fallback.
 */

import type { OhlcvBar, SourceGap, VerifiedMarketSnapshot } from "../domain/types";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "./types";
import { parseYahooChartOhlcv, yahooChartWindowUrl, yahooResilientFetchWrapper } from "./yahoo";
import { computeIndicators, MIN_BARS_FOR_SNAPSHOT } from "./indicators";

/** Lookback: at least 400 calendar days (~275 trading sessions) for SMA200 warmup. */
const CHART_LOOKBACK_CALENDAR_DAYS = 400;

/** Adapter ID — visible in health traces and cache keys. */
const ADAPTER_ID = "yahoo-verified-chart";

/** Number of recent closes to include in the compact prompt payload. */
const RECENT_CLOSES_COUNT = 30;

// Single construction point for the citeable report Source ID. Used by the
// Report source list, the evidence payload, and (later) Phase A.2 verification.
export function verifiedSnapshotSourceId(symbol: string): string {
  return `verified-snapshot-${symbol}`;
}

export interface VerifiedSnapshotResult {
  readonly snapshot?: VerifiedMarketSnapshot;
  readonly rawSnapshot?: RawSourceSnapshot;
  readonly sourceGaps: readonly SourceGap[];
}

// Collect a Verified Market Snapshot for an equity ticker.
// Ctx: collect context (cache, request executor, fetchedAt).
// Symbol: ticker symbol (must be non-empty).
// AnalysisDate: YYYY-MM-DD cutoff date (bars after this are excluded).
export async function collectVerifiedMarketSnapshot(
  ctx: CollectContext,
  symbol: string,
  analysisDate: string,
): Promise<VerifiedSnapshotResult> {
  if (symbol === "") {
    // Never fetch a chart for an empty symbol; no gap — nothing to ground
    return { sourceGaps: [] };
  }

  const to = new Date(analysisDate);
  const from = new Date(to);
  from.setDate(from.getDate() - CHART_LOOKBACK_CALENDAR_DAYS);

  const url = yahooChartWindowUrl(symbol, from, to);

  const fetched = await ctx.request.json({
    url,
    adapter: ADAPTER_ID,
    fetch: yahooResilientFetchWrapper,
  });

  if (!isFetchJsonResult(fetched)) {
    // Preserve the executor's gap cause (fetch-failed / circuit-open / ...) for analytics
    return {
      sourceGaps: [
        sourceGapWithContext(fetched, {
          provider: "yahoo",
          capability: "market-data",
          evidenceQualityImpact: "core-cap",
        }),
      ],
    };
  }

  const bars = parseYahooChartOhlcv(fetched.payload, analysisDate);

  if (bars.length < MIN_BARS_FOR_SNAPSHOT) {
    return {
      rawSnapshot: fetched.rawSnapshot,
      sourceGaps: [
        sourceGap({
          source: ADAPTER_ID,
          message: `insufficient OHLCV bars for ${symbol}: got ${String(bars.length)}, need ≥${String(MIN_BARS_FOR_SNAPSHOT)}`,
          provider: "yahoo",
          capability: "market-data",
          cause: "validation-failed",
          evidenceQualityImpact: "core-cap",
        }),
      ],
    };
  }

  const indicators = computeIndicators(bars);
  const latestBar = bars.at(-1) as OhlcvBar;
  const recentCloses = buildRecentCloses(bars, RECENT_CLOSES_COUNT);

  const snapshot: VerifiedMarketSnapshot = {
    symbol,
    assetClass: "equity",
    analysisDate,
    fetchedAt: ctx.fetchedAt,
    latestSessionDate: latestBar.date,
    ohlcv: latestBar,
    indicators,
    recentCloses,
  };

  return {
    snapshot,
    rawSnapshot: fetched.rawSnapshot,
    sourceGaps: [],
  };
}

function buildRecentCloses(
  bars: readonly OhlcvBar[],
  count: number,
): readonly { readonly date: string; readonly close: number }[] {
  return bars.slice(-count).map((b) => ({ date: b.date, close: b.close }));
}
