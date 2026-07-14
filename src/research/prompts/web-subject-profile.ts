import {
  subjectKindForCommand,
  webSubjectProfileRequiredShape,
} from "../../sources/extended-evidence/web-subject-profile";
import { buildEvidencePayload } from "./evidence-payload";
import { assembleStagePrompt, type StageInput } from "./stage-envelope";

export function buildWebSubjectProfileStagePrompt(input: StageInput): string {
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
    stage: "web-subject-profile",
    instruction: loaded.instruction,
    stageGoal: loaded.goal,
    depthProfile: context.depthProfile,
    evidence: buildEvidencePayload(
      { includePriorCalibration: false, webSourceText: "profile" },
      command,
      collectedSources,
      config,
      context,
    ),
    priorStages,
    predictionRepromptErrors,
    reportValidationErrors,
    requiredShape: webSubjectProfileRequiredShape(subjectKindForCommand(command) ?? "company"),
  });
}
