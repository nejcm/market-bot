import type { ObservableExpression } from "./observable-types";

// Frozen Forecast Baseline estimator identity; any change to the math below needs a new version.
export const FORECAST_BASELINE_VERSION = "ewma-0.94-w60-v1";
const EWMA_LAMBDA = 0.94;
export const FORECAST_BASELINE_RETURN_WINDOW = 60;
const BASELINE_DECIMAL_PLACES = 4;
// A move far outside the MAD scale reads as an unadjusted split rather than volatility.
const MAD_TO_SIGMA = 1.4826;
const SPLIT_SIGNATURE_ROBUST_SIGMAS = 8;
// Adjusted closes keep real large moves; only a residual jump near a common split ratio (either
// Direction covers reverse splits) reads as a split, allowing a real ±10% move on the split day.
const SPLIT_RATIOS = [5 / 4, 4 / 3, 3 / 2, 2, 3, 4, 5, 10];
const SPLIT_DAY_TOLERANCE = Math.log(1.1) + 0.03;
const PROVIDER_SPLIT_WINDOW_DAYS = 4;
// Weekend plus one holiday; a wider gap between relative legs means one leg's closes are stale.
const MAX_LEG_CUTOFF_GAP_DAYS = 4;

export interface BaselineClose {
  readonly date: string;
  readonly close: number;
}

export type ForecastBaselineUnavailableReason =
  | "missing-closes"
  | "short-history"
  | "split-signature"
  | "zero-volatility"
  | "stale-closes";

export type ForecastBaselineResult =
  | { readonly status: "computed"; readonly probability: number; readonly infoCutoff: string }
  | {
      readonly status: "unavailable";
      readonly symbol: string;
      readonly reason: ForecastBaselineUnavailableReason;
    }
  | { readonly status: "unsupported" };

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function outlierIndexes(returns: readonly number[]): readonly number[] {
  const center = median(returns);
  const robustSigma = MAD_TO_SIGMA * median(returns.map((value) => Math.abs(value - center)));
  // MAD is 0 when most days are flat; then jumps are the volatility, not a split signature.
  return robustSigma > 0
    ? returns.flatMap((value, index) =>
        Math.abs(value) > SPLIT_SIGNATURE_ROBUST_SIGMAS * robustSigma ? [index] : [],
      )
    : [];
}

export function hasSplitSignature(returns: readonly number[]): boolean {
  return outlierIndexes(returns).length > 0;
}

// Shortcut: without provider split metadata a real 10-65% one-day move inside the ratio windows reads as a split; volume is not consulted.
function hasAdjustedSplitSignature(
  window: readonly BaselineClose[],
  returns: readonly number[],
  providerSplitDates: readonly string[] | undefined,
): boolean {
  // Closes are already adjusted for reported splits: a ratio jump far from one is a real move,
  // One next to a reported split is a misdated adjustment.
  const nearReportedSplit = (index: number) => {
    const jumpDate = Date.parse(window[index + 1]!.date);
    return (providerSplitDates ?? []).some(
      (date) => Math.abs(Date.parse(date) - jumpDate) <= PROVIDER_SPLIT_WINDOW_DAYS * 86_400_000,
    );
  };
  return outlierIndexes(returns).some(
    (index) =>
      SPLIT_RATIOS.some(
        (ratio) => Math.abs(Math.abs(returns[index]!) - Math.log(ratio)) <= SPLIT_DAY_TOLERANCE,
      ) &&
      (providerSplitDates === undefined || nearReportedSplit(index)),
  );
}

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
export function standardNormalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.327_591_1 * x);
  const poly =
    ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736) * t +
      0.254_829_592) *
    t;
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

// Zero-mean EWMA daily log-return volatility, seeded with the window's mean square.
export function ewmaDailySigma(returns: readonly number[]): number {
  let variance = returns.reduce((sum, value) => sum + value * value, 0) / returns.length;
  for (const value of returns) {
    variance = EWMA_LAMBDA * variance + (1 - EWMA_LAMBDA) * value * value;
  }
  return Math.sqrt(variance);
}

