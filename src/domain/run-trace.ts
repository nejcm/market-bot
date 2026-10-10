import type { EvidenceQualityAssessment } from "./evidence";
import type {
  EvidenceRequestLoopAudit,
  ModelInputSanitizationAggregate,
  WebEvidenceUtilization,
  WebGatherLoopAudit,
} from "./gather-audit";
import type { AssetClass, Depth, JobType, LegacyMarketUpdateJobType } from "./job-type";
import type { EarningsForecastTelemetry } from "./prediction";
import type { ReportIntegrity, ReportIntegrityAdvisoryCode } from "./report";
import type { SourceKind } from "./sources";

interface DomainPlaybookSelectionAudit {
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

type PostSynthesisAuditWarningCode =
  | "unsupported-numeric-claim"
  | "weak-evidence-posture-missing"
  | "fresh-web-unused"
  | "gap-shaped-claim-cited";

export interface PostSynthesisAuditWarning {
  readonly code: PostSynthesisAuditWarningCode;
  readonly location: string;
  readonly message: string;
  readonly sourceIds: readonly string[];
}

export interface RelocatedGapClaim {
  readonly location: string;
  readonly text: string;
}

interface RelocatedGapClaims {
  readonly count: number;
  readonly items: readonly RelocatedGapClaim[];
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

export type WebSourceSynthesisAdvisory = "fresh-web-preference" | "web-subject-profile-low-trust";

// Compact per-web-source record of what final synthesis was told about each accepted web source.
// Read-only telemetry: lets reviews attribute citation-ratio anomalies from artifacts alone. The
// Full steering text lives on the final-synthesis stage output's steering field; advisories here
// Name which of those blocks applied to this source.
export interface WebSourceSynthesisInput {
  readonly sourceId: string;
  readonly includedInContext: boolean;
  readonly modelVisibleText: "summary" | "snippet" | "none";
  readonly profileCovered: boolean;
  readonly advisories: readonly WebSourceSynthesisAdvisory[];
}

// Warn-only source-text telemetry keeps the analytics aggregate text-free.
// Trace items retain the matched phrase and field needed to diagnose attributed third-party wording.
export interface SourceTextResearchOnlySummary {
  readonly scannedCount: number;
  readonly flaggedCount: number;
  readonly flaggedByKind: Readonly<Partial<Record<SourceKind, number>>>;
  readonly flaggedByProvider: Readonly<Record<string, number>>;
}

export interface SourceTextResearchOnlyItem {
  readonly sourceId: string;
  readonly kind: SourceKind;
  readonly provider: string;
  readonly field: "title" | "summary" | "snippet";
  readonly match: string;
}

export interface SourceTextResearchOnlyAudit {
  readonly summary: SourceTextResearchOnlySummary;
  readonly items: readonly SourceTextResearchOnlyItem[];
}

export interface RunTrace {
  readonly schemaVersion?: 2;
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
  readonly reproducibility?: {
    readonly effectiveConfigHash: string;
    readonly dirtySourceHash?: string;
  };
  readonly evidenceQualityAssessment?: EvidenceQualityAssessment;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceGaps: readonly string[];
  readonly stages: readonly string[];
  readonly stageRecords?: readonly {
    readonly stage: string;
    readonly durationMs?: number;
    readonly attempt?: number;
    readonly repromptReason?: {
      readonly predictionErrors?: readonly string[];
      readonly reportValidationErrors?: readonly string[];
    };
  }[];
  readonly tokenEstimate: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: readonly {
    readonly source: string;
    readonly asOf: string;
  }[];
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
  readonly evidenceRequestLoop?: EvidenceRequestLoopAudit;
  readonly webGatherLoop?: WebGatherLoopAudit;
  readonly webEvidenceUtilization?: WebEvidenceUtilization;
  readonly webSourceSynthesisInputs?: readonly WebSourceSynthesisInput[];
  readonly sourceTextResearchOnly: SourceTextResearchOnlyAudit;
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
  /** Legacy artifacts only. */
  readonly predictionReplacementAttempted?: boolean;
  readonly predictionErrors?: readonly string[];
  readonly earningsForecasts?: EarningsForecastTelemetry;
  readonly reportValidationRetryErrors?: readonly string[];
  readonly relocatedGapClaims?: RelocatedGapClaims;
  readonly postSynthesisAudit?: {
    readonly warningCount: number;
    readonly warnings: readonly PostSynthesisAuditWarning[];
  };
  readonly reportIntegrityAudit?: {
    readonly reportIntegrity: ReportIntegrity;
    readonly researchQuality: ReportIntegrity;
    readonly prunedItemCount: number;
    readonly advisoryWarningCount: number;
    readonly advisories?: readonly {
      readonly code: ReportIntegrityAdvisoryCode;
      readonly location: string;
    }[];
    readonly pruned: readonly {
      readonly location: string;
      readonly text: string;
      readonly sourceIds: readonly string[];
    }[];
  };
  readonly sourcePlan?: {
    readonly plannedLaneCount: number;
    readonly coreLaneCount: number;
    readonly materialLaneCount: number;
    readonly supplementalLaneCount: number;
  };
  readonly evidenceLanes?: {
    readonly coveredLaneCount: number;
    readonly gapLaneCount: number;
    readonly coreGapLaneCount: number;
    readonly materialGapLaneCount: number;
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
