export interface RunSummary {
  readonly runId: string;
  readonly generatedAt?: string;
  readonly jobType?: string;
  readonly assetClass?: string;
  readonly symbol?: string;
  readonly depth?: string;
  readonly confidence?: string;
  readonly findingCount: number;
  readonly predictionCount: number;
  readonly sourceCount: number;
  readonly dataGapCount: number;
  readonly hasScore: boolean;
  readonly availableFiles: readonly string[];
}

export interface RunDetail {
  readonly summary: RunSummary;
  readonly report?: Record<string, unknown>;
  readonly markdown?: string;
}
