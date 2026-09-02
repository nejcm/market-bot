/**
 * Verified Market Snapshot collector (ADR 0004).
 *
 * Fetches ≥400 calendar days of daily OHLCV bars for an equity ticker via
 * ctx.request.json (cache + rate-limit + circuit-breaker), computes canonical
 * technical indicators, and returns a VerifiedMarketSnapshot or a SourceGap.
 *
 * Session discipline:
 * - The newest bar is accepted only once its regular session has closed, judged against the
 *   payload's own exchange schedule (see classifyLatestSession). Field presence cannot decide
 *   this: an open session populates OHLCV with running values.
 * - Indicators are computed after any such bar is removed, never before.
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
import {
  parseYahooChartOhlcv,
  readYahooRegularSession,
  yahooChartWindowUrl,
  yahooResilientFetchWrapper,
  type YahooRegularSessionRead,
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
  readonly priceHistory?: readonly Pick<OhlcvBar, "date" | "close">[];
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

  const { bars: parsedBars, droppedBars } = parseYahooChartOhlcv(fetched.payload, analysisDate);
  const { fetchedAt } = fetched.rawSnapshot;
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
        ...latestSessionGaps(symbol, latestSession, latestParsedBar?.date, fetchedAt, {
          kind: "no-snapshot",
          completedBarCount: bars.length,
        }),
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
  const latestBar = bars.at(-1)!;
  const recentCloses = buildRecentCloses(bars, RECENT_CLOSES_COUNT);
  const droppedFieldGaps = droppedBars
    .filter((dropped) => dropped.date > latestBar.date)
    .map((dropped) =>
      sourceGap({
        source: ADAPTER_ID,
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
    ohlcv: latestBar,
    indicators,
    recentCloses,
  };

  return {
    snapshot,
    priceHistory: bars.map(({ date, close }) => ({ date, close })),
    rawSnapshot: fetched.rawSnapshot,
    sourceGaps: [
      ...latestSessionGaps(symbol, latestSession, latestParsedBar?.date, fetchedAt, {
        kind: "anchored",
        latestCompletedDate: latestBar.date,
      }),
      ...droppedFieldGaps,
    ],
  };
}

/**
 * Completeness of the newest parsed bar's trading session.
 *
 * - `complete` — the session provably closed before the payload was fetched.
 * - `in-progress` — the session was still open at fetch time; the bar is a running partial.
 * - `unverified` — completeness could not be established, and `reason` says why. The bar is kept
 *   and the ambiguity is declared; it is never re-read as "complete".
 */
type LatestSessionVerdict =
  | { readonly status: "complete" }
  | { readonly status: "in-progress"; readonly closesAt: string }
  | { readonly status: "unverified"; readonly reason: string };

/*
 * A daily bar is stamped at its session open, so the newest bar belongs to the current regular
 * trading period exactly when their dates match. That bar is still forming whenever the payload
 * was fetched before the period's close.
 *
 * Off-path, the bar is KEPT — dropping a provably-complete session over broken metadata would
 * discard real evidence — and the ambiguity is declared instead:
 *
 * - Schedule absent (older cassettes, a truncated payload, a non-Yahoo shape): silence is only
 *   allowed once the bar is provably closed by age. No exchange session spans more than a day, so
 *   a bar dated before the previous UTC day is closed regardless of what any schedule says.
 * - Schedule present but implausible: always declared. The age heuristic is not applied, because a
 *   provider emitting nonsense here is exactly the case where "old enough" reasoning about its
 *   other fields is least trustworthy — and a declared gap costs far less than a silently accepted
 *   partial bar.
 */
function classifyLatestSession(
  read: YahooRegularSessionRead,
  latestBarDate: string,
  fetchedAt: string,
): LatestSessionVerdict {
  const fetchedAtSeconds = Date.parse(fetchedAt) / 1000;
  if (!Number.isFinite(fetchedAtSeconds)) {
    return {
      status: "unverified",
      reason: `the fetch timestamp ${fetchedAt} is not a readable date`,
    };
  }
  if (read.status === "unusable") {
    return {
      status: "unverified",
      reason: `the regular trading-period schedule was implausible: ${read.detail}`,
    };
  }
  if (read.status === "absent") {
    return latestBarDate >= utcDateDaysBefore(fetchedAtSeconds, 1)
      ? { status: "unverified", reason: "the payload carried no regular trading-period schedule" }
      : { status: "complete" };
  }
  /*
   * A schedule OLDER than the newest bar is stale: the bar belongs to a session the payload never
   * described, so nothing here proves that session closed. Equality-only comparison read this as
   * complete, which is the same silent acceptance a malformed window would have caused.
   *
   * A schedule NEWER than the newest bar is the legitimate pre-open case — the exchange has already
   * rolled to the next session while the last bar is the previous, provably closed one.
   */
  if (latestBarDate > read.window.startDate) {
    return {
      status: "unverified",
      reason: `the regular trading-period schedule is stale: it describes ${read.window.startDate}, older than the newest bar ${latestBarDate}`,
    };
  }
  return latestBarDate === read.window.startDate && fetchedAtSeconds < read.window.endSeconds
    ? { status: "in-progress", closesAt: read.window.endsAt }
    : { status: "complete" };
}

function utcDateDaysBefore(epochSeconds: number, days: number): string {
  return new Date((epochSeconds - days * 86_400) * 1000).toISOString().slice(0, 10);
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
        source: ADAPTER_ID,
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
      source: ADAPTER_ID,
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
