export type AssetClass = "equity" | "crypto";

export type JobType = "daily" | "ticker";

export type Depth = "brief" | "deep";

export interface Instrument {
  readonly symbol: string;
  readonly assetClass: AssetClass;
}

export interface Source {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly fetchedAt: string;
  readonly kind: "market-data" | "news" | "model";
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly rawRef?: string;
}

export interface MarketSnapshot {
  readonly sourceId: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly name?: string;
  readonly price: number;
  readonly changePercent24h: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly observedAt: string;
}

export interface Mover {
  readonly snapshot: MarketSnapshot;
  readonly rank: number;
  readonly score: number;
}

export type EvidenceQuality = "high" | "medium" | "low";

export interface KeyFinding {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface ResearchReport {
  readonly runId: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly keyFindings: readonly KeyFinding[];
  readonly bullCase: readonly KeyFinding[];
  readonly bearCase: readonly KeyFinding[];
  readonly risks: readonly KeyFinding[];
  readonly catalysts: readonly KeyFinding[];
  readonly scenarios: readonly Scenario[];
  readonly confidence: EvidenceQuality;
  readonly dataGaps: readonly string[];
  readonly sources: readonly Source[];
  readonly notFinancialAdvice: true;
  readonly extras?: Record<string, unknown>;
}

export interface RunTrace {
  readonly runId: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly depth: Depth;
  readonly provider: string;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceGaps: readonly string[];
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}
