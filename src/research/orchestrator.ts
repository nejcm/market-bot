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
import type { FetchLike } from "../sources/types";
import { recordSeenNewsSources } from "../sources/news-seen";
import { runEvidenceRequestLoop } from "./evidence-request-loop";
import { addMarketContextToRegime, summarizeMarketRegime } from "./regime";
import { loadStagePrompt, type StageLabel } from "./prompt-loader";
import {
  eligiblePlaybookCandidates,
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  parsePlaybookSelection,
  type PlaybookSelectionAudit,
  type PlaybookStage,
} from "./playbooks";
import {
  buildPlaybookSelectionPrompt,
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
  readonly sourceFetchImpl?: FetchLike;
  readonly sourceRetryDelaysMs?: readonly number[];
}

export interface RunResearchJobResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly stageOutputs: readonly StageOutput[];
  readonly collectedSources: CollectedSources;
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifacts;
}

interface StageOutput {
  readonly stage: StageLabel;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
}

function coveragePanelStages(command: ResearchCommand): readonly PlaybookStage[] {
  if (command.depth !== "deep") {
    return [];
  }
  if (isMarketUpdateJobType(command.jobType)) {
    return ["regime-context-analysis", "mover-theme-analysis"];
  }
  return ["instrument-evidence-analysis", "market-behavior-analysis"];
}

function plannedResearchStages(command: ResearchCommand): readonly PlaybookStage[] {
  return ["specialist-analysis", ...coveragePanelStages(command), "critique", "final-synthesis"];
}

async function runStage(
  stage: StageOutput["stage"],
  model: string,
  input: RunResearchJobInput,
  collectedSources: CollectedSources,
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
          collectedSources,
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

async function runPlaybookSelection(
  input: RunResearchJobInput,
  collectedSources: CollectedSources,
  context: ResearchContext,
  plannedStages: readonly PlaybookStage[],
): Promise<{
  readonly output: StageOutput;
  readonly audit: PlaybookSelectionAudit;
  readonly context: ResearchContext;
}> {
  const registry = await loadPlaybookRegistry(input.config.promptDir);
  const candidates = eligiblePlaybookCandidates(input.command, plannedStages, registry);
  const loaded = await loadStagePrompt("playbook-selection", input.command, input.config.promptDir);
  const response = await input.provider.generate({
    model: context.runParams.quickModel,
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
        content: buildPlaybookSelectionPrompt(
          input.command,
          collectedSources,
          context,
          loaded,
          plannedStages,
          candidates,
        ),
      },
    ],
  });
  const audit = parsePlaybookSelection(response.content, candidates);
  const domainPlaybooks = await loadPlaybooksByStage(
    input.config.promptDir,
    registry,
    audit.selected,
  );

  return {
    output: {
      stage: "playbook-selection",
      content: response.content,
      tokenEstimate: response.tokenEstimate,
      costEstimateUsd: response.costEstimateUsd,
    },
    audit,
    context: { ...context, domainPlaybooks },
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const runId = createRunId(now);
  const calibrationContext = await loadCalibrationContext(input.config.dataDir);
  const runParams = resolveRunParams(input.command, input.config, input.runConfig);
  let { collectedSources } = input;
  const context: ResearchContext = {
    depthProfile: buildDepthProfileFromParams(input.command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(input.command.assetClass, collectedSources.marketSnapshots),
      collectedSources.marketContext,
    ),
    calibrationContext,
  };
  const evidenceLoop = await runEvidenceRequestLoop({
    command: input.command,
    config: input.config,
    collectedSources,
    context,
    now,
    ...(input.sourceFetchImpl !== undefined ? { fetchImpl: input.sourceFetchImpl } : {}),
    ...(input.sourceRetryDelaysMs !== undefined
      ? { retryDelaysMs: input.sourceRetryDelaysMs }
      : {}),
    generateRound: (currentSources, roundContext, priorStages) =>
      runStage(
        "evidence-request",
        runParams.quickModel,
        input,
        currentSources,
        roundContext,
        priorStages,
      ) as Promise<StageOutput & { readonly stage: "evidence-request" }>,
  });
  ({ collectedSources } = evidenceLoop);
  const plannedStages = plannedResearchStages(input.command);
  const playbookSelection = await runPlaybookSelection(
    input,
    collectedSources,
    context,
    plannedStages,
  );
  const playbookContext = playbookSelection.context;
  const specialistOutput = await runStage(
    "specialist-analysis",
    runParams.quickModel,
    input,
    collectedSources,
    playbookContext,
  );
  const panelOutputs = await Promise.all(
    coveragePanelStages(input.command).map((stage) =>
      runStage(stage, runParams.quickModel, input, collectedSources, playbookContext, [
        specialistOutput,
      ]),
    ),
  );
  const analysisOutputs = [specialistOutput, ...panelOutputs];
  const critiqueOutput = await runStage(
    "critique",
    runParams.quickModel,
    input,
    collectedSources,
    playbookContext,
    analysisOutputs,
  );
  let finalOutput = await runStage(
    "final-synthesis",
    runParams.synthesisModel,
    input,
    collectedSources,
    playbookContext,
    [...analysisOutputs, critiqueOutput],
  );

  const sources = buildSourceList(input.command, collectedSources);
  const knownSourceIds = new Set(sources.map((source) => source.id));

  let payload = parseModelPayload(finalOutput.content);
  let predResult = readPredictions(payload.predictions, knownSourceIds);
  const stageOutputsArr: StageOutput[] = [
    ...evidenceLoop.stageOutputs,
    playbookSelection.output,
    ...analysisOutputs,
    critiqueOutput,
    finalOutput,
  ];

  if (predResult.predictions.length < context.depthProfile.minimumPredictions) {
    finalOutput = await runStage(
      "final-synthesis",
      runParams.synthesisModel,
      input,
      collectedSources,
      playbookContext,
      [...analysisOutputs, critiqueOutput],
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
    collectedSources,
    depthProfile: playbookContext.depthProfile,
    context: playbookContext,
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
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    domainPlaybooks: playbookSelection.audit,
    ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
  };

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
    stageOutputs,
    collectedSources,
  };
}

