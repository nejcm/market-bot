import type { CollectedSources } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import {
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  type PlaybookSelectionAudit,
  type PlaybookStage,
} from "./playbooks";
import type { ResearchContext } from "./research-context-types";

export const SIMPLIFIED_DEEP_EQUITY_PLAYBOOKS = [
  {
    stage: "equity-analysis",
    playbookIds: ["instrument-evidence", "market-behavior"],
  },
  {
    stage: "critique",
    playbookIds: ["critique-discipline", "source-discipline"],
  },
  {
    stage: "final-synthesis",
    playbookIds: ["synthesis-discipline", "source-discipline"],
  },
] as const satisfies readonly {
  readonly stage: PlaybookStage;
  readonly playbookIds: readonly string[];
}[];

export function staticPlaybookAudit(): PlaybookSelectionAudit {
  return {
    selected: SIMPLIFIED_DEEP_EQUITY_PLAYBOOKS,
    rationale: "static deep-equity assignment",
    rejected: [],
  };
}

export async function loadSimplifiedDeepEquityPlaybookContext(
  promptDir: string,
  context: ResearchContext,
): Promise<ResearchContext> {
  const registry = await loadPlaybookRegistry(promptDir);
  // Registry eligibility is advisory for the dynamic-selection path only. Static deep-equity
  // Assignment resolves checked-in ids directly so source-discipline stays ineligible for legacy
  // Equity selection and cannot change legacy selector prompt bytes.
  const domainPlaybooks = await loadPlaybooksByStage(
    promptDir,
    registry,
    SIMPLIFIED_DEEP_EQUITY_PLAYBOOKS,
  );
  return { ...context, domainPlaybooks };
}

interface DeepEquityReasoningStageInput {
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly priorStages?: readonly StageOutput[];
}

export async function runDeepEquityReasoning(input: {
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly quickModel: string;
  readonly runStage: (
    stage: "equity-analysis" | "critique",
    model: string,
    input: DeepEquityReasoningStageInput,
  ) => Promise<StageOutput>;
}): Promise<{
  readonly analysisOutputs: readonly StageOutput[];
  readonly critiqueOutput: StageOutput;
}> {
  const equityAnalysisOutput = await input.runStage("equity-analysis", input.quickModel, {
    collectedSources: input.collectedSources,
    context: input.context,
  });
  const analysisOutputs = [equityAnalysisOutput];
  const critiqueOutput = await input.runStage("critique", input.quickModel, {
    collectedSources: input.collectedSources,
    context: input.context,
    priorStages: analysisOutputs,
  });
  return { analysisOutputs, critiqueOutput };
}
