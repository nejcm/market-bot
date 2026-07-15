import type { ResearchCommand } from "../../cli/args";
import type { CollectedSources } from "../../sources/types";
import type { LoadedPrompt } from "../prompt-loader";
import type { ResearchContext } from "../research-context-types";
import type { SpotlightCandidate } from "../spotlights";
import { deterministicSourceGaps } from "../deterministic-gaps";
import {
  compactHistoricalContext,
  evidenceCategories,
  resolveAnalysisAsOf,
} from "./evidence-payload";
import { userSteeringField } from "./steering";

function spotlightSelectionShape(): Record<string, unknown> {
  return {
    rationale: "short string",
    selections: [
      { symbol: "ticker", rationale: "string", sourceIds: ["current-market-source-id"] },
    ],
  };
}

export function buildSpotlightSelectionPrompt(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  loaded: LoadedPrompt,
  candidates: readonly SpotlightCandidate[],
  cap: number,
): string {
  return JSON.stringify(
    {
      instruction: loaded.instruction,
      stage: "spotlight-selection",
      analysisAsOf: resolveAnalysisAsOf(context),
      stageGoal: loaded.goal,
      command,
      ...userSteeringField(command),
      depthProfile: context.depthProfile,
      selectionCap: cap,
      candidates,
      marketRegime: { label: context.marketRegime.label },
      historicalContext:
        context.historicalContext === undefined
          ? undefined
          : compactHistoricalContext(context.historicalContext),
      evidenceCategories: evidenceCategories(collectedSources, context),
      sourceGaps: deterministicSourceGaps(command, collectedSources),
      requiredShape: spotlightSelectionShape(),
    },
    undefined,
    2,
  );
}
