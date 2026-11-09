import { publishRunArtifacts } from "../artifacts";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { ResolvedRunParams } from "../config/runs";
import { buildDeepEquityEvidenceBundle } from "../deep-equity/evidence";
import type { EvidenceQualityAssessment } from "../domain/evidence";
import type { Source } from "../domain/sources";
import type { LedgeredModelProvider } from "../model/call-ledger";
import { progress } from "../progress";
import { captureSynthesisInput } from "../replay/session";
import {
  buildFailedRunManifest,
  persistFailedRunArtifactWrites,
  type FailedRunManifestInput,
} from "../run-artifact-writer";
import type { CollectedSources } from "../sources/types";
import {
  isFinalSynthesisRejectedError,
  synthesizeReportUntilValid,
  type StageOutput,
  type SynthesizeReportUntilValidInput,
  type SynthesizeReportUntilValidResult,
} from "./final-synthesis";
import { finalizeSynthesis, PostSynthesisError } from "./finalize-synthesis";
import type { HistoricalResearchContext } from "./historical-context";
import { createPeerMedianAudit } from "./peer-median-audit";
import type { ResearchContext } from "./research-context-types";
import type { BuildSourcePlanResult } from "./source-plan";

export const MAX_PREDICTION_REPROMPTS = 2;

export interface SynthesisPhaseInput {
  readonly config: Pick<AppConfig, "dataDir" | "promptDir" | "sourceOptions">;
  readonly provider: LedgeredModelProvider;
  readonly runParams: ResolvedRunParams;
  readonly runId: string;
  readonly generatedAt: string;
  readonly completedAt: () => string;
  readonly command: ResearchCommand;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly sources: readonly Source[];
  readonly equityAnalysisCompleteness?: SynthesizeReportUntilValidInput["equityAnalysisCompleteness"];
  readonly priorStages: readonly StageOutput[];
  readonly historicalContext: HistoricalResearchContext;
  readonly sourcePlanning: BuildSourcePlanResult;
  readonly evidenceQualityAssessment: EvidenceQualityAssessment;
  readonly failedRunManifest: Pick<
    FailedRunManifestInput,
    | "stageOutputs"
    | "webGatherAudit"
    | "webGatherSkipCode"
    | "spotlightSelection"
    | "playbookAudit"
    | "codeVersion"
    | "sourceStateHash"
  >;
  readonly runFinalSynthesis: SynthesizeReportUntilValidInput["runFinalSynthesis"];
}

