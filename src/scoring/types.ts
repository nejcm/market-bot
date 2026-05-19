export type ScoreOutcome = "hit" | "miss";

export interface PredictionScore {
  readonly predictionId: string;
  readonly runId: string;
  readonly resolved: boolean;
  readonly outcome: ScoreOutcome | undefined;
  readonly observedAt: string | undefined;
  readonly attemptCount: number;
  readonly evidence: Record<string, unknown>;
}

export interface CalibrationBin {
  readonly pLow: number;
  readonly pHigh: number;
  readonly label: string;
  readonly hitCount: number;
  readonly totalCount: number;
  readonly hitRate: number;
}

export interface CalibrationSummary {
  readonly generatedAt: string;
  readonly resolvedCount: number;
  readonly brierScore: number;
  readonly bins: readonly CalibrationBin[];
  readonly byKind: Record<string, { brierScore: number; count: number }>;
  readonly byAssetClass: Record<string, { brierScore: number; count: number }>;
}