export async function persistResearchJob(
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  const result = await runResearchJob(input);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);

  await writeJson(join(artifacts.rawDir, "snapshots.json"), result.collectedSources.rawSnapshots);
  await writeJson(
    join(artifacts.normalizedDir, "market-snapshots.json"),
    result.collectedSources.marketSnapshots,
  );
  await writeJson(
    join(artifacts.normalizedDir, "supplemental-market-snapshots.json"),
    result.collectedSources.supplementalMarketSnapshots ?? [],
  );
  await writeJson(
    join(artifacts.normalizedDir, "news-sources.json"),
    result.collectedSources.newsSources,
  );
  await writeJson(
    join(artifacts.normalizedDir, "extended-sources.json"),
    result.collectedSources.extendedSources ?? [],
  );
  await writeJson(
    join(artifacts.normalizedDir, "extended-evidence.json"),
    result.collectedSources.extendedEvidence ?? null,
  );
  await writeJson(
    join(artifacts.normalizedDir, "market-context.json"),
    result.collectedSources.marketContext ?? null,
  );
  await writeJson(
    join(artifacts.normalizedDir, "source-gaps.json"),
    result.collectedSources.sourceGaps ?? [],
  );
  await writeJson(join(artifacts.runDir, "stages.json"), result.stageOutputs);
  await writeRunOutputs(artifacts, result.report, result.markdown, result.trace);
  if (
    input.config.sourceOptions.newsSeenPath !== undefined &&
    input.config.sourceOptions.newsSeenRetentionDays !== undefined
  ) {
    await recordSeenNewsSources({
      path: input.config.sourceOptions.newsSeenPath,
      retentionDays: input.config.sourceOptions.newsSeenRetentionDays,
      command: input.command,
      runId: result.report.runId,
      seenAt: result.report.generatedAt,
      sources: result.report.sources,
    });
  }

  return {
    ...result,
    artifacts,
  };
}
