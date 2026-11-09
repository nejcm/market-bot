import type { RunArtifactPaths } from "../artifacts";
import type { ResearchCommand } from "../cli/job-registry";
import type { CodeVersion } from "../code-version";
import type { AppConfig } from "../config";
import type { RunConfig } from "../config/runs";
import type { DeepEquityEvidenceBundleV1 } from "../deep-equity/types";
import type { Mover } from "../domain/market-data";
import type { ResearchReport } from "../domain/report";
import type { RunTrace } from "../domain/run-trace";
import type { ModelProvider } from "../model/types";
import type { CollectedSources, FetchLike } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import type { ForecastDisagreementArtifact } from "./forecast-disagreement";
import type { HistoricalResearchContext } from "./historical-context";
import type { RunAnalytics } from "./run-analytics";
import type {
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
  SourcePlanArtifact,
  SourcePlanArtifactV2,
} from "./source-plan";
import type { SpotlightCandidate, SpotlightSelectionResult } from "./spotlights";
import type { WrittenSubsystemOutcome } from "./subsystem-outcomes";

export interface RunResearchJobInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly runConfig?: RunConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  // The frozen pre-collection Source Plan. Callers that run collection build it
  // Before the first source-provider I/O and pass it here; when omitted (tests,
  // Replays of pre-existing collected sources) the orchestrator derives the
  // Identical plan from the command, since plan contents never depend on
  // Collection outcomes.
  readonly sourcePlan?: SourcePlanArtifactV2;
  // Captured before collection so a checkout during a long run is not recorded.
  readonly codeVersion?: CodeVersion;
  readonly sourceStateHash?: string;
  readonly now?: Date;
  readonly endClock?: () => Date;
  readonly sourceFetchImpl?: FetchLike;
  readonly sourceRetryDelaysMs?: readonly number[];
}

export interface RunResearchJobResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly analytics: RunAnalytics;
  readonly outcomes: readonly WrittenSubsystemOutcome[];
  readonly stageOutputs: readonly StageOutput[];
  readonly collectedSources: CollectedSources;
  readonly historicalContext: HistoricalResearchContext;
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
  readonly forecastDisagreement?: ForecastDisagreementArtifact;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly marketUpdateMovers?: readonly Mover[];
  readonly deepEquityEvidenceBundle?: DeepEquityEvidenceBundleV1;
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifactPaths;
}
