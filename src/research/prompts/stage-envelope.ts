import type { AppConfig } from "../../config";
import type { ResearchCommand } from "../../cli/args";
import type { Prediction } from "../../domain/types";
import type { CollectedSources } from "../../sources/types";
import type { LoadedPrompt, StageLabel } from "../prompt-loader";
import type { LoadedPlaybook } from "../playbooks";
import type { DepthProfile, ResearchContext } from "../research-context-types";
import type { PredictionCompletionPrompt } from "./final-synthesis";

// Everything buildStagePrompt needs: the evidence payload plus the per-stage steering inputs.
export interface StageInput {
  readonly command: ResearchCommand;
  readonly collectedSources: CollectedSources;
  readonly config: AppConfig;
  readonly context: ResearchContext;
  readonly loaded: LoadedPrompt;
  readonly priorStages?: readonly unknown[];
  readonly predictionRepromptErrors?: readonly string[];
  readonly reportValidationErrors?: readonly string[];
  readonly allowedSourceIds?: readonly string[];
  // Only the final-synthesis stage honors this; every other stage ignores it. This narrows the
  // Pre-split builder, which rewrote instruction and stageGoal for any stage when it was set —
  // A combination no caller produces (only the prediction-completion pass sets it, and that
  // Pass always runs final-synthesis).
  readonly predictionCompletion?: PredictionCompletionPrompt;
}

// The domain playbooks attached to a stage, if any. Bespoke stages without playbook
// Support simply never call this; typed StagePlaybooks entries only carry PlaybookStage
// Labels, so non-playbook stages can never match.
export function stagePlaybooks(
  stage: StageLabel,
  context: ResearchContext,
): readonly LoadedPlaybook[] | undefined {
  return context.domainPlaybooks?.find((entry) => entry.stage === stage)?.playbooks;
}

// The per-stage parts assembled into one prompt string. Field order below is the emitted
// JSON key order and is part of the prompt byte-identity contract (tests/prompt-baseline);
// Presence rules mirror the pre-split builder exactly.
export interface StagePromptParts {
  readonly stage: StageLabel;
  readonly instruction: string;
  readonly stageGoal: string;
  readonly depthProfile: DepthProfile;
  readonly evidence: Record<string, unknown>;
  readonly playbooks?: readonly LoadedPlaybook[] | undefined;
  readonly priorStages: readonly unknown[];
  readonly reportDraft?: Record<string, unknown> | undefined;
  readonly predictionRepromptErrors: readonly string[];
  readonly predictionRepair?: { readonly instruction: string } | undefined;
  readonly predictionCompletion?:
    | {
        readonly requestedCount: number;
        readonly existingPredictions: readonly Prediction[];
      }
    | undefined;
  readonly allowedSourceIds?: readonly string[] | undefined;
  readonly sourceIdGuidance?: string | undefined;
  readonly postSynthesisAuditGuidance?: Record<string, string> | undefined;
  readonly reportValidationErrors: readonly string[];
  readonly reportLanguageRepair?: string | undefined;
  readonly requiredShape: Record<string, unknown>;
}

export function assembleStagePrompt(parts: StagePromptParts): string {
  return JSON.stringify(
    {
      instruction: parts.instruction,
      stage: parts.stage,
      stageGoal: parts.stageGoal,
      depthProfile: parts.depthProfile,
      evidence: parts.evidence,
      ...(parts.playbooks !== undefined && parts.playbooks.length > 0
        ? { domainPlaybooks: parts.playbooks }
        : {}),
      priorStages: parts.priorStages,
      ...(parts.reportDraft !== undefined ? { reportDraft: parts.reportDraft } : {}),
      ...(parts.predictionRepromptErrors.length > 0
        ? {
            predictionRepromptErrors: parts.predictionRepromptErrors,
            predictionRepair: parts.predictionRepair,
          }
        : {}),
      ...(parts.predictionCompletion !== undefined
        ? { predictionCompletion: parts.predictionCompletion }
        : {}),
      ...(parts.sourceIdGuidance !== undefined
        ? { allowedSourceIds: parts.allowedSourceIds, sourceIdGuidance: parts.sourceIdGuidance }
        : {}),
      ...(parts.postSynthesisAuditGuidance !== undefined
        ? { postSynthesisAuditGuidance: parts.postSynthesisAuditGuidance }
        : {}),
      ...(parts.reportValidationErrors.length > 0
        ? { reportValidationErrors: parts.reportValidationErrors }
        : {}),
      ...(parts.reportLanguageRepair !== undefined
        ? { reportLanguageRepair: parts.reportLanguageRepair }
        : {}),
      requiredShape: parts.requiredShape,
    },
    undefined,
    2,
  );
}
