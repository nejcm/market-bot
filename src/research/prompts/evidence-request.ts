import { buildEvidencePayload } from "./evidence-payload";
import { assembleStagePrompt, type StageInput } from "./stage-envelope";

function evidenceRequestShape(): Record<string, unknown> {
  return {
    requests: [
      {
        tool: "tradier_iv_term_structure",
        args: { symbol: "run symbol only" },
        rationale: "string",
      },
    ],
  };
}

export function buildEvidenceRequestStagePrompt(input: StageInput): string {
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
    stage: "evidence-request",
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
    priorStages,
    predictionRepromptErrors,
    reportValidationErrors,
    requiredShape: evidenceRequestShape(),
  });
}
