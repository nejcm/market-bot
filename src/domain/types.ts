export type AssetClass = "equity" | "crypto";

export type MarketUpdateJobType = "daily" | "weekly";

export type JobType = MarketUpdateJobType | "ticker";

export type Depth = "brief" | "deep";

export function isMarketUpdateJobType(jobType: JobType): jobType is MarketUpdateJobType {
  return jobType === "daily" || jobType === "weekly";
}

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
  readonly kind: "market-data" | "news" | "model" | "extended-evidence";
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly rawRef?: string;
  readonly provider?: string;
  readonly providerArticleId?: string;
  readonly canonicalUrl?: string;
  readonly summary?: string;
  readonly snippet?: string;
  readonly providerAliases?: readonly SourceProviderAlias[];
}

export interface SourceProviderAlias {
  readonly provider: string;
  readonly providerArticleId?: string;
  readonly publisher?: string;
  readonly fetchedAt?: string;
  readonly rawRef?: string;
}

export interface SourceGap {
  readonly source: string;
  readonly message: string;
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

export type ExtendedEvidenceCategory =
  | "sec-edgar"
  | "equity-events"
  | "fred-macro"
  | "options-iv"
  | "on-chain";

export interface ExtendedEvidenceItem {
  readonly category: ExtendedEvidenceCategory;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly metrics?: Record<string, number | string>;
}

export interface ExtendedEvidence {
  readonly instrument: Instrument;
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
}

export type PredictionKind = "direction" | "relative" | "volatility" | "range" | "macro" | "iv";

export interface Prediction {
  readonly id: string;
  readonly claim: string;
  readonly kind: PredictionKind;
  readonly subject: string;
  readonly measurableAs: string;
  readonly horizonTradingDays: number;
  readonly probability: number;
  readonly sourceIds: readonly string[];
}

export type MarketRegimeLabel = "risk-on" | "risk-off" | "mixed" | "insufficient-data";

export interface MarketRegimeSummary {
  readonly assetClass: AssetClass;
  readonly label: MarketRegimeLabel;
  readonly proxyCount: number;
  readonly drivers: readonly string[];
  readonly sourceIds: readonly string[];
}

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
  readonly predictions: readonly Prediction[];
  readonly sources: readonly Source[];
  readonly notFinancialAdvice: true;
  readonly extras?: Record<string, unknown>;
}

export interface RunTrace {
  readonly runId: string;
  readonly jobType: JobType;
  readonly marketUpdateCadence?: MarketUpdateJobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly depth: Depth;
  readonly provider: string;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceGaps: readonly string[];
  readonly stages: readonly string[];
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
  readonly predictionErrors?: readonly string[];
}
