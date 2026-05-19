import type { Prediction } from "../domain/types";
import {
  observableForecastFromPrediction,
  resolveObservableForecast,
  type CloseAtDate,
} from "../forecast/observable";
import type { ScoreOutcome } from "./types";

export type { CloseAtDate };

export interface ResolveResult {
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
}

export function resolvePrediction(
  prediction: Prediction,
  closePrices: readonly CloseAtDate[],
): ResolveResult | undefined {
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    throw new Error(forecast.message);
  }

  const result = resolveObservableForecast(forecast, closePrices);
  if (result.status === "unresolved") {
    return undefined;
  }
  return { outcome: result.outcome as ScoreOutcome, evidence: result.evidence };
}
