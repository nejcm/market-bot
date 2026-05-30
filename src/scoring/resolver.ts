import type { Prediction } from "../domain/types";
import {
  type Observation,
  observableForecastFromPrediction,
  resolveObservableForecast,
} from "../forecast/observable";
import type { ScoreOutcome } from "./types";

export type { Observation };

export interface ResolveResult {
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
}

export function resolvePrediction(
  prediction: Prediction,
  observations: readonly Observation[],
): ResolveResult | undefined {
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    throw new Error(forecast.message);
  }

  const result = resolveObservableForecast(forecast, observations);
  if (result.status === "unresolved") {
    return undefined;
  }
  return { outcome: result.outcome as ScoreOutcome, evidence: result.evidence };
}
