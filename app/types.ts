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

export interface RunSearchFilters {
  readonly query: string;
  readonly symbol?: string;
  readonly assetClass?: string;
  readonly jobType?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface RunSearchResult {
  readonly run: RunSummary;
  readonly section: RunSearchSection;
  readonly label: string;
  readonly snippet: string;
  readonly sourceIds: readonly string[];
}

export type RunSearchSection =
  | "summary"
  | "keyFindings"
  | "bullCase"
  | "bearCase"
  | "risks"
  | "catalysts"
  | "predictions"
  | "sources"
  | "dataGaps";

export type ConsoleJobState = "queued" | "running" | "succeeded" | "failed";

export interface ConsoleJob {
  readonly id: string;
  readonly status: ConsoleJobState;
  readonly argv: readonly string[];
  readonly label: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly outputRunPath?: string;
}
