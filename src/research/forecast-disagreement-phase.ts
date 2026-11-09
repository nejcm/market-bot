import type { ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { ResolvedRunParams } from "../config/runs";
import { type ResearchReport } from "../domain/report";
import { type PostSynthesisAuditWarning } from "../domain/run-trace";
import type { ModelProvider } from "../model/types";
import { validateResearchReport } from "../report/schema";
import type { StageOutput } from "./final-synthesis";
import {
  runForecastDisagreement,
  type ForecastDisagreementArtifact,
  type ForecastDisagreementExtra,
} from "./forecast-disagreement";
import { loadStagePrompt } from "./prompt-loader";
import type { ForecastDisagreementOutcomeCode } from "./subsystem-outcomes";

interface ForecastDisagreementJob {
  readonly command: ResearchCommand;
  readonly config: Pick<AppConfig, "promptDir" | "forecastDisagreementOptions">;
  readonly provider: ModelProvider;
}

function forecastDisagreementModels(
  input: ForecastDisagreementJob,
  synthesisModel: string,
): readonly string[] {
  if (input.command.depth !== "deep") {
    return [];
  }
  return (input.config.forecastDisagreementOptions?.challengerModels ?? []).filter(
    (model) => model !== synthesisModel,
  );
}

function compactForecastDisagreementExtra(
  artifact: ForecastDisagreementArtifact,
): ForecastDisagreementExtra {
  return {
    version: artifact.version,
    generatedAt: artifact.generatedAt,
    participantCount: artifact.participantCount,
    successfulParticipantCount: artifact.successfulParticipantCount,
    errorCount: artifact.errorCount,
    predictions: artifact.predictions,
  };
}

export async function runForecastDisagreementPhase(input: {
  readonly jobInput: ForecastDisagreementJob;
  readonly generatedAt: string;
  readonly runParams: ResolvedRunParams;
  readonly report: ResearchReport;
}): Promise<{
  readonly report: ResearchReport;
  readonly challengerModels: readonly string[];
  readonly stageOutputs: readonly StageOutput[];
  readonly artifact?: ForecastDisagreementArtifact;
  readonly outcomeCode: ForecastDisagreementOutcomeCode;
  readonly warning?: PostSynthesisAuditWarning;
}> {
  const challengerModels = forecastDisagreementModels(
    input.jobInput,
    input.runParams.synthesisModel,
  );
  let { report } = input;
  if (challengerModels.length > 0 && report.predictions.length > 0) {
    try {
      const loaded = await loadStagePrompt(
        "forecast-disagreement",
        input.jobInput.command,
        input.jobInput.config.promptDir,
      );
      const disagreement = await runForecastDisagreement({
        generatedAt: input.generatedAt,
        provider: input.jobInput.provider,
        providerName: input.jobInput.provider.name,
        baselineModel: input.runParams.synthesisModel,
        challengerModels,
        ...(input.runParams.synthesisModelParams !== undefined
          ? { modelParams: input.runParams.synthesisModelParams }
          : {}),
        loaded,
        report: {
          runId: report.runId,
          generatedAt: report.generatedAt,
          summary: report.summary,
          keyFindings: report.keyFindings,
          bullCase: report.bullCase,
          bearCase: report.bearCase,
          risks: report.risks,
          catalysts: report.catalysts,
          scenarios: report.scenarios,
          predictions: report.predictions,
        },
      });
      report = validateResearchReport({
        ...report,
        dataGaps: [...report.dataGaps, ...disagreement.dataGaps],
        extras: {
          ...report.extras,
          forecastDisagreement: compactForecastDisagreementExtra(disagreement.artifact),
        },
      });
      return {
        report,
        challengerModels,
        stageOutputs: disagreement.stageOutputs,
        artifact: disagreement.artifact,
        outcomeCode: "produced",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report = validateResearchReport({
        ...report,
        dataGaps: [
          ...report.dataGaps,
          "forecastDisagreement: stage failed, check did not run; uncertainty signal unavailable",
        ],
      });
      return {
        report,
        challengerModels,
        stageOutputs: [],
        outcomeCode: "failed",
        warning: {
          code: "forecast-disagreement-unavailable",
          location: "forecastDisagreement",
          message: `forecast-disagreement stage failed (${message})`,
          sourceIds: [],
        },
      };
    }
  } else if (challengerModels.length > 0) {
    report = validateResearchReport({
      ...report,
      dataGaps: [
        ...report.dataGaps,
        "forecastDisagreement: skipped because report emitted no predictions",
      ],
    });
  }
  return {
    report,
    challengerModels,
    stageOutputs: [],
    outcomeCode: challengerModels.length === 0 ? "not-configured" : "no-predictions",
  };
}
