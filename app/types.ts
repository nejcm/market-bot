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
  readonly analytics?: Record<string, unknown>;
  readonly trace?: Record<string, unknown>;
  readonly score?: Record<string, unknown>;
}

export interface RunFile {
  readonly path: string;
  readonly content: string;
}

export interface ProviderHealthDetail {
  readonly summary?: Record<string, unknown>;
  readonly markdown?: string;
}
