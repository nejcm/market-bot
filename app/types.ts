import type { MarketSnapshot, VerifiedMarketSnapshot } from "../src/domain/types";
import type { BusinessFrameworkArtifact } from "../src/sources/extended-evidence/business-framework";
import type { FinancialLensArtifact } from "../src/sources/extended-evidence/financial-lens";
import type { FinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import type { SubsequentFinancingBridgeArtifact } from "../src/sources/extended-evidence/subsequent-financing";
import type { FundamentalHistoryArtifact } from "../src/sources/extended-evidence/fundamental-history";
import type { PeerImpliedRange } from "../src/sources/extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";
import type { WebSubjectProfileArtifact } from "../src/web-evidence";

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
  readonly missAutopsy?: Record<string, unknown>;
  readonly marketSnapshots?: readonly MarketSnapshot[];
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly financialLenses?: FinancialLensArtifact;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly subsequentFinancing?: SubsequentFinancingBridgeArtifact;
  readonly peerImpliedRange?: PeerImpliedRange;
  readonly valuationWorkbench?: ValuationWorkbenchArtifact;
  readonly fundamentalHistory?: FundamentalHistoryArtifact;
  readonly businessFramework?: BusinessFrameworkArtifact;
  readonly webSubjectProfile?: WebSubjectProfileArtifact;
}

export interface RunFile {
  readonly path: string;
  readonly content: string;
}

export interface ProviderHealthDetail {
  readonly summary?: Record<string, unknown>;
  readonly markdown?: string;
}

export interface CalibrationDetail {
  readonly summary?: Record<string, unknown>;
  readonly markdown?: string;
}

export interface AlphaCohortDetail {
  readonly summary?: Record<string, unknown>;
  readonly markdown?: string;
}

export type InstrumentForecastOutcome =
  | "event-true"
  | "event-false"
  | "pending"
  | "voided"
  | "unscored";

export interface InstrumentTimelinePricePoint {
  readonly date: string;
  readonly close: number;
}

export interface InstrumentTimelineForecast {
  readonly id: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: string;
  readonly scope: string;
  readonly claim: string;
  readonly subject: string;
  readonly probability: number;
  readonly horizonTradingDays: number;
  readonly outcome: InstrumentForecastOutcome;
  readonly observedAt?: string;
  readonly missAutopsyCause?: string;
}

export interface InstrumentTimelineDetail {
  readonly assetClass: string;
  readonly symbol: string;
  readonly instrumentKey: string;
  readonly generatedAt: string;
  readonly source: "history" | "live";
  readonly entries: readonly InstrumentTimelineForecast[];
  readonly pricePoints: readonly InstrumentTimelinePricePoint[];
  readonly counts: {
    readonly total: number;
    readonly eventTrue: number;
    readonly eventFalse: number;
    readonly pending: number;
    readonly voided: number;
    readonly unscored: number;
  };
  readonly warnings: {
    readonly malformedRunCount: number;
    readonly malformedPredictionCount: number;
  };
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
  | "researchLeads"
  | "rejectedCandidates"
  | "predictions"
  | "sources"
  | "dataGaps"
  | "extendedEvidence";

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
