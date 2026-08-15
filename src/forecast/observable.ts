import type { Prediction } from "../domain/types";
import type {
  ObservableForecast,
  ObservableForecastIssue,
  ObservableForecastPolicy,
  ObservableForecastReadResult,
} from "./observable-types";
import { resolveCandidate } from "./observable-candidates";
import { rejectRedundantForecasts } from "./observable-redundancy";

export type {
  ObservableBaseExpression,
  ObservableExpression,
  ObservableForecast,
  ObservableForecastIssue,
  ObservableForecastPolicy,
  ObservableForecastReadResult,
  Observation,
  ObservationStrategy,
  PointObservationRequest,
} from "./observable-types";

export {
  instrumentsForExpression,
  instrumentsForMeasurableAs,
  isPredictionKind,
  measurableAsForExpression,
  observationStrategyForExpression,
  observationStrategyForForecast,
  parseObservableExpression,
  renderClaim,
  renderClaimForMeasurableAs,
  resolveObservableExpression,
  resolveObservableForecast,
} from "./observable-expression";

export {
  BROAD_US_INDEX_BENCHMARKS,
  BROAD_US_INDEX_BENCHMARK_SYMBOLS,
  BROAD_US_INDEX_CLASS,
  MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS,
  RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON,
} from "./observable-redundancy";

export function observableForecastFromPrediction(
  prediction: Prediction,
): ObservableForecast | ObservableForecastIssue {
  return resolveCandidate(prediction, {});
}

export function readObservableForecasts(
  value: unknown,
  policy: ObservableForecastPolicy = {},
): ObservableForecastReadResult {
  const candidates = Array.isArray(value) ? value : [];
  const resolvedCandidates = candidates.map((candidate) => resolveCandidate(candidate, policy));
  const forecasts = resolvedCandidates.filter(
    (item): item is ObservableForecast => "prediction" in item,
  );
  const issues = resolvedCandidates.filter(
    (item): item is ObservableForecastIssue => !("prediction" in item),
  );
  const accepted = rejectRedundantForecasts(forecasts);
  const allIssues = [...issues, ...accepted.issues];

  return {
    forecasts: accepted.forecasts,
    predictions: accepted.forecasts.map((forecast) => forecast.prediction),
    issues: allIssues,
  };
}
