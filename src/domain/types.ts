export type AssetClass = "equity" | "crypto";

export type LegacyMarketUpdateJobType = "daily" | "weekly";

export type MarketUpdateJobType = "market-overview" | LegacyMarketUpdateJobType;

export type InstrumentJobType = "equity" | "crypto";

export type JobType = MarketUpdateJobType | InstrumentJobType | "alpha-search" | "research";

export type Depth = "brief" | "deep";

export function isMarketUpdateJobType(jobType: JobType): jobType is MarketUpdateJobType {
  return jobType === "market-overview" || jobType === "daily" || jobType === "weekly";
}

// Single-instrument runs (equity / crypto): jobType always equals assetClass.
export function isInstrumentJobType(jobType: JobType | undefined): jobType is InstrumentJobType {
  return jobType === "equity" || jobType === "crypto";
}

export function isLegacyMarketUpdateJobType(
  jobType: JobType,
): jobType is LegacyMarketUpdateJobType {
  return jobType === "daily" || jobType === "weekly";
}

export function legacyMarketUpdateHorizon(jobType: LegacyMarketUpdateJobType): number {
  return jobType === "daily" ? 5 : 15;
}

export function marketUpdateHorizonBucket(horizonTradingDays: number): string {
  if (horizonTradingDays <= 5) {
    return "1-5d";
  }
  if (horizonTradingDays <= 10) {
    return "6-10d";
  }
  if (horizonTradingDays <= 15) {
    return "11-15d";
  }
  return "16-20d";
}

// Canonical market-update horizon resolution. Market-overview runs carry an
// Explicit horizonTradingDays; legacy daily/weekly runs map to their fixed
// Horizon. Non-market-update job types (equity/crypto/alpha-search/research) have no
// Market-update horizon. Callers with a richer fallback (e.g. an extras bucket
// Or a prediction-horizon column) should resolve that first, then delegate.
export function marketUpdateHorizonOf(source: {
  readonly jobType: JobType;
  readonly horizonTradingDays?: number | undefined;
}): number | undefined {
  if (source.jobType === "market-overview") {
    return source.horizonTradingDays;
  }
  if (isLegacyMarketUpdateJobType(source.jobType)) {
    return legacyMarketUpdateHorizon(source.jobType);
  }
  return undefined;
}

