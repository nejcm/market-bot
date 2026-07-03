import type { AssetClass, Prediction } from "../domain/types";
import { resolutionDate } from "./exchange-calendar";

// Scoring Policy registry (ADR 0004). A Prediction's persisted
// `scoringPolicyVersion` — not a global constant — selects how its horizon
// Count maps onto a clock. Historical forecasts without a version resolve
// Permanently under policy v2; already-resolved scores are never rewritten.
//
// Policy v2 (legacy): every report-anchored forecast counts exchange trading
// Days, including crypto closes and macro/IV point observations.
//
// Policy v3 clocks:
// - Equity close forecasts: the Nth provider-observed session after the
//   Anchor (the exchange calendar may schedule retries but is not
//   Authoritative for outcomes).
// - Crypto close forecasts: the target UTC calendar date, attempted only once
//   That date has fully elapsed so a partial-day price is never graded.
// - Macro and IV forecasts: calendar days, resolving on the first published
//   Observation on or after the target date (weekends and provider holidays
//   Publish nothing on the target itself).
// - Earnings forecasts: provider-observed equity sessions anchored to the
//   Declared earnings event (identical under both policies).

export type ScoringPolicyVersion = 2 | 3;

export const CURRENT_SCORING_POLICY_VERSION = 3 as const satisfies ScoringPolicyVersion;

export interface ScoringPolicy {
  readonly version: ScoringPolicyVersion;
  // Report-anchored due date used to gate resolution attempts for close
  // Forecasts of the given asset class.
  readonly closeDueDate: (generatedAt: string, horizonDays: number, assetClass: AssetClass) => Date;
  // Report-anchored target date for point (macro/IV) forecasts.
  readonly pointTargetDate: (generatedAt: string, horizonDays: number) => Date;
  // How many UTC calendar days after a point target date the resolver may
  // Search for the first published observation. Zero means the exact target
  // Date only (policy v2, whose targets are always exchange trading days).
  readonly pointObservationSearchAheadDays: number;
  // For crypto close forecasts: the target UTC calendar date the outcome must
  // Be observed on; absent when provider-session counting applies.
  readonly cryptoCloseTargetDate?: (generatedAt: string, horizonDays: number) => Date;
}

function addUtcCalendarDays(generatedAt: string, days: number): Date {
  return new Date(Date.parse(generatedAt) + days * 86_400_000);
}

// Start of the UTC day after `date` — the earliest instant the daily close
// For `date` is final. Gating crypto resolution here keeps intraday partial
// Prices out of the graded (and permanently cached) outcome window.
function startOfUtcDayAfter(date: Date): Date {
  const truncated = new Date(date);
  truncated.setUTCHours(0, 0, 0, 0);
  return new Date(truncated.getTime() + 86_400_000);
}

const POLICY_V2: ScoringPolicy = {
  version: 2,
  closeDueDate: (generatedAt, horizonDays) => resolutionDate(generatedAt, horizonDays),
  pointTargetDate: (generatedAt, horizonDays) => resolutionDate(generatedAt, horizonDays),
  pointObservationSearchAheadDays: 0,
};

const POLICY_V3: ScoringPolicy = {
  version: 3,
  closeDueDate: (generatedAt, horizonDays, assetClass) =>
    assetClass === "crypto"
      ? startOfUtcDayAfter(addUtcCalendarDays(generatedAt, horizonDays))
      : resolutionDate(generatedAt, horizonDays),
  pointTargetDate: (generatedAt, horizonDays) => addUtcCalendarDays(generatedAt, horizonDays),
  // Covers a weekend plus adjacent provider holidays before abandoning the
  // Attempt to retry logic.
  pointObservationSearchAheadDays: 5,
  cryptoCloseTargetDate: (generatedAt, horizonDays) => addUtcCalendarDays(generatedAt, horizonDays),
};

const POLICIES: Readonly<Record<ScoringPolicyVersion, ScoringPolicy>> = {
  2: POLICY_V2,
  3: POLICY_V3,
};

// Resolver keyed by the Prediction's persisted policy version. A missing
// Version is permanently policy v2 — historical forecasts are never migrated.
export function scoringPolicyFor(prediction: Prediction): ScoringPolicy {
  return POLICIES[prediction.scoringPolicyVersion ?? 2];
}
