import { isMarketUpdateJobType } from "../domain/job-type";
import type { ResearchCommand } from "../cli/args";
import type { CollectedSources } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import type { PlaybookStage } from "./playbooks";
import type { ResearchContext } from "./research-context-types";

export type AnalysisStage = Extract<
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

function coveragePanelStages(command: ResearchCommand): readonly AnalysisStage[] {
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
  /** Eval-only stage ablation: downstream stages run on the surviving outputs. */
  readonly skipStage?: Exclude<AnalysisStage, "critique">;
  readonly runStage: (
    stage: AnalysisStage,
    model: string,
    input: AnalysisStageInput,
  ) => Promise<StageOutput>;
}): Promise<{
  readonly analysisOutputs: readonly StageOutput[];
  readonly critiqueOutput: StageOutput;
}> {
  const run = (stage: AnalysisStage, priorStages?: readonly StageOutput[]) =>
    input.runStage(stage, input.quickModel, {
      collectedSources: input.collectedSources,
      context: input.context,
      ...(priorStages === undefined ? {} : { priorStages }),
    });
  const specialistOutputs =
    input.skipStage === "specialist-analysis" ? [] : [await run("specialist-analysis")];
  const panelOutputs = await Promise.all(
    coveragePanelStages(input.command)
      .filter((stage) => stage !== input.skipStage)
      .map((stage) => run(stage, specialistOutputs)),
  );
  const analysisOutputs = [...specialistOutputs, ...panelOutputs];
  const critiqueOutput = await run("critique", analysisOutputs);
  return { analysisOutputs, critiqueOutput };
}
