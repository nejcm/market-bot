import type { VerifiedMarketSnapshot } from "../domain/market-data";
import type { SourceGap } from "../domain/sources";
import { sourceGap } from "../domain/source-gaps";
import { hasSplitSignature } from "../forecast/baseline";

const RANGE_REFERENCE_MIN_CLOSES = 11;
// Gaussian P(|z| > 1); 5y AAPL/AMD/MSFT/SPY frequency was 0.285–0.334 (ADR 0003).
export const RANGE_REFERENCE_OUTSIDE_PROBABILITY = 0.32;
export const RANGE_REFERENCE_HORIZONS = [1, 5, 10, 20] as const;

// Range-band probabilities ran ~1.6x above realized outcomes (F6); volatility supplies a band reference.
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
  if (hasSplitSignature(returns)) {
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

export function rangeReferenceBand(
  reference: { readonly sigma: number; readonly spot: number },
  horizon: number,
): readonly [number, number] | undefined {
  if (!RANGE_REFERENCE_HORIZONS.some((value) => value === horizon)) {
    return undefined;
  }
  const move = reference.sigma * Math.sqrt(horizon);
  return [
    Number((reference.spot * Math.exp(-move)).toFixed(2)),
    Number((reference.spot * Math.exp(move)).toFixed(2)),
  ];
}
