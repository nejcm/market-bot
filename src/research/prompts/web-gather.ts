import { buildEvidencePayload } from "./evidence-payload";
import { assembleStagePrompt, type StageInput } from "./stage-envelope";

function webGatherShape(): Record<string, unknown> {
  return {
    requests: [
      {
        tool: "web_search",
        args: {
          query: "must mention run symbol or company name",
          searchType: "news|market|current-subject|background",
        },
        rationale: "string",
      },
      {
        tool: "web_fetch",
        args: { url: "search-result URL only" },
        rationale: "string",
      },
    ],
  };
}

export function buildWebGatherStagePrompt(input: StageInput): string {
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
    stage: "web-gather",
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
    requiredShape: webGatherShape(),
  });
}