export function marketUpdateHorizonBucketOf(source: {
  readonly jobType: JobType;
  readonly horizonTradingDays?: number | undefined;
}): string | undefined {
  const horizon = marketUpdateHorizonOf(source);
  return horizon === undefined ? undefined : marketUpdateHorizonBucket(horizon);
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

export const SOURCE_KINDS = [
  "market-data",
  "news",
  "model",
  "extended-evidence",
  "market-context",
  "discussion",
  "reference",
  "web",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface Source {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly fetchedAt: string;
  readonly kind: SourceKind;
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

export type WebGatherToolName = "web_search" | "web_fetch";

export interface JsonToolLoopAuditEntry {
  readonly round: number;
  readonly tool: string;
  readonly args?: unknown;
  readonly rationale?: string;
  readonly status: "accepted" | "rejected";
  readonly reason?: string;
  readonly sourceUnits?: number;
}

export interface JsonToolLoopAudit<TTool extends string = string, TAudit = JsonToolLoopAuditEntry> {
  readonly rounds: number;
  readonly acceptedRequests: readonly TAudit[];
  readonly rejectedRequests: readonly TAudit[];
  readonly sourceUnitsUsed: number;
  readonly executedTools: readonly TTool[];
  readonly emittedGaps: readonly SourceGap[];
}

export type EvidenceRequestAuditEntry = JsonToolLoopAuditEntry;

export type EvidenceRequestLoopAudit = JsonToolLoopAudit<EvidenceRequestToolName>;

export type WebGatherLoopAudit = JsonToolLoopAudit<WebGatherToolName>;

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

export type PostSynthesisAuditWarningCode =
  | "unsupported-numeric-claim"
  | "weak-evidence-posture-missing";

export interface PostSynthesisAuditWarning {
  readonly code: PostSynthesisAuditWarningCode;
  readonly location: string;
  readonly message: string;
  readonly sourceIds: readonly string[];
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
  // Pre-computed issuer fundamentals captured once from the Yahoo quote payload
  // At the single normalize point. Optional: absent for Massive fallback quotes,
  // ETFs/ADRs, or any payload lacking these fields. See ADR 0033.
  readonly fundamentals?: MarketFundamentals;
  readonly observedAt: string;
}

export interface MarketFundamentals {
  readonly trailingPE?: number;
  readonly forwardPE?: number;
  readonly priceToBook?: number;
  readonly bookValue?: number;
  // Yahoo quote dividendYield is in whole-percent units (0.36 -> 0.36%), verified
  // Against captured RR.L/AAPL fixtures. Do not confuse with trailingAnnualDividendYield
  // (a fraction). See plan revision 4.
  readonly dividendYield?: number;
  readonly epsTrailingTwelveMonths?: number;
  readonly epsForward?: number;
  readonly sharesOutstanding?: number;
  readonly trailingAnnualDividendRate?: number;
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
  | "valuation"
  | "financial-lens"
  | "business-framework"
  | "web-company-profile"
  | "yahoo-fundamentals"
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
  /** YYYY-MM-DD — run/report date (UTC date of the run) */
  readonly analysisDate: string;
  /** ISO timestamp of the underlying payload fetch — original fetch time when served from cache (provenance for the report Source) */
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

export type PredictionKind =
  | "direction"
  | "relative"
  | "volatility"
  | "range"
  | "macro"
  | "iv"
  | "earnings-direction"
  | "earnings-move"
  | "conditional";

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

export const MARKET_REGIME_LABELS = ["risk-on", "risk-off", "mixed", "insufficient-data"] as const;

export type MarketRegimeLabel = (typeof MARKET_REGIME_LABELS)[number];

export function isMarketRegimeLabel(value: unknown): value is MarketRegimeLabel {
  return MARKET_REGIME_LABELS.includes(value as MarketRegimeLabel);
}

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
  readonly horizonTradingDays?: number;
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

export interface HistoricalContextAudit {
  readonly scannedRunCount: number;
  readonly malformedRunCount: number;
  readonly malformedScoreCount: number;
  readonly candidateRunCount: number;
  readonly selectedRunCount: number;
  readonly recentSelectedCount: number;
  readonly anchorSelectedCount: number;
  readonly sameSymbolSelectedCount: number;
  readonly spotlightSymbolSelectedCount: number;
  readonly sameSubjectSelectedCount: number;
  readonly sameHorizonSelectedCount: number;
  readonly crossHorizonSelectedCount: number;
  readonly resolvedMissRunCount: number;
  readonly missCorrectionSelectedCount: number;
  readonly gapCount: number;
}

export interface CodeVersion {
  readonly branch?: string;
  readonly commit?: string;
  readonly commitShort?: string;
  readonly dirty: boolean;
}

export interface RunTrace {
  readonly runId: string;
  readonly jobType: JobType;
  readonly marketUpdateHorizonBucket?: string;
  readonly legacyMarketUpdateAlias?: LegacyMarketUpdateJobType;
  readonly marketUpdateCadence?: LegacyMarketUpdateJobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly depth: Depth;
  readonly provider: string;
  readonly codeVersion?: CodeVersion;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceGaps: readonly string[];
  readonly stages: readonly string[];
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
  readonly evidenceRequestLoop?: EvidenceRequestLoopAudit;
  readonly historicalContext?: HistoricalContextAudit;
  readonly spotlightSelection?: {
    readonly cap: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly rejectedCount: number;
    readonly malformed: boolean;
  };
  readonly domainPlaybooks: DomainPlaybookSelectionAudit;
  readonly predictionRetryErrors?: readonly string[];
  readonly predictionTrimWarnings?: readonly string[];
  readonly predictionErrors?: readonly string[];
  readonly reportValidationRetryErrors?: readonly string[];
  readonly postSynthesisAudit?: {
    readonly warningCount: number;
    readonly warnings: readonly PostSynthesisAuditWarning[];
  };
  readonly sourcePlan?: {
    readonly plannedLaneCount: number;
    readonly requiredLaneCount: number;
    readonly optionalLaneCount: number;
  };
  readonly evidenceLanes?: {
    readonly coveredLaneCount: number;
    readonly gapLaneCount: number;
    readonly requiredGapLaneCount: number;
    readonly sourceCount: number;
    readonly gapCount: number;
    readonly coverageRatio: number;
  };
  readonly forecastDisagreement?: {
    readonly configuredModelCount: number;
    readonly challengerModelCount: number;
    readonly participantCount: number;
    readonly successfulParticipantCount: number;
    readonly errorCount: number;
  };
}
