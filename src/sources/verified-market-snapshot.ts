// Standalone snapshots request yahoo-verified-chart; equity ticker runs reuse yahoo-price-history.

import type { OhlcvBar, VerifiedMarketSnapshot } from "../domain/market-data";
import type { SourceGap } from "../domain/sources";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import {
  isFetchJsonResult,
  type CollectContext,
  type RawSourceSnapshot,
  type FetchJsonResult,
} from "./types";
import {
  classifyLatestSession,
  parseYahooChartOhlcv,
  readYahooRegularSession,
  yahooChartWindowUrl,
  yahooResilientFetchWrapper,
  type LatestSessionVerdict,
} from "./yahoo";
import { computeIndicators, MIN_BARS_FOR_SNAPSHOT } from "./indicators";

/** Lookback: at least 400 calendar days (~275 trading sessions) for SMA200 warmup. */
const CHART_LOOKBACK_CALENDAR_DAYS = 400;

/** Adapter ID — visible in health traces and cache keys. */
const ADAPTER_ID = "yahoo-verified-chart";

/** Number of recent closes to include in the compact prompt payload. */
const RECENT_CLOSES_COUNT = 30;

export function verifiedMarketSnapshotSourceId(symbol: string): string {
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

  return verifiedMarketSnapshotFromChart(fetched, symbol, analysisDate);
}

export function verifiedMarketSnapshotFromChart(
  fetched: FetchJsonResult,
  symbol: string,
  analysisDate: string,
): VerifiedSnapshotResult {
  const parsed = parseYahooChartOhlcv(fetched.payload, analysisDate);
  const oldestDate = new Date(Date.parse(analysisDate) - CHART_LOOKBACK_CALENDAR_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const parsedBars = parsed.bars.filter(({ date }) => date >= oldestDate);
  const { droppedBars } = parsed;
  const { fetchedAt, adapter } = fetched.rawSnapshot;
  const latestParsedBar = parsedBars.at(-1);
  const latestSession: LatestSessionVerdict =
    latestParsedBar === undefined
      ? { status: "complete" }
      : classifyLatestSession(
          readYahooRegularSession(fetched.payload),
          latestParsedBar.date,
          fetchedAt,
        );
  /*
   * Drop the partial bar BEFORE indicators are computed: an in-progress session's close and
   * volume are running totals, and every indicator derived from them would otherwise be
   * published as if it described a completed session.
   */
  const bars = latestSession.status === "in-progress" ? parsedBars.slice(0, -1) : parsedBars;

  if (bars.length < MIN_BARS_FOR_SNAPSHOT) {
    return {
      rawSnapshot: fetched.rawSnapshot,
      sourceGaps: [
        ...latestSessionGaps(adapter, symbol, latestSession, latestParsedBar?.date, fetchedAt, {
          kind: "no-snapshot",
          completedBarCount: bars.length,
        }),
        sourceGap({
          source: adapter,
          symbol,
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
  const latestBar = bars.at(-1)!;
  const recentCloses = buildRecentCloses(bars, RECENT_CLOSES_COUNT);
  const droppedFieldGaps = droppedBars
    .filter((dropped) => dropped.date > latestBar.date)
    .map((dropped) =>
      sourceGap({
        source: adapter,
        message: `Yahoo chart bar ${dropped.date} has missing or non-numeric fields: ${dropped.missingFields.join(", ")}; latest usable session is ${latestBar.date}`,
        symbol,
        provider: "yahoo",
        capability: "market-data",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      }),
    );

  const snapshot: VerifiedMarketSnapshot = {
    symbol,
    assetClass: "equity",
    analysisDate,
    fetchedAt,
    latestSessionDate: latestBar.date,
    ...(latestSession.status === "unverified"
      ? { latestSessionStatus: "unverified" as const }
      : {}),
    ohlcv: latestBar,
    indicators,
    recentCloses,
  };

  return {
    snapshot,
    rawSnapshot: fetched.rawSnapshot,
    sourceGaps: [
      ...latestSessionGaps(adapter, symbol, latestSession, latestParsedBar?.date, fetchedAt, {
        kind: "anchored",
        latestCompletedDate: latestBar.date,
      }),
      ...droppedFieldGaps,
    ],
  };
}

/**
 * What became of the run after the partial bar was removed. The in-progress gap states the
 * consequence, so it has to know which of the two happened: the minimum-bar check runs on the
 * trimmed series, and with exactly MIN_BARS_FOR_SNAPSHOT parsed bars the drop leaves the collector
 * short and no snapshot is returned at all.
 */
type LatestSessionOutcome =
  | { readonly kind: "anchored"; readonly latestCompletedDate: string }
  | { readonly kind: "no-snapshot"; readonly completedBarCount: number };

function latestSessionGaps(
  source: string,
  symbol: string,
  verdict: LatestSessionVerdict,
  latestBarDate: string | undefined,
  fetchedAt: string,
  outcome: LatestSessionOutcome,
): readonly SourceGap[] {
  if (verdict.status === "complete" || latestBarDate === undefined) {
    return [];
  }
  if (verdict.status === "in-progress") {
    /*
     * An anchored trim is the collector working as designed — a partial bar removed, a valid
     * prior-session snapshot published — so it is Diagnostic and stays out of the Default View.
     * The no-snapshot variant is left Material: there the trim cost the run its snapshot, which a
     * reader has to see.
     */
    const consequence =
      outcome.kind === "anchored"
        ? `it was dropped before indicators and the snapshot is anchored on the last completed session ${outcome.latestCompletedDate}`
        : `it was dropped before indicators, leaving ${String(outcome.completedBarCount)} completed bars — below the ${String(MIN_BARS_FOR_SNAPSHOT)} required, so no snapshot was produced`;
    return [
      sourceGap({
        source,
        message: `Yahoo chart bar ${latestBarDate} was an in-progress session at fetch time ${fetchedAt} (regular session closes ${verdict.closesAt}); ${consequence}`,
        symbol,
        provider: "yahoo",
        capability: "market-data",
        cause: "session-in-progress",
        evidenceQualityImpact: "no-cap",
        ...(outcome.kind === "anchored" ? { triage: "diagnostic" as const } : {}),
      }),
    ];
  }
  return [
    sourceGap({
      source,
      message: `Yahoo chart bar ${latestBarDate} could not be verified as a completed session at fetch time ${fetchedAt} (${verdict.reason}); the bar is retained and may be an in-progress session`,
      symbol,
      provider: "yahoo",
      capability: "market-data",
      cause: "malformed-response",
      evidenceQualityImpact: "no-cap",
    }),
  ];
}

function buildRecentCloses(
  bars: readonly OhlcvBar[],
  count: number,
): readonly { readonly date: string; readonly close: number }[] {
  return bars.slice(-count).map((b) => ({ date: b.date, close: b.close }));
}