export async function runSynthesisPhase(input: SynthesisPhaseInput) {
  const { command, runId, generatedAt, provider, runParams, sourcePlanning } = input;
  let { collectedSources } = input;
  const persistFailedRun = async (
    failure: Pick<
      FailedRunManifestInput,
      | "phase"
      | "message"
      | "stack"
      | "reportValidationErrors"
      | "predictionErrors"
      | "totalCalls"
      | "reportRepairReprompts"
      | "payload"
      | "collectedSources"
    > & { readonly synthesisStageOutputs: readonly StageOutput[] },
  ): Promise<string | undefined> => {
    try {
      const { synthesisStageOutputs, ...details } = failure;
      progress("writing failed run artifacts");
      const artifacts = await publishRunArtifacts(input.config.dataDir, runId, (staged) =>
        persistFailedRunArtifactWrites(
          staged,
          buildFailedRunManifest({
            ...details,
            ...input.failedRunManifest,
            command,
            runId,
            generatedAt,
            failedAt: input.completedAt(),
            stageOutputs: [...input.failedRunManifest.stageOutputs, ...synthesisStageOutputs],
            modelCalls: provider.modelCalls(),
            historicalContext: input.historicalContext,
            sourcePlan: sourcePlanning.sourcePlan,
            evidenceLanes: sourcePlanning.evidenceLanes,
            sourceLedger: sourcePlanning.sourceLedger,
            evidenceQuality: input.evidenceQualityAssessment,
          }),
        ),
      );
      return artifacts.runDir;
    } catch (persistError: unknown) {
      try {
        process.stderr.write(
          `Failed to persist run diagnostics: ${persistError instanceof Error ? persistError.message : String(persistError)}\n`,
        );
      } catch {
        // The original error remains authoritative even if stderr is unavailable.
      }
      return undefined;
    }
  };

  const knownSourceIds = new Set(input.sources.map((source) => source.id));
  // Research runs use researchPredictionGate instead; pass undefined so no double-drop occurs.
  const allowedSubjects =
    command.jobType !== "research" ? new Set(runParams.predictionSubjects) : undefined;
  progress("final synthesis");
  let synthesis: SynthesizeReportUntilValidResult | undefined = undefined;
  try {
    const synthesisInput = {
      runId,
      generatedAt,
      command,
      collectedSources,
      context: input.context,
      sources: input.sources,
      knownSourceIds: [...knownSourceIds],
      ...(input.equityAnalysisCompleteness !== undefined
        ? { equityAnalysisCompleteness: input.equityAnalysisCompleteness }
        : {}),
      ...(allowedSubjects !== undefined ? { allowedSubjects: [...allowedSubjects] } : {}),
      priorStages: input.priorStages,
      maxPredictionReprompts: MAX_PREDICTION_REPROMPTS,
    };
    captureSynthesisInput({
      ...synthesisInput,
      settings: {
        sourceOptions: {
          equityMoverLimit: input.config.sourceOptions.equityMoverLimit,
          cryptoMoverLimit: input.config.sourceOptions.cryptoMoverLimit,
        },
      },
    });
    const { allowedSubjects: _savedSubjects, ...phaseInput } = synthesisInput;
    synthesis = await synthesizeReportUntilValid({
      ...phaseInput,
      knownSourceIds,
      ...(allowedSubjects !== undefined ? { allowedSubjects } : {}),
      runFinalSynthesis: input.runFinalSynthesis,
    });
  } catch (error: unknown) {
    if (!isFinalSynthesisRejectedError(error)) {
      throw error;
    }

    const runDir = await persistFailedRun({
      phase: "final-synthesis",
      message: error.message,
      reportValidationErrors: error.reportValidationErrors,
      predictionErrors: error.predictionErrors,
      totalCalls: error.totalCalls,
      reportRepairReprompts: error.reportRepairReprompts,
      payload: error.payload,
      collectedSources,
      synthesisStageOutputs: error.stageOutputs,
    });
    if (runDir !== undefined) {
      error.runDir = runDir;
    }
    throw error;
  }
  collectedSources = { ...collectedSources, sourceGaps: synthesis.sourceGaps };
  const acceptedSynthesis = synthesis;
  try {
    const deepEquityEvidenceBundle =
      isInstrumentCommand(command) && command.assetClass === "equity" && command.depth === "deep"
        ? buildDeepEquityEvidenceBundle({
            symbol: command.symbol,
            analysisAsOf: generatedAt,
            collectedSources,
            historicalContext: input.historicalContext,
            sourcePlan: sourcePlanning.sourcePlan,
            evidenceLanes: sourcePlanning.evidenceLanes,
            sourceLedger: sourcePlanning.sourceLedger,
          })
        : undefined;
    // Prune before forecast disagreement so pruned Predictions never reach challengers.
    const finalized = await finalizeSynthesis(
      acceptedSynthesis,
      collectedSources,
      input.evidenceQualityAssessment,
      createPeerMedianAudit({
        provider,
        model: runParams.quickModel,
        ...(runParams.quickModelParams === undefined ? {} : { params: runParams.quickModelParams }),
        command,
        ...(input.config.promptDir === undefined ? {} : { promptDir: input.config.promptDir }),
      }),
    );
    return {
      ...finalized,
      synthesis: acceptedSynthesis,
      collectedSources,
      deepEquityEvidenceBundle,
    };
  } catch (error: unknown) {
    const failure = new PostSynthesisError(error);
    const runDir = await persistFailedRun({
      phase: "post-synthesis",
      message: failure.message,
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      reportValidationErrors: acceptedSynthesis.reportValidationErrors,
      predictionErrors: acceptedSynthesis.predictionErrors,
      // The accepted synthesis report as assembled, before the integrity audit prunes it.
      payload: acceptedSynthesis.report,
      collectedSources,
      synthesisStageOutputs: acceptedSynthesis.stageOutputs,
    });
    if (runDir !== undefined) {
      failure.runDir = runDir;
    }
    throw failure;
  }
}
