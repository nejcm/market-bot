import type { InstrumentIdentity } from "./instrument";
import type { AssetClass } from "./job-type";
import type { SourceGap } from "./sources";

export interface MarketSnapshot {
  readonly sourceId: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly name?: string;
  readonly identity?: InstrumentIdentity;
  readonly benchmark?: MarketBenchmark;
  readonly price: number;
  readonly changePercent24h: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly open?: number;
  readonly previousClose?: number;
  readonly averageVolume?: number;
  readonly fiftyDayAverage?: number;
  // Pre-computed issuer fundamentals captured once from the Yahoo quote payload
  // At the single normalize point. Optional: absent for Massive fallback quotes,
  // ETFs/ADRs, or any payload lacking these fields. See ADR 0004.
  readonly fundamentals?: MarketFundamentals;
  // The observedAt field records when this snapshot was fetched, not when the quote was struck.
  // An upstream-cached prior-session price still carries a fresh fetch time in observedAt.
  // Judge price age from quoteTimeUtc when present; only Yahoo populates it today.
  readonly observedAt: string;
  // The quoteTimeUtc field records the provider's quote timestamp in ISO 8601 UTC.
  // The field is optional and is emitted only for payloads with a Yahoo regularMarketTime.
  // The quoteTimeUtc field is not interchangeable with observedAt and is never a fetch time.
  // Deterministic artifact renderers consume it through resolveMarketSnapshotPriceAsOf; see ADR 0004.
  readonly quoteTimeUtc?: string;
}

export type MarketSnapshotPriceAsOf =
  | { readonly kind: "quote-time"; readonly instant: string }
  | { readonly kind: "fetch-time-only"; readonly instant: string };

export function resolveMarketSnapshotPriceAsOf(
  snapshot: Pick<MarketSnapshot, "observedAt" | "quoteTimeUtc">,
): MarketSnapshotPriceAsOf {
  return snapshot.quoteTimeUtc === undefined
    ? { kind: "fetch-time-only", instant: snapshot.observedAt }
    : { kind: "quote-time", instant: snapshot.quoteTimeUtc };
}

// Producers write these phrases and renderers find them by the same text to relabel the instant.
export function marketCapAsOfPhrase(priceAsOf: MarketSnapshotPriceAsOf): string {
  return `market cap as of ${priceAsOf.instant.slice(0, 10)}${priceAsOf.kind === "fetch-time-only" ? " (fetch time)" : ""}`;
}

export function marketCapQuotePhrase(priceAsOf: MarketSnapshotPriceAsOf): string {
  return `market cap (${priceAsOf.kind === "quote-time" ? "quote" : "fetch time"} ${priceAsOf.instant.slice(0, 10)})`;
}

export interface MarketFundamentals {
  readonly trailingPE?: number;
  readonly forwardPE?: number;
  readonly priceToBook?: number;
  readonly bookValue?: number;
  // Yahoo quote dividendYield is in whole-percent units (0.36 -> 0.36%), verified
  // Against captured RR.L/AAPL fixtures. Do not confuse with trailingAnnualDividendYield
  // (a fraction). See plan revision 4.
  readonly dividendYield?: number;
  readonly epsTrailingTwelveMonths?: number;
  readonly epsForward?: number;
  readonly sharesOutstanding?: number;
  readonly trailingAnnualDividendRate?: number;
}

export interface MarketBenchmark {
  readonly sourceId: string;
  readonly symbol: string;
  readonly name?: string;
  readonly basis: "sector-etf" | "broad-index";
  readonly sector?: string;
  readonly changePercent24h: number;
  readonly observedAt: string;
}

export interface Mover {
  readonly snapshot: MarketSnapshot;
  readonly rank: number;
  readonly score: number;
  readonly features: MoverFeatures;
}

export interface MoverFeatures {
  readonly movementMagnitude: number;
  readonly benchmarkSymbol?: string;
  readonly benchmarkChangePercent24h?: number;
  readonly relativeChangePercent24h?: number;
  readonly relativeMovementMagnitude?: number;
  readonly liquidityLog: number;
  readonly baseScore: number;
  readonly unusualVolumeRatio?: number;
  readonly unusualVolumeBoost: number;
  readonly gapPercent?: number;
  readonly gapBoost: number;
  readonly finalMultiplier: number;
  readonly reasons: readonly string[];
}

type MarketContextCategory = "fred-macro";

interface MarketContextItem {
  readonly category: MarketContextCategory;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly metrics?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Verified Market Snapshot (ADR 0004)
// ---------------------------------------------------------------------------

export interface OhlcvBar {
  /** YYYY-MM-DD (UTC calendar date) */
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Canonical indicator key schema, locked in ADR 0004. Phase A.2 matches these keys. */
export interface IndicatorMap {
  readonly ema10: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly rsi14: number | null;
  readonly macd: number | null;
  readonly macdSignal: number | null;
  readonly macdHistogram: number | null;
  readonly bollUpper: number | null;
  readonly bollMiddle: number | null;
  readonly bollLower: number | null;
  readonly atr14: number | null;
}

export interface VerifiedMarketSnapshot {
  readonly symbol: string;
  readonly assetClass: "equity";
  /** YYYY-MM-DD — run/report date (UTC date of the run) */
  readonly analysisDate: string;
  /** ISO timestamp of the underlying payload fetch — original fetch time when served from cache (provenance for the report Source) */
  readonly fetchedAt: string;
  /** Date of last bar used */
  readonly latestSessionDate: string;
  readonly latestSessionStatus?: "unverified";
  /** Latest session bar */
  readonly ohlcv: OhlcvBar;
  readonly indicators: IndicatorMap;
  /** Last ~30 sessions */
  readonly recentCloses: readonly { readonly date: string; readonly close: number }[];
}

export interface MarketContext {
  readonly assetClass: AssetClass;
  readonly items: readonly MarketContextItem[];
  readonly gaps: readonly SourceGap[];
}