export function rangeOutsideProbability(input: {
  readonly sigma: number;
  readonly spot: number;
  readonly lo: number;
  readonly hi: number;
  readonly horizon: number;
}): number {
  const scale = input.sigma * Math.sqrt(input.horizon);
  const below = (bound: number) =>
    bound > 0 ? standardNormalCdf(Math.log(bound / input.spot) / scale) : 0;
  return below(input.lo) + 1 - below(input.hi);
}

interface ReturnWindow {
  readonly sigma: number;
  readonly spot: number;
  readonly infoCutoff: string;
}

function returnWindow(
  symbol: string,
  closesBySymbol: ReadonlyMap<string, readonly BaselineClose[]>,
  splitDatesBySymbol: ReadonlyMap<string, readonly string[]> | undefined,
): ReturnWindow | Extract<ForecastBaselineResult, { readonly status: "unavailable" }> {
  const series = closesBySymbol.get(symbol.toUpperCase());
  if (series === undefined || series.length === 0) {
    return { status: "unavailable", symbol, reason: "missing-closes" };
  }
  const window = series
    .filter((bar) => bar.close > 0)
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .slice(-(FORECAST_BASELINE_RETURN_WINDOW + 1));
  if (window.length < FORECAST_BASELINE_RETURN_WINDOW + 1) {
    return { status: "unavailable", symbol, reason: "short-history" };
  }
  const returns = window.slice(1).map((bar, index) => Math.log(bar.close / window[index]!.close));
  if (hasAdjustedSplitSignature(window, returns, splitDatesBySymbol?.get(symbol.toUpperCase()))) {
    return { status: "unavailable", symbol, reason: "split-signature" };
  }
  const sigma = ewmaDailySigma(returns);
  if (sigma === 0) {
    return { status: "unavailable", symbol, reason: "zero-volatility" };
  }
  const last = window.at(-1)!;
  return { sigma, spot: last.close, infoCutoff: last.date };
}

function computed(probability: number, infoCutoff: string): ForecastBaselineResult {
  return {
    status: "computed",
    probability: Number(probability.toFixed(BASELINE_DECIMAL_PLACES)),
    infoCutoff,
  };
}

// Forecast Baseline: zero-drift lognormal with EWMA volatility on split-adjusted closes, √h aggregation.
// A symbol missing from splitDatesBySymbol has unknown split metadata, not "no splits".
export function forecastBaseline(
  expression: ObservableExpression,
  closesBySymbol: ReadonlyMap<string, readonly BaselineClose[]>,
  splitDatesBySymbol?: ReadonlyMap<string, readonly string[]>,
): ForecastBaselineResult {
  switch (expression.kind) {
    case "range": {
      const window = returnWindow(expression.subject, closesBySymbol, splitDatesBySymbol);
      if ("status" in window) {
        return window;
      }
      return computed(
        rangeOutsideProbability({
          sigma: window.sigma,
          spot: window.spot,
          lo: expression.lo,
          hi: expression.hi,
          horizon: expression.horizonTradingDays,
        }),
        window.infoCutoff,
      );
    }
    case "direction": {
      const window = returnWindow(expression.subject, closesBySymbol, splitDatesBySymbol);
      // Zero drift makes P(close(+h) > close(0)) exactly 1/2 for any sigma.
      return "status" in window ? window : computed(0.5, window.infoCutoff);
    }
    case "relative": {
      const a = returnWindow(expression.subjectA, closesBySymbol, splitDatesBySymbol);
      if ("status" in a) {
        return a;
      }
      const b = returnWindow(expression.subjectB, closesBySymbol, splitDatesBySymbol);
      if ("status" in b) {
        return b;
      }
      const [earlier, later] = a.infoCutoff <= b.infoCutoff ? [a, b] : [b, a];
      if (
        Date.parse(later.infoCutoff) - Date.parse(earlier.infoCutoff) >
        MAX_LEG_CUTOFF_GAP_DAYS * 86_400_000
      ) {
        return {
          status: "unavailable",
          symbol: earlier === a ? expression.subjectA : expression.subjectB,
          reason: "stale-closes",
        };
      }
      // The A−B log-return difference is zero-drift and symmetric, so P(A beats B) is 1/2.
      return computed(0.5, earlier.infoCutoff);
    }
    default: {
      return { status: "unsupported" };
    }
  }
}
