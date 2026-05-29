import type { AppConfig } from "../config";
import { resolveRunParams, type RunConfig } from "../config/runs";
import type { ResearchCommand } from "../cli/args";
import { join } from "node:path";
import {
  createRunId,
  prepareRunArtifacts,
  type RunArtifacts,
  writeJson,
  writeRunOutputs,
} from "../artifacts";
import { isMarketUpdateJobType, type ResearchReport, type RunTrace } from "../domain/types";
import type { ModelProvider } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import { addMarketContextToRegime, summarizeMarketRegime } from "./regime";
import { loadStagePrompt } from "./prompt-loader";
import {
  buildDepthProfileFromParams,
  buildStagePrompt,
  loadCalibrationContext,
  type CollectedSources,
  type ResearchContext,
} from "./research-context";
import {
  assembleResearchReport,
  buildSourceList,
  parseModelPayload,
  readPredictions,
} from "./report-assembly";

export type { CollectedSources };

export interface RunResearchJobInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly runConfig?: RunConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  readonly now?: Date;
}

export interface RunResearchJobResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly stageOutputs: readonly StageOutput[];
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifacts;
}

interface StageOutput {
  readonly stage: "specialist-analysis" | "critique" | "final-synthesis";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

async function runStage(
  stage: StageOutput["stage"],
  model: string,
  input: RunResearchJobInput,
  context: ResearchContext,
  priorStages: readonly StageOutput[] = [],
  predictionRepromptErrors: readonly string[] = [],
): Promise<StageOutput> {
  const loaded = await loadStagePrompt(stage, input.command, input.config.promptDir);
  const response = await input.provider.generate({
    model,
    ...(context.runParams.modelParams !== undefined
      ? { params: context.runParams.modelParams }
      : {}),
    responseFormat: "json",
    messages: [
      {
        role: "system",
        content: loaded.system,
      },
      {
        role: "user",
        content: buildStagePrompt(
          stage,
          input.command,
          input.collectedSources,
          input.config,
          context,
          loaded,
          priorStages,
          predictionRepromptErrors,
        ),
      },
    ],
  });

  return {
    stage,
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    costEstimateUsd: response.costEstimateUsd,
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = createRunId(now);
  const calibrationContext = await loadCalibrationContext(input.config.dataDir);
  const runParams = resolveRunParams(input.command, input.config, input.runConfig);
  const context: ResearchContext = {
    depthProfile: buildDepthProfileFromParams(input.command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(input.command.assetClass, input.collectedSources.marketSnapshots),
      input.collectedSources.marketContext,
    ),
    calibrationContext,
  };
  const specialistOutput = await runStage(
    "specialist-analysis",
    runParams.quickModel,
    input,
    context,
  );
  const critiqueOutput = await runStage("critique", runParams.quickModel, input, context, [
    specialistOutput,
  ]);
  let finalOutput = await runStage("final-synthesis", runParams.synthesisModel, input, context, [
    specialistOutput,
    critiqueOutput,
  ]);

  const sources = buildSourceList(input.command, input.collectedSources);
  const knownSourceIds = new Set(sources.map((source) => source.id));

  let payload = parseModelPayload(finalOutput.content);
  let predResult = readPredictions(payload.predictions, knownSourceIds);
  const stageOutputsArr: StageOutput[] = [specialistOutput, critiqueOutput, finalOutput];

  if (predResult.predictions.length < context.depthProfile.minimumPredictions) {
    finalOutput = await runStage(
      "final-synthesis",
      runParams.synthesisModel,
      input,
      context,
      [specialistOutput, critiqueOutput],
      predResult.errors,
    );
    stageOutputsArr.push(finalOutput);
    payload = parseModelPayload(finalOutput.content);
    predResult = readPredictions(payload.predictions, knownSourceIds);
  }

  const predictionErrors = predResult.errors;
  const stageOutputs = stageOutputsArr as readonly StageOutput[];

  const report = assembleResearchReport({
    runId,
    generatedAt,
    command: input.command,
    payload,
    predResult,
    collectedSources: input.collectedSources,
    depthProfile: context.depthProfile,
    context,
    sources,
  });

  const trace: RunTrace = {
    runId,
    jobType: input.command.jobType,
    ...(isMarketUpdateJobType(input.command.jobType)
      ? { marketUpdateCadence: input.command.jobType }
      : {}),
    assetClass: input.command.assetClass,
    ...(input.command.jobType === "ticker" ? { symbol: input.command.symbol } : {}),
    depth: input.command.depth,
    provider: input.provider.name,
    quickModel: runParams.quickModel,
    synthesisModel: runParams.synthesisModel,
    startedAt: generatedAt,
    completedAt: new Date(now.getTime() + 1).toISOString(),
    sourceGaps: report.dataGaps,
    stages: ["source-collection", ...stageOutputs.map((output) => output.stage)],
    tokenEstimate: stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    costEstimateUsd: stageOutputs.reduce((total, output) => total + output.costEstimateUsd, 0),
    ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
  };

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
    stageOutputs,
  };
}

export async function persistResearchJob(
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  const result = await runResearchJob(input);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);

  await writeJson(join(artifacts.rawDir, "snapshots.json"), input.collectedSources.rawSnapshots);
  await writeJson(
    join(artifacts.normalizedDir, "market-snapshots.json"),
    input.collectedSources.marketSnapshots,
  );
  await writeJson(
    join(artifacts.normalizedDir, "news-sources.json"),
    input.collectedSources.newsSources,
  );
  await writeJson(
    join(artifacts.normalizedDir, "extended-sources.json"),
    input.collectedSources.extendedSources ?? [],
  );
  await writeJson(
    join(artifacts.normalizedDir, "extended-evidence.json"),
    input.collectedSources.extendedEvidence ?? null,
  );
  await writeJson(
    join(artifacts.normalizedDir, "market-context.json"),
    input.collectedSources.marketContext ?? null,
  );
  await writeJson(
    join(artifacts.normalizedDir, "source-gaps.json"),
    input.collectedSources.sourceGaps ?? [],
  );
  await writeJson(join(artifacts.runDir, "stages.json"), result.stageOutputs);
  await writeRunOutputs(artifacts, result.report, result.markdown, result.trace);

  return {
    ...result,
    artifacts,
  };
}
