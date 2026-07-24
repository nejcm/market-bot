import {
  isEarningsEventDateStatus,
  type EarningsEventDateStatus,
  type EarningsForecastTelemetry,
  type Prediction,
  type ResearchReport,
} from "../domain/types";
import { isRecord } from "../guards";
import type { EarningsSetupCollected } from "../sources/types";

export type EarningsForecastPolicy = EarningsForecastTelemetry["policy"];

function isEarningsPrediction(prediction: Prediction): boolean {
  return prediction.kind === "earnings-direction" || prediction.kind === "earnings-move";
}

export function earningsEventDateStatus(
  setup: EarningsSetupCollected | undefined,
): EarningsEventDateStatus | undefined {
  const status = setup?.event.eventDateStatus ?? setup?.event.dateStatus;
  return isEarningsEventDateStatus(status) ? status : undefined;
}

export function hasConfirmedEarningsDate(setup: EarningsSetupCollected | undefined): boolean {
  const status = earningsEventDateStatus(setup);
  return status === "issuer-confirmed" || status === "exchange-confirmed";
}

export function applyEarningsForecastPolicy(input: {
  readonly predictions: readonly Prediction[];
  readonly setup: EarningsSetupCollected | undefined;
  readonly policy: EarningsForecastPolicy;
}): {
  readonly predictions: readonly Prediction[];
  readonly telemetry: EarningsForecastTelemetry;
} {
  const status = earningsEventDateStatus(input.setup);
  const eventDateStatus = status ?? "not-present";
  const grammarEligible =
    input.policy === "legacy-ungated"
      ? input.setup !== undefined
      : hasConfirmedEarningsDate(input.setup);
  const suppressEarnings = input.policy === "confirmed-only" && !grammarEligible;
  const earningsCandidates = input.predictions.filter(isEarningsPrediction);
  const predictions = suppressEarnings
    ? input.predictions.filter((prediction) => !isEarningsPrediction(prediction))
    : input.predictions.map((prediction) =>
        isEarningsPrediction(prediction) && status !== undefined
          ? { ...prediction, eventDateStatus: status }
          : prediction,
      );

  return {
    predictions,
    telemetry: {
      eventDateStatus,
      policy: input.policy,
      grammarEligible,
      eligiblePredictionCount: suppressEarnings ? 0 : earningsCandidates.length,
      suppressedPredictionCount: suppressEarnings ? earningsCandidates.length : 0,
      ...(!grammarEligible && input.policy === "confirmed-only"
        ? {
            suppressionReason:
              input.setup === undefined
                ? ("earnings-setup-not-present" as const)
                : ("event-date-not-confirmed" as const),
          }
        : {}),
    },
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readEarningsForecastTelemetry(
  report: Pick<ResearchReport, "extras">,
): EarningsForecastTelemetry | undefined {
  const value = report.extras?.earningsForecasts;
  if (!isRecord(value)) {
    return undefined;
  }
  const { eventDateStatus } = value;
  const { policy } = value;
  const { grammarEligible } = value;
  const eligiblePredictionCount = readNonNegativeInteger(value.eligiblePredictionCount);
  const suppressedPredictionCount = readNonNegativeInteger(value.suppressedPredictionCount);
  const { suppressionReason } = value;
  if (
    (eventDateStatus !== "not-present" && !isEarningsEventDateStatus(eventDateStatus)) ||
    (policy !== "legacy-ungated" && policy !== "confirmed-only") ||
    typeof grammarEligible !== "boolean" ||
    eligiblePredictionCount === undefined ||
    suppressedPredictionCount === undefined ||
    (suppressionReason !== undefined &&
      suppressionReason !== "event-date-not-confirmed" &&
      suppressionReason !== "earnings-setup-not-present")
  ) {
    return undefined;
  }
  return {
    eventDateStatus,
    policy,
    grammarEligible,
    eligiblePredictionCount,
    suppressedPredictionCount,
    ...(suppressionReason !== undefined ? { suppressionReason } : {}),
  };
}

export function reconcileEarningsForecastTelemetry<T extends ResearchReport>(report: T): T {
  const telemetry = readEarningsForecastTelemetry(report);
  if (telemetry === undefined) {
    return report;
  }
  const eligiblePredictionCount = report.predictions.filter(isEarningsPrediction).length;
  if (eligiblePredictionCount === telemetry.eligiblePredictionCount) {
    return report;
  }
  return {
    ...report,
    extras: {
      ...report.extras,
      earningsForecasts: { ...telemetry, eligiblePredictionCount },
    },
  };
}
