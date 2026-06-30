import type { ForecastKindMix, ResolvedRunParams } from "../config/runs";
import type {
  EvidenceQualityAssessment,
  EvidenceRequestToolName,
  MarketRegimeSummary,
  WebGatherToolName,
} from "../domain/types";
import type { CalibrationSummary } from "../scoring/types";
import type { HistoricalResearchContext } from "./historical-context";
import type { MarketUpdateDelta } from "./market-update-delta";
import type { StagePlaybooks } from "./playbooks";
import type { ResolvedResearchSubject } from "./research-subject-identity";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./spotlights";
import type { BuildSourcePlanResult } from "./source-plan";

export interface DepthProfile {
  readonly depth: "brief" | "deep";
  readonly analystStyle: "concise brief" | "fuller analyst-style";
  readonly minimumKeyFindings: number;
  readonly minimumScenarios: number;
  /** Soft target for the prediction count, not a hard floor (ADR 0004). A run may
   * emit fewer when the evidence does not support a directional lean; the shortfall
   * is disclosed as a data gap rather than padded with coin-flip predictions. */
  readonly targetPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
  readonly targetKindMix: ForecastKindMix;
}

// Loaded from data/calibration/summary.json, which is written as a CalibrationSummary.
// All fields optional because the file is read from disk and may be absent or partial.
export type CalibrationContext = Partial<CalibrationSummary>;

export interface ResearchContext {
  readonly analysisAsOf?: string;
  readonly sourcePlanning?: BuildSourcePlanResult;
  readonly evidenceQualityAssessment?: EvidenceQualityAssessment;
  readonly depthProfile: DepthProfile;
  readonly runParams: ResolvedRunParams;
  readonly marketRegime: MarketRegimeSummary;
  readonly calibrationContext: CalibrationContext | undefined;
  readonly evidenceRequest?: EvidenceRequestContext;
  readonly webGather?: WebGatherContext;
  readonly domainPlaybooks?: readonly StagePlaybooks[];
  readonly historicalContext?: HistoricalResearchContext;
  readonly resolvedSubject?: ResolvedResearchSubject;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  // Carrier only — deterministic post-hoc delta, not added to the model evidence payload.
  readonly marketUpdateDelta?: MarketUpdateDelta;
}

export interface EvidenceRequestContext {
  readonly round: number;
  readonly availableTools: readonly EvidenceRequestToolName[];
  readonly toolUnits: Readonly<Record<EvidenceRequestToolName, number>>;
  readonly sourceUnitsUsed: number;
  readonly toolCallsUsed: number;
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
}

export interface WebGatherContext {
  readonly round: number;
  readonly availableTools: readonly WebGatherToolName[];
  readonly toolUnits: Readonly<Record<WebGatherToolName, number>>;
  readonly sourceUnitsUsed: number;
  readonly toolCallsUsed: number;
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
  readonly surfacedUrls: readonly string[];
  readonly subjectTerms: readonly string[];
}
