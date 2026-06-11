export type AssetClass = "equity" | "crypto";

export type MarketUpdateJobType = "daily" | "weekly";

export type JobType = MarketUpdateJobType | "ticker" | "alpha-search";

export type Depth = "brief" | "deep";

export function isMarketUpdateJobType(jobType: JobType): jobType is MarketUpdateJobType {
  return jobType === "daily" || jobType === "weekly";
}

export interface Instrument {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly identity?: InstrumentIdentity;
}

export interface ProviderInstrumentId {
  readonly provider: string;
  readonly idKind: string;
  readonly value: string;
}

export interface InstrumentIdentity {
  readonly exchange?: string;
  readonly quoteCurrency?: string;
  readonly displayName?: string;
  readonly providerIds?: readonly ProviderInstrumentId[];
  readonly aliases?: readonly ProviderInstrumentId[];
}

export interface Source {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly fetchedAt: string;
  readonly kind:
    | "market-data"
    | "news"
    | "model"
    | "extended-evidence"
    | "market-context"
    | "discussion";
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly rawRef?: string;
  readonly provider?: string;
  readonly providerArticleId?: string;
  readonly canonicalUrl?: string;
  readonly summary?: string;
  readonly snippet?: string;
  readonly providerAliases?: readonly SourceProviderAlias[];
  readonly identity?: InstrumentIdentity;
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
  readonly provider?: string;
  readonly capability?: SourceGapCapability;
  readonly cause?: SourceGapCause;
  readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
}

export type SourceGapCapability =
  | "market-data"
  | "news"
  | "discussion"
  | "extended-evidence"
  | "market-context"
  | "evidence-request"
  | "cache";

export type SourceGapCause =
  | "missing-credential"
  | "fetch-failed"
  | "circuit-open"
  | "stale-fallback"
  | "unsupported-coverage"
  | "repeat-fallback"
  | "malformed-response"
  | "validation-failed"
  | "provider-data-missing";

export type SourceGapEvidenceQualityImpact = "core-cap" | "extended-evidence-cap" | "no-cap";

export type EvidenceRequestToolName = "sec_latest_filing" | "tradier_iv_term_structure";

export interface EvidenceRequestAuditEntry {
  readonly round: number;
  readonly tool: string;
  readonly args?: unknown;
  readonly rationale?: string;
  readonly status: "accepted" | "rejected";
  readonly reason?: string;
  readonly sourceUnits?: number;
}

export interface EvidenceRequestLoopAudit {
  readonly rounds: number;
  readonly acceptedRequests: readonly EvidenceRequestAuditEntry[];
  readonly rejectedRequests: readonly EvidenceRequestAuditEntry[];
  readonly sourceUnitsUsed: number;
  readonly executedTools: readonly EvidenceRequestToolName[];
  readonly emittedGaps: readonly SourceGap[];
}

export interface DomainPlaybookSelectionAudit {
  readonly selected: readonly {
    readonly stage: string;
    readonly playbookIds: readonly string[];
  }[];
  readonly rationale?: string;
  readonly rejected: readonly {
    readonly stage?: string;
    readonly playbookId?: string;
    readonly reason: string;
  }[];
}

export interface MarketSnapshot {
  readonly sourceId: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly name?: string;
  readonly identity?: InstrumentIdentity;
  readonly benchmark?: MarketBenchmark;
  readonly price: number;
  readonly changePercent24h: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly open?: number;
  readonly previousClose?: number;
  readonly averageVolume?: number;
  readonly fiftyDayAverage?: number;
  readonly observedAt: string;
}

export interface MarketBenchmark {
  readonly sourceId: string;
  readonly symbol: string;
  readonly name?: string;
  readonly basis: "sector-etf" | "broad-index";
  readonly sector?: string;
  readonly changePercent24h: number;
  readonly observedAt: string;
}

export interface Mover {
  readonly snapshot: MarketSnapshot;
  readonly rank: number;
  readonly score: number;
  readonly features: MoverFeatures;
}

export interface MoverFeatures {
  readonly movementMagnitude: number;
  readonly benchmarkSymbol?: string;
  readonly benchmarkChangePercent24h?: number;
  readonly relativeChangePercent24h?: number;
  readonly relativeMovementMagnitude?: number;
  readonly liquidityLog: number;
  readonly baseScore: number;
  readonly unusualVolumeRatio?: number;
  readonly unusualVolumeBoost: number;
  readonly gapPercent?: number;
  readonly gapBoost: number;
  readonly finalMultiplier: number;
  readonly reasons: readonly string[];
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
  readonly identity?: InstrumentIdentity;
}

export interface ExtendedEvidence {
  readonly instrument: Instrument;
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
}

export type MarketContextCategory = "fred-macro";

export interface MarketContextItem {
  readonly category: MarketContextCategory;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly metrics?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Verified Market Snapshot (ADR 0019)
// ---------------------------------------------------------------------------

export interface OhlcvBar {
  /** YYYY-MM-DD (UTC calendar date) */
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** Canonical indicator key schema, locked in ADR 0019. Phase A.2 matches these keys. */
export interface IndicatorMap {
  readonly ema10: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly rsi14: number | null;
  readonly macd: number | null;
  readonly macdSignal: number | null;
  readonly macdHistogram: number | null;
  readonly bollUpper: number | null;
  readonly bollMiddle: number | null;
  readonly bollLower: number | null;
  readonly atr14: number | null;
}

export interface VerifiedMarketSnapshot {
  readonly symbol: string;
  readonly assetClass: "equity";
  /** YYYY-MM-DD — run/report date (UTC of fetchedAt) */
  readonly analysisDate: string;
  /** ISO timestamp of the collecting fetch (provenance for the report Source) */
  readonly fetchedAt: string;
  /** Date of last bar used */
  readonly latestSessionDate: string;
  /** Latest session bar */
  readonly ohlcv: OhlcvBar;
  readonly indicators: IndicatorMap;
  /** Last ~30 sessions */
  readonly recentCloses: readonly { readonly date: string; readonly close: number }[];
}

export interface MarketContext {
  readonly assetClass: AssetClass;
  readonly items: readonly MarketContextItem[];
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
  readonly extendedEvidence?: ExtendedEvidence;
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
  readonly evidenceRequestLoop?: EvidenceRequestLoopAudit;
  readonly historicalContext?: {
    readonly scannedRunCount: number;
    readonly malformedRunCount: number;
    readonly malformedScoreCount: number;
    readonly candidateRunCount: number;
    readonly selectedRunCount: number;
    readonly recentSelectedCount: number;
    readonly anchorSelectedCount: number;
  };
  readonly spotlightSelection?: {
    readonly cap: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly rejectedCount: number;
    readonly malformed: boolean;
  };
  readonly domainPlaybooks: DomainPlaybookSelectionAudit;
  readonly predictionRetryErrors?: readonly string[];
  readonly predictionErrors?: readonly string[];
  readonly reportValidationErrors?: readonly string[];
}
