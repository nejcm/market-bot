import type { ObservableForecast, ObservableForecastIssue } from "./observable-types";
import { issue } from "./observable-shapes";

// Minimum trading-day gap between two accepted same-subject `direction` forecasts.
// Adjacent-horizon calls (closes higher 5d vs 6d) are correlated near-duplicates.
// Collapsing them frees prediction slots for genuinely distinct claims.
export const MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS = 2;

// Reports display probabilities to two decimals; 0.005 is half that displayed 0.01 precision,
// So smaller differences are below reader-visible resolution.
export const RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON = 0.005;

// Benchmarks qualify when they proxy the US equity market or its dominant large-cap/mega-cap beta,
// Including concentrated large-cap indexes; small- and mid-cap-specific benchmarks are excluded.
// A relative forecast against any member restates the same broad-market beta view, so only one per
// Primary subject and exact horizon is accepted. Exported so completion/repair prompt steering names
// The same members and class the validator enforces below (see relativeBenchmarkKey / redundancyKey).
export const BROAD_US_INDEX_BENCHMARK_SYMBOLS = [
  "SPY",
  "QQQ",
  "DIA",
  "IVV",
  "VOO",
  "VTI",
  "ITOT",
  "IWB",
  "SCHB",
] as const;
export const BROAD_US_INDEX_BENCHMARKS: ReadonlySet<string> = new Set(
  BROAD_US_INDEX_BENCHMARK_SYMBOLS,
);
export const BROAD_US_INDEX_CLASS = "broad-us-index";

function relativeBenchmarkKey(forecast: ObservableForecast): string | undefined {
  if (forecast.expression.kind !== "relative") {
    return undefined;
  }
  const benchmark = forecast.expression.subjectB;
  return BROAD_US_INDEX_BENCHMARKS.has(benchmark) ? BROAD_US_INDEX_CLASS : benchmark;
}

function redundancyKey(forecast: ObservableForecast): string {
  const benchmark = relativeBenchmarkKey(forecast);
  if (benchmark !== undefined && forecast.expression.kind === "relative") {
    return [
      forecast.prediction.kind,
      forecast.expression.subjectA,
      String(forecast.horizonTradingDays),
      benchmark,
    ].join("|");
  }
  return [forecast.prediction.kind, forecast.subject, String(forecast.horizonTradingDays)].join(
    "|",
  );
}

// The observable grammar renders every `direction` forecast as one up event.
// Two same-subject direction forecasts therefore always share a direction.
// Only their horizon differs, so closeness on horizon implies redundancy.
function collidingDirectionHorizons(
  forecast: ObservableForecast,
  acceptedHorizonsBySubject: ReadonlyMap<string, readonly number[]>,
): readonly number[] {
  const horizons = acceptedHorizonsBySubject.get(forecast.subject) ?? [];
  return horizons.filter(
    (horizon) =>
      Math.abs(horizon - forecast.horizonTradingDays) < MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS,
  );
}

function withoutDirectionHorizon(
  horizons: readonly number[],
  horizonToRemove: number,
): readonly number[] {
  return horizons.filter((horizon) => horizon !== horizonToRemove);
}

function replaceLongerDirectionForecast(input: {
  readonly accepted: ObservableForecast[];
  readonly acceptedDirectionHorizonsBySubject: Map<string, number[]>;
  readonly measurableSeen: Set<string>;
  readonly forecast: ObservableForecast;
  readonly longerHorizon: number;
}): boolean {
  const { accepted, acceptedDirectionHorizonsBySubject, measurableSeen, forecast, longerHorizon } =
    input;
  const { measurableAs, subject, horizonTradingDays } = forecast;
  const rejectedIndex = accepted.findIndex(
    (acceptedForecast) =>
      acceptedForecast.prediction.kind === "direction" &&
      acceptedForecast.subject === subject &&
      acceptedForecast.horizonTradingDays === longerHorizon,
  );
  const rejectedForecast = accepted[rejectedIndex];
  if (rejectedForecast === undefined) {
    return false;
  }

  accepted[rejectedIndex] = forecast;
  measurableSeen.delete(rejectedForecast.measurableAs);
  acceptedDirectionHorizonsBySubject.set(subject, [
    ...withoutDirectionHorizon(
      acceptedDirectionHorizonsBySubject.get(subject) ?? [],
      rejectedForecast.horizonTradingDays,
    ),
    horizonTradingDays,
  ]);
  measurableSeen.add(measurableAs);
  return true;
}

function directionRedundancyIssue(input: {
  readonly accepted: ObservableForecast[];
  readonly acceptedDirectionHorizonsBySubject: Map<string, number[]>;
  readonly measurableSeen: Set<string>;
  readonly forecast: ObservableForecast;
}): ObservableForecastIssue | "replaced" | undefined {
  const { accepted, acceptedDirectionHorizonsBySubject, measurableSeen, forecast } = input;
  const { prediction, subject, horizonTradingDays } = forecast;
  const collidingHorizons = collidingDirectionHorizons(
    forecast,
    acceptedDirectionHorizonsBySubject,
  );
  if (collidingHorizons.length === 0) {
    return undefined;
  }

  const shortestColliding = Math.min(...collidingHorizons);
  if (horizonTradingDays < shortestColliding) {
    const replaced = replaceLongerDirectionForecast({
      accepted,
      acceptedDirectionHorizonsBySubject,
      measurableSeen,
      forecast,
      longerHorizon: shortestColliding,
    });
    if (replaced) {
      return "replaced";
    }
  }

  return issue(
    "redundant-prediction",
    `Prediction ${prediction.id}: redundant direction forecast for ${subject} at ${String(horizonTradingDays)} trading days (within ${String(MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS)} trading days of accepted ${String(shortestColliding)}d)`,
    prediction.id,
  );
}

