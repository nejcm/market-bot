import type { StageLabel } from "../prompt-loader";
import { buildAnalysisStagePrompt } from "./analysis-stages";
import { buildEvidenceRequestStagePrompt } from "./evidence-request";
import { buildFinalSynthesisStagePrompt } from "./final-synthesis";
import type { StageInput } from "./stage-envelope";
import { buildWebGatherStagePrompt } from "./web-gather";
import { buildWebSubjectProfileStagePrompt } from "./web-subject-profile";

// This thin dispatcher routes the four bespoke-shape stages to their modules.
// The seven generic-path analysis stages share one assembly.
// Stage-specific logic lives in stage modules, never in shared segment modules.
export function buildStagePrompt(stage: StageLabel, input: StageInput): string {
  if (stage === "evidence-request") {
    return buildEvidenceRequestStagePrompt(input);
  }
  if (stage === "web-gather") {
    return buildWebGatherStagePrompt(input);
  }
  if (stage === "web-subject-profile") {
    return buildWebSubjectProfileStagePrompt(input);
  }
  if (stage === "final-synthesis") {
    return buildFinalSynthesisStagePrompt(input);
  }
  return buildAnalysisStagePrompt(stage, input);
}

export type { PredictionCompletionPrompt, StageInput } from "./stage-envelope";
export { buildStageSteeringSegment } from "./final-synthesis";
export { buildPlaybookSelectionPrompt } from "./playbook-selection";
export { buildSpotlightSelectionPrompt } from "./spotlight-selection";
export { buildWebSourceSynthesisInputs } from "./web-source-synthesis-inputs";
export { buildPredictionCoverage, type PredictionCoverage } from "./prediction-coverage";
