import { isMarketUpdateJobType } from "../domain/types";
import type { ResearchCommand } from "../cli/args";
import type { CollectedSources } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import type { PlaybookStage } from "./playbooks";
import type { ResearchContext } from "./research-context-types";

type AnalysisStage = Extract<
  StageOutput["stage"],
  | "specialist-analysis"
  | "regime-context-analysis"
  | "mover-theme-analysis"
  | "instrument-evidence-analysis"
  | "market-behavior-analysis"
  | "critique"
>;

interface AnalysisStageInput {
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly priorStages?: readonly StageOutput[];
}

export function coveragePanelStages(command: ResearchCommand): readonly AnalysisStage[] {
  if (command.depth !== "deep") {
    return [];
  }
  if (isMarketUpdateJobType(command.jobType)) {
    return ["regime-context-analysis", "mover-theme-analysis"];
  }
  return ["instrument-evidence-analysis", "market-behavior-analysis"];
}

export function plannedResearchStages(command: ResearchCommand): readonly PlaybookStage[] {
  return ["specialist-analysis", ...coveragePanelStages(command), "critique", "final-synthesis"];
}

export async function runAnalysisPhase(input: {
  readonly command: ResearchCommand;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly quickModel: string;
  readonly runStage: (
    stage: AnalysisStage,
    model: string,
    input: AnalysisStageInput,
  ) => Promise<StageOutput>;
}): Promise<{
  readonly analysisOutputs: readonly StageOutput[];
  readonly critiqueOutput: StageOutput;
}> {
  const specialistOutput = await input.runStage("specialist-analysis", input.quickModel, {
    collectedSources: input.collectedSources,
    context: input.context,
  });
  const panelOutputs = await Promise.all(
    coveragePanelStages(input.command).map((stage) =>
      input.runStage(stage, input.quickModel, {
        collectedSources: input.collectedSources,
        context: input.context,
        priorStages: [specialistOutput],
      }),
    ),
  );
  const analysisOutputs = [specialistOutput, ...panelOutputs];
  const critiqueOutput = await input.runStage("critique", input.quickModel, {
    collectedSources: input.collectedSources,
    context: input.context,
    priorStages: analysisOutputs,
  });
  return { analysisOutputs, critiqueOutput };
}
