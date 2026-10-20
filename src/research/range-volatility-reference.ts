import type { VerifiedMarketSnapshot } from "../domain/market-data";
import type { SourceGap } from "../domain/sources";
import { sourceGap } from "../domain/source-gaps";

const RANGE_REFERENCE_MIN_CLOSES = 11;
export const RANGE_REFERENCE_HORIZONS = [1, 5, 10, 20] as const;
// Closes are split-unadjusted (ADR 0004); a move far outside the MAD scale reads as a split.
const MAD_TO_SIGMA = 1.4826;
const SPLIT_SIGNATURE_ROBUST_SIGMAS = 8;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function rangeVolatilityReference(
  snapshot: VerifiedMarketSnapshot | undefined,
):
  | { readonly sigma: number; readonly spot: number; readonly returnCount: number }
  | { readonly gap: SourceGap }
  | undefined {
  const closes = snapshot?.recentCloses.map((bar) => bar.close).filter((close) => close > 0) ?? [];
  if (snapshot === undefined || closes.length < RANGE_REFERENCE_MIN_CLOSES) {
    return undefined;
  }
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]!));
  const center = median(returns);
  const robustSigma = MAD_TO_SIGMA * median(returns.map((value) => Math.abs(value - center)));
  // MAD is 0 when most days are flat; then jumps are the volatility, not a split signature.
  const largestMove = Math.max(...returns.map((value) => Math.abs(value)));
  if (robustSigma > 0 && largestMove > SPLIT_SIGNATURE_ROBUST_SIGMAS * robustSigma) {
    return {
      gap: sourceGap({
        source: "range-volatility-reference",
        symbol: snapshot.symbol,
        message:
          "The ±1σ range reference is unavailable because a split-like jump in the unadjusted recent-close window makes the volatility estimate unreliable",
        capability: "market-data",
        cause: "suppressed-by-design",
        evidenceQualityImpact: "no-cap",
      }),
    };
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const sigma = Math.sqrt(
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1),
  );
  return { sigma, spot: closes.at(-1)!, returnCount: returns.length };
}