export function rejectRedundantForecasts(forecasts: readonly ObservableForecast[]): {
  readonly forecasts: readonly ObservableForecast[];
  readonly issues: readonly ObservableForecastIssue[];
} {
  const idSeen = new Set<string>();
  const measurableSeen = new Set<string>();
  const kindSubjectHorizonSeen = new Set<string>();
  const acceptedDirectionHorizonsBySubject = new Map<string, number[]>();
  const accepted: ObservableForecast[] = [];
  const issues: ObservableForecastIssue[] = [];

  for (const forecast of forecasts) {
    const { measurableAs, prediction, subject, horizonTradingDays } = forecast;

    if (idSeen.has(prediction.id)) {
      issues.push(
        issue(
          "duplicate-id",
          `Prediction ${prediction.id}: duplicate prediction id`,
          prediction.id,
        ),
      );
      continue;
    }
    idSeen.add(prediction.id);

    if (measurableSeen.has(measurableAs)) {
      issues.push(
        issue(
          "redundant-prediction",
          `Prediction ${prediction.id}: duplicate measurableAs "${measurableAs}"`,
          prediction.id,
        ),
      );
      continue;
    }

    if (prediction.kind === "direction") {
      const redundancyIssue = directionRedundancyIssue({
        accepted,
        acceptedDirectionHorizonsBySubject,
        measurableSeen,
        forecast,
      });
      if (redundancyIssue === "replaced") {
        continue;
      }
      if (redundancyIssue !== undefined) {
        issues.push(redundancyIssue);
        continue;
      }
    } else if (prediction.kind !== "conditional") {
      // Conditionals are redundant only when the full measurable expression
      // Matches; same consequent, probability, and horizon can be valid under
      // Different antecedents.
      const key = redundancyKey(forecast);
      if (kindSubjectHorizonSeen.has(key)) {
        const relativeExpression =
          forecast.expression.kind === "relative" ? forecast.expression : undefined;
        const acceptedRelative =
          prediction.kind === "relative" && relativeExpression !== undefined
            ? accepted.find(
                (candidate) =>
                  candidate.expression.kind === "relative" &&
                  candidate.expression.subjectA === relativeExpression.subjectA &&
                  candidate.horizonTradingDays === horizonTradingDays &&
                  relativeBenchmarkKey(candidate) === relativeBenchmarkKey(forecast),
              )
            : undefined;
        const relativeMessage =
          acceptedRelative?.expression.kind === "relative" &&
          relativeExpression !== undefined &&
          relativeBenchmarkKey(forecast) === BROAD_US_INDEX_CLASS
            ? `Prediction ${prediction.id}: redundant relative forecast for ${relativeExpression.subjectA} against ${relativeExpression.subjectB} at ${String(horizonTradingDays)} trading days; accepted benchmark ${acceptedRelative.expression.subjectB} is equivalent in class ${BROAD_US_INDEX_CLASS}`
            : undefined;
        issues.push(
          issue(
            "redundant-prediction",
            // Relative benchmark-class collisions always use the detailed message above;
            // Other forecast kinds use this generic same-kind/subject/horizon message.
            relativeMessage ??
              `Prediction ${prediction.id}: redundant ${prediction.kind} forecast for ${subject} at ${String(horizonTradingDays)} trading days`,
            prediction.id,
          ),
        );
        continue;
      }
      if (prediction.kind === "relative" && forecast.expression.kind === "relative") {
        const relativeExpression = forecast.expression;
        const acceptedRelative = accepted.find(
          (candidate) =>
            candidate.prediction.kind === prediction.kind &&
            candidate.expression.kind === "relative" &&
            candidate.expression.subjectA === relativeExpression.subjectA &&
            candidate.horizonTradingDays === horizonTradingDays &&
            Math.abs(candidate.prediction.probability - prediction.probability) <=
              RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON,
        );
        if (acceptedRelative?.expression.kind === "relative") {
          issues.push(
            issue(
              "redundant-prediction",
              `Prediction ${prediction.id}: redundant relative forecast for ${relativeExpression.subjectA} at ${String(horizonTradingDays)} trading days; benchmarks ${acceptedRelative.expression.subjectB} and ${relativeExpression.subjectB} use the same probability within tolerance (${String(acceptedRelative.prediction.probability)} and ${String(prediction.probability)}; epsilon ${String(RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON)})`,
              prediction.id,
            ),
          );
          continue;
        }
      }
      kindSubjectHorizonSeen.add(key);
    }

    measurableSeen.add(measurableAs);
    if (prediction.kind === "direction") {
      acceptedDirectionHorizonsBySubject.set(subject, [
        ...(acceptedDirectionHorizonsBySubject.get(subject) ?? []),
        horizonTradingDays,
      ]);
    }
    accepted.push(forecast);
  }

  return { forecasts: accepted, issues };
}
