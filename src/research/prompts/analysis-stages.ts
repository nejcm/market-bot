import type { StageLabel } from "../prompt-loader";
import { buildEvidencePayload } from "./evidence-payload";
import { assembleStagePrompt, stagePlaybooks, type StageInput } from "./stage-envelope";

// Prediction targets are withheld: shipped to analysis stages they invited off-DSL candidates.
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
  const {
    targetPredictions: _targetPredictions,
    predictionSubjects: _predictionSubjects,
    targetKindMix: _targetKindMix,
    ...depthProfile
  } = context.depthProfile;
  return assembleStagePrompt({
    stage,
    instruction: `${loaded.instruction}\n\nDo not emit predictions; final synthesis owns forecasts.`,
    stageGoal: loaded.goal,
    depthProfile,
    evidence: buildEvidencePayload(
      { includePriorCalibration: false, sourceGapView: "all", webSourceText: "metadata" },
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
