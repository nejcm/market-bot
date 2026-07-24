import type { RunArtifactPaths } from "../artifacts";
import type { InstrumentCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  MarketSnapshot,
  ResearchReport,
  RunTrace,
  Source,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../domain/types";
import type { ModelProvider } from "../model/types";
import type { RunAnalytics } from "../research/run-analytics";
import type { StageOutput } from "../research/final-synthesis";
import type { HistoricalResearchContext } from "../research/historical-context";
import type {
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
  SourcePlanArtifact,
} from "../research/source-plan";
import type {
  CollectedSources,
  EarningsSetupCollected,
  FetchLike,
  NewsCollectionAnalytics,
} from "../sources/types";
import type { CollectSourcesRuntimeOptions } from "../sources/collector";
import type { PersistedResearchJobResult, RunResearchJobInput } from "../research/orchestrator";
import type { ModelInputSanitizationAggregate } from "../sources/model-input-sanitizer";
import type { FinancialStatementsArtifact } from "../sources/extended-evidence/financial-statements-contract";
import type { FundamentalHistoryArtifact } from "../sources/extended-evidence/fundamental-history";
import type { FinancialLensArtifact } from "../sources/extended-evidence/financial-lens";
import type { CapitalOwnershipArtifact } from "../sources/extended-evidence/capital-ownership";
import type { SubsequentFinancingBridgeArtifact } from "../sources/extended-evidence/subsequent-financing";
import type { AnalystExpectationsArtifact } from "../sources/extended-evidence/analyst-expectations";
import type { InstitutionalOwnershipArtifact } from "../sources/extended-evidence/institutional-ownership";
import type { ValuationCompsArtifact } from "../sources/extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "../sources/extended-evidence/valuation-workbench-contract";
import type { ReverseDcfArtifact } from "../sources/extended-evidence/reverse-dcf";
import type { BusinessFrameworkArtifact } from "../sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../web-evidence/contract";

export interface DeepEquityEvidenceBundleV1 {
  readonly schemaVersion: 1;
  readonly run: {
    readonly symbol: string;
    readonly analysisAsOf: string;
    readonly identity?: InstrumentIdentity;
  };
  readonly evidence: {
    readonly marketSnapshots: readonly MarketSnapshot[];
    readonly supplementalMarketSnapshots: readonly MarketSnapshot[];
    readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
    readonly newsSources: readonly Source[];
    readonly extendedSources: readonly Source[];
    readonly extendedEvidence?: ExtendedEvidence;
    readonly webSubjectProfile?: WebSubjectProfileArtifact;
  };
  readonly derived: {
    readonly financialStatements?: FinancialStatementsArtifact;
    readonly fundamentalHistory?: FundamentalHistoryArtifact;
    readonly financialLenses?: FinancialLensArtifact;
    readonly capitalOwnership?: CapitalOwnershipArtifact;
    readonly subsequentFinancing?: SubsequentFinancingBridgeArtifact;
    readonly analystExpectations?: AnalystExpectationsArtifact;
    readonly institutionalOwnership?: InstitutionalOwnershipArtifact;
    readonly valuationComps?: ValuationCompsArtifact;
    readonly valuationWorkbench?: ValuationWorkbenchArtifact;
    readonly reverseDcf?: ReverseDcfArtifact;
    readonly earningsSetup?: EarningsSetupCollected;
    readonly businessFramework?: BusinessFrameworkArtifact;
  };
  readonly governance: {
    readonly sourceGaps: readonly SourceGap[];
    readonly sourcePlan: SourcePlanArtifact;
    readonly evidenceLanes: EvidenceLanesArtifact;
    readonly sourceLedger: SourceLedgerArtifact;
    readonly modelInputSanitization?: ModelInputSanitizationAggregate;
    readonly newsAnalytics?: NewsCollectionAnalytics;
  };
  readonly context: {
    readonly historicalContext: HistoricalResearchContext;
  };
}

export interface DeepEquityModelSource {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly fetchedAt: string;
  readonly kind: Source["kind"];
  readonly provider?: string;
  readonly publisher?: string;
  readonly symbol?: string;
  readonly sourceIds?: readonly string[];
  readonly text?: string;
}

export interface DeepEquityModelEvidenceItem extends Omit<ExtendedEvidenceItem, "summary"> {
  readonly text: string;
}

export interface DeepEquityModelPacket {
  readonly schemaVersion: 1;
  readonly run: DeepEquityEvidenceBundleV1["run"];
  readonly canonicalFacts: {
    readonly marketSnapshots: readonly MarketSnapshot[];
    readonly supplementalMarketSnapshots: readonly MarketSnapshot[];
    readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
    readonly financialStatements?: FinancialStatementsArtifact;
    readonly fundamentalHistory?: FundamentalHistoryArtifact;
  };
  readonly evidenceItems: readonly DeepEquityModelEvidenceItem[];
  readonly derivedViews: DeepEquityEvidenceBundleV1["derived"];
  readonly sources: readonly DeepEquityModelSource[];
  readonly gaps: readonly SourceGap[];
  readonly governance: {
    readonly sourcePlan: SourcePlanArtifact;
    readonly evidenceLanes: EvidenceLanesArtifact;
    readonly sourceLedger: SourceLedgerArtifact;
  };
  readonly historicalContext: HistoricalResearchContext;
}

export interface DeepEquityRunInput {
  readonly command: InstrumentCommand;
  readonly config: AppConfig;
  readonly now?: Date;
  readonly endClock?: () => Date;
}

export interface DeepEquityRunDependencies {
  readonly provider: ModelProvider;
  readonly collectSources?: (
    command: InstrumentCommand,
    sourceOptions: AppConfig["sourceOptions"],
    runtime: CollectSourcesRuntimeOptions,
  ) => Promise<CollectedSources>;
  readonly persistResearchJob?: (input: RunResearchJobInput) => Promise<PersistedResearchJobResult>;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
}

export interface DeepEquityRunResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly analytics: RunAnalytics;
  readonly stageOutputs: readonly StageOutput[];
  readonly evidenceBundle: DeepEquityEvidenceBundleV1;
  readonly modelPacket: DeepEquityModelPacket;
  readonly artifacts: RunArtifactPaths;
}
