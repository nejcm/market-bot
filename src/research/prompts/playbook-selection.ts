import type { ResearchCommand } from "../../cli/args";
import type { CollectedSources } from "../../sources/types";
import type { LoadedPrompt } from "../prompt-loader";
import type { PlaybookCandidate, PlaybookStage } from "../playbooks";
import type { ResearchContext } from "../research-context-types";
import { deterministicSourceGaps } from "../deterministic-gaps";
import { evidenceCategories, resolveAnalysisAsOf } from "./evidence-payload";

function playbookSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [{ stage: "stage label", playbookIds: ["playbook-id"] }],
  };
}

export function buildPlaybookSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  plannedStages: readonly PlaybookStage[],
  candidates: readonly PlaybookCandidate[],
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "playbook-selection",
      analysisAsOf: resolveAnalysisAsOf(context),
      stageGoal: loaded.goal,
      command,
      depthProfile: context.depthProfile,
      plannedStages,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: playbookSelectionShape(),
    },
    undefined,
    2,
  );
}
