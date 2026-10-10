export type PredictionKind =
  | "direction"
  | "relative"
  | "volatility"
  | "range"
  | "macro"
  | "iv"
  | "earnings-direction"
  | "earnings-move"
  | "conditional";

const EARNINGS_EVENT_DATE_STATUSES = [
  "provider-estimated",
  "issuer-confirmed",
  "exchange-confirmed",
] as const;

export type EarningsEventDateStatus = (typeof EARNINGS_EVENT_DATE_STATUSES)[number];

export function isEarningsEventDateStatus(value: unknown): value is EarningsEventDateStatus {
  return EARNINGS_EVENT_DATE_STATUSES.includes(value as EarningsEventDateStatus);
}

export interface EarningsForecastTelemetry {
  readonly eventDateStatus: EarningsEventDateStatus | "not-present";
  readonly policy: "legacy-ungated" | "confirmed-only";
  readonly grammarEligible: boolean;
  readonly eligiblePredictionCount: number;
  readonly suppressedPredictionCount: number;
  readonly suppressionReason?: "event-date-not-confirmed" | "earnings-setup-not-present";
}

/** Maximum distance from 0.5 treated as near-base-rate forecast telemetry. */
export const NEAR_BASE_RATE_BAND = 0.1;

export interface Prediction {
  readonly id: string;
  readonly claim: string;
  readonly kind: PredictionKind;
  readonly subject: string;
  readonly measurableAs: string;
  // Under scoring policy v3 this is the horizon count whose clock the policy
  // Defines per forecast family; the field name is legacy (ADR 0003).
  readonly horizonTradingDays: number;
  readonly probability: number;
  readonly sourceIds: readonly string[];
  // Code-owned certainty of the event anchor for earnings forecasts. Optional
  // So historical artifacts remain readable.
  readonly eventDateStatus?: EarningsEventDateStatus;
  // Stamped deterministically during report assembly; model-provided values
  // Are never trusted. Absent on historical forecasts, which resolve
  // Permanently under scoring policy v2.
  readonly scoringPolicyVersion?: 3;
}
