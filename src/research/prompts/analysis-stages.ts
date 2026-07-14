import type { StageLabel } from "../prompt-loader";
import { buildEvidencePayload } from "./evidence-payload";
import { assembleStagePrompt, stagePlaybooks, type StageInput } from "./stage-envelope";

// The seven generic-path analysis stages (specialist-analysis, regime-context-analysis,
// Mover-theme-analysis, instrument-evidence-analysis, market-behavior-analysis, critique,
// Forecast-disagreement) share one prompt assembly: the findings/dataGaps required shape,
// Bare-metadata web sources, and any domain playbooks attached to the stage.
export function buildAnalysisStagePrompt(stage: StageLabel, input: StageInput): string {
  const {
    command,
    collectedSources,
    config,
    context,
    loaded,
    priorStages = [],
    predictionRepromptErrors = [],
    reportValidationErrors = [],
  } = input;
  return assembleStagePrompt({
    stage,
    instruction: loaded.instruction,
    stageGoal: loaded.goal,
    depthProfile: context.depthProfile,
    evidence: buildEvidencePayload(
      { includePriorCalibration: false, webSourceText: "metadata" },
      command,
      collectedSources,
      config,
      context,
    ),
    playbooks: stagePlaybooks(stage, context),
    priorStages,
    predictionRepromptErrors,
    reportValidationErrors,
    requiredShape: {
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    },
  });
}
