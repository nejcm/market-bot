import type { WithheldSession } from "../sources/yahoo";

export type ScoreOutcome = "hit" | "miss";

export const ORIGIN_ANCHOR_QUARANTINE_EVIDENCE_KEY = "originAnchorQuarantine" as const;

export type PredictionScoreStatus =
  | "pending"
  | "pending-condition"
  | "active-pending"
  | "resolved"
  | "voided"
  | "abandoned";

export type MissAutopsyCause =
  | "data_gap"
  | "source_gap"
  | "model_overconfidence"
  | "insufficient_evidence";

export type ForecastErrorDirection = "overpredicted" | "underpredicted";

export interface PredictionScore {
  readonly predictionId: string;
  readonly runId: string;
  /** Optional for score files written before conditional score lifecycle states. */
  readonly status?: PredictionScoreStatus;
  readonly resolved: boolean;
  readonly outcome: ScoreOutcome | undefined;
  readonly observedAt: string | undefined;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  /** Undefined for legacy score files written before scoring logic versioning. */
  readonly scoringVersion?: number;
  readonly evidence: Record<string, unknown>;
  readonly repair?: ScoreRepair;
}

export type ScoreRepairVerdict = "proven-premature" | "suspect";

export type AuditedWithheldSession = WithheldSession & {
  readonly subject: string;
  readonly acquiredAt: string;
};

/** Provenance of an explicitly audited `score repair`; `original` is the replaced raw row. */
export interface ScoreRepair {
  readonly repairedAt: string;
  readonly verdict: ScoreRepairVerdict;
  readonly withheldSessions: readonly AuditedWithheldSession[];
  readonly original: Record<string, unknown>;
}

export interface MissAutopsyEntry {
  readonly predictionId: string;
  readonly runId: string;
  readonly observedAt: string;
  readonly scoreOutcome: ScoreOutcome;
  readonly probability: number;
  readonly forecastError: ForecastErrorDirection;
  readonly cause: MissAutopsyCause;
  readonly rationale: string;
  readonly supportingSignals: readonly string[];
  readonly evidence: Record<string, number | string>;
}

export interface MissAutopsyFile {
  readonly version: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly autopsies: readonly MissAutopsyEntry[];
}

export interface CalibrationBin {
  readonly pLow: number;
  readonly pHigh: number;
  readonly label: string;
  readonly hitCount: number;
  readonly totalCount: number;
  readonly hitRate: number;
}

export interface CalibrationMetric {
  readonly brierScore: number;
  readonly count: number;
  readonly runCount?: number;
  readonly brierStandardError?: number;
}

export type PairedSkillStatus = "model-better" | "baseline-better" | "not-yet-decidable";

/** The pre-registered review action a status maps to; it is only ever taken on a review date. */
export type PairedSkillDecisionRule = "keep-model" | "keep-recording" | "publish-baseline";

/** Paired Skill over Forecast Events carrying a Forecast Baseline; `deltaBrier` is baseline − model. */
export interface PairedSkillMetric {
  readonly count: number;
  readonly subjectCount: number;
  readonly blockCount: number;
  readonly modelBrier: number;
  readonly baselineBrier: number;
  readonly deltaBrier: number;
  /** Absent below two blocks, where a block bootstrap has nothing to resample. */
  readonly ciLow?: number;
  readonly ciHigh?: number;
  /** Secondary column: the model's skill against the fixed always-0.5 reference on the same events. */
  readonly skillVsHalf: number;
  readonly status: PairedSkillStatus;
  readonly meetsMinimumUsefulEffect: boolean;
  /** Per kind only (ADR 0003 decides per kind); absent on the overall aggregate. */
  readonly decisionRule?: PairedSkillDecisionRule;
}

export interface PairedSkillPolicy {
  readonly minimumUsefulEffect: number;
  readonly minPairedCount: number;
  readonly minBlockCount: number;
  readonly confidenceLevel: number;
  readonly bootstrapResamples: number;
  readonly seed: number;
  /** Independent blocks for 80% power at the minimum useful effect (SD 0.10); below it expect not-yet-decidable. */
  readonly poweredBlockCount: number;
}

export interface PairedSkillSummary {
  readonly policy: PairedSkillPolicy;
  /** Resolved Forecast Events without a Forecast Baseline, excluded from every paired metric. */
  readonly excludedWithoutBaselineCount: number;
  /** Range events stamped `ewma-0.94-w60-v1` (nominal-horizon √h), excluded from every paired metric; absent in older summaries. */
  readonly excludedLegacyRangeBaselineCount?: number;
  /** Absent when no resolved Forecast Event carries a baseline. */
  readonly overall?: PairedSkillMetric;
  readonly byKind: Record<string, PairedSkillMetric>;
  /** Next pre-registered review date (ADR 0003); absent in summaries written before it was recorded. */
  readonly nextReviewDate?: string;
}

export interface ConditionalCalibrationSummary {
  readonly activatedCount: number;
  readonly voidedCount: number;
}

export interface CalibrationSummary {
  readonly generatedAt: string;
  /** Resolved Forecast Events: duplicate issuances are collapsed before every aggregate. */
  readonly resolvedCount: number;
  /** Resolved issuances collapsed into an earlier issuance of the same Forecast Event. */
  readonly duplicateForecastCount: number;
  /**
   * Absent whenever `resolvedCount` is 0. There is no hit rate over zero
   * Resolved Predictions, and 0 would read as "never right" rather than
   * "nothing measured yet".
   */
  readonly hitRate?: number;
  readonly missAutopsyCount: number;
  /**
   * Absent whenever `resolvedCount` is 0. A Brier score of 0 is a perfect
   * Forecaster, so publishing it for an empty Calibration corpus would assert
   * The opposite of what is known. Omitted rather than null: `null` coerces to
   * 0 in arithmetic and comparisons, `undefined` does not.
   */
  readonly brierScore?: number;
  /** Present only in historical summaries generated before policy-v3 calibration. */
  readonly brierSkillScore?: number;
  readonly bins: readonly CalibrationBin[];
  readonly byKind: Record<string, CalibrationMetric>;
  readonly byAssetClass: Record<string, CalibrationMetric>;
  readonly byJobType: Record<string, CalibrationMetric>;
  readonly byMarketUpdateHorizonBucket: Record<string, CalibrationMetric>;
  readonly byHorizonBucket: Record<string, CalibrationMetric>;
  /**
   * Brier + count per Market Regime label at forecast time, restricted to real
   * Regime labels that meet the minimum-sample floor. Excludes the "unknown"
   * Bucket (absent/unparseable regime) and sub-floor regimes; see
   * `marketRegimeCoverage` for the full resolved-count distribution.
   */
  readonly byMarketRegime: Record<string, CalibrationMetric>;
  /**
   * Resolved-pair counts for every regime bucket, including "unknown" and
   * Sub-floor regimes. Discloses slice coverage honestly even where a Brier is
   * Withheld for small samples.
   */
  readonly marketRegimeCoverage: Record<string, number>;
  readonly byMissAutopsyCause: Record<string, number>;
  readonly conditionalPredictions: ConditionalCalibrationSummary;
  /** Headline metric; absent only in summaries written before Paired Skill existed. */
  readonly pairedSkill?: PairedSkillSummary;
}
