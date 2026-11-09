import type { EvidenceQuality, ExtendedEvidence } from "./evidence";
import type { AssetClass, JobType } from "./job-type";
import type { VerifiedMarketSnapshot } from "./market-data";
import type { Prediction } from "./prediction";
import type { Source } from "./sources";

export type ReportIntegrityAdvisoryCode = "weak-evidence-posture-missing";

export const MARKET_REGIME_LABELS = ["risk-on", "risk-off", "mixed", "insufficient-data"] as const;

export type MarketRegimeLabel = (typeof MARKET_REGIME_LABELS)[number];

export function isMarketRegimeLabel(value: unknown): value is MarketRegimeLabel {
  return MARKET_REGIME_LABELS.includes(value as MarketRegimeLabel);
}

export interface MarketRegimeDriver {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface MarketRegimeSummary {
  readonly assetClass: AssetClass;
  readonly label: MarketRegimeLabel;
  readonly proxyCount: number;
  readonly drivers: readonly MarketRegimeDriver[];
  readonly sourceIds: readonly string[];
}

// A verbatim span of a cited web source that carries a figure the claim states (Verified Web Figure).
export interface FigureQuote {
  readonly sourceId: string;
  readonly quote: string;
}

export type WebFigureFailureReason =
  | "figure-not-quoted"
  | "figure-not-in-quote"
  | "figure-ambiguous"
  | "scale-mismatch"
  | "currency-mismatch"
  | "unit-mismatch"
  | "quote-not-in-source"
  | "quote-source-not-cited"
  | "no-stored-text"
  | "quote-too-short";

export interface DroppedFigureQuote extends FigureQuote {
  readonly reason: WebFigureFailureReason;
}

export interface WebFigureFailure {
  readonly reason: WebFigureFailureReason;
  readonly figure: string;
  readonly sourceIds: readonly string[];
}

// Code-rendered metric reference text: `text` substituted at `start` (UTF-16 offset) in claim field `field`.
export interface RenderedMetric {
  readonly field: string;
  readonly start: number;
  readonly text: string;
}

// The metricSourceIds field holds ids added to sourceIds only by a metric reference.
export interface KeyFinding {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly figureQuotes?: readonly FigureQuote[];
  readonly metricSourceIds?: readonly string[];
  readonly renderedMetrics?: readonly RenderedMetric[];
}

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
  readonly figureQuotes?: readonly FigureQuote[];
  readonly metricSourceIds?: readonly string[];
  readonly renderedMetrics?: readonly RenderedMetric[];
}

export type EquityAnalysisDimensionStatus =
  | "complete"
  | "partial"
  | "blocked"
  | "not-applicable"
  | "not-assessed";

export interface EquityAnalysisCompletenessDimension {
  readonly status: EquityAnalysisDimensionStatus;
  readonly reasonCodes: readonly string[];
  readonly asOf: string;
  readonly sourceIds: readonly string[];
}

export interface EquityAnalysisCompleteness {
  readonly version: 1;
  readonly financialCoreStatus: "complete" | "partial" | "blocked";
  readonly coverageLevel: "comprehensive" | "substantial" | "limited";
  readonly asOf: string;
  readonly dimensions: {
    readonly primaryFinancials: EquityAnalysisCompletenessDimension;
    readonly valuation: EquityAnalysisCompletenessDimension;
    readonly expectations: EquityAnalysisCompletenessDimension;
    readonly capitalOwnership: EquityAnalysisCompletenessDimension;
    readonly operatingKpis: EquityAnalysisCompletenessDimension;
  };
}

// Report Integrity grades the deterministic post-synthesis pruning outcome;
// Research Quality is the worse of Evidence Quality and Report Integrity.
// Both are optional at tolerant read boundaries (historical reports predate
// Them) and stamped on every new report write.
export type ReportIntegrity = "high" | "medium" | "low";

export function isReportIntegrity(value: unknown): value is ReportIntegrity {
  return value === "high" || value === "medium" || value === "low";
}

export interface PredictionShortfall {
  readonly emittedCount: number;
  readonly targetCount: number;
  readonly missingCount: number;
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
  readonly evidenceQuality?: EvidenceQuality;
  readonly confidence?: EvidenceQuality;
  readonly reportIntegrity?: ReportIntegrity;
  readonly researchQuality?: ReportIntegrity;
  readonly researchQualityDriver?: string;
  readonly coverageLabel?: string;
  readonly equityAnalysisCompleteness?: EquityAnalysisCompleteness;
  readonly predictionShortfall?: PredictionShortfall;
  readonly dataGaps: readonly string[];
  readonly predictions: readonly Prediction[];
  readonly sources: readonly Source[];
  readonly extendedEvidence?: ExtendedEvidence;
  readonly verifiedRepresentativeSnapshots?: readonly VerifiedMarketSnapshot[];
  readonly notFinancialAdvice: true;
  readonly extras?: Record<string, unknown>;
}

export function researchReportEvidenceQuality(report: ResearchReport): EvidenceQuality {
  return report.evidenceQuality ?? report.confidence ?? "low";
}
