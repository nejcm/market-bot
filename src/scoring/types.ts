export type ScoreOutcome = "hit" | "miss";

export type MissAutopsyCause =
  | "data_gap"
  | "source_gap"
  | "regime_shift"
  | "one_off_catalyst"
  | "model_overconfidence"
  | "insufficient_evidence";

export type ForecastErrorDirection = "overpredicted" | "underpredicted";

export interface PredictionScore {
  readonly predictionId: string;
  readonly runId: string;
  readonly resolved: boolean;
  readonly outcome: ScoreOutcome | undefined;
  readonly observedAt: string | undefined;
  readonly attemptCount: number;
  /** Undefined for legacy score files written before scoring logic versioning. */
  readonly scoringVersion?: number;
  readonly evidence: Record<string, unknown>;
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
}

export interface CalibrationSummary {
  readonly generatedAt: string;
  readonly resolvedCount: number;
  readonly brierScore: number;
  /** Brier skill vs the always-0.5 baseline (Brier 0.25). 0 = no edge, 1 = perfect, <0 = worse. */
  readonly brierSkillScore: number;
  readonly bins: readonly CalibrationBin[];
  readonly byKind: Record<string, CalibrationMetric>;
  readonly byAssetClass: Record<string, CalibrationMetric>;
  readonly byJobType: Record<string, CalibrationMetric>;
  readonly byMarketUpdateCadence: Record<string, CalibrationMetric>;
  readonly byHorizonBucket: Record<string, CalibrationMetric>;
}
