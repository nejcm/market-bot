import { marketSpotlightOptions, type AppConfig } from "../config";
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
import type { CollectedSources, FetchLike } from "../sources/types";
import { recordSeenNewsSources } from "../sources/news-seen";
import { runEvidenceRequestLoop } from "./evidence-request-loop";
import {
  synthesizeReportUntilValid,
  type StageOutput,
  type StageReprompt,
} from "./final-synthesis";
import { addMarketContextToRegime, summarizeMarketRegime } from "./regime";
import { loadStagePrompt } from "./prompt-loader";
import { buildRunAnalytics, type RunAnalytics } from "./run-analytics";
import {
  createHistoricalContextReader,
  type HistoricalResearchContext,
} from "./historical-context";
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
  buildSpotlightSelectionPrompt,
  buildStagePrompt,
  loadCalibrationContext,
  type ResearchContext,
} from "./research-context";
import { buildSourceList } from "./report-assembly";
import {
  buildSpotlightCandidates,
  loadAlphaWatchlistForSpotlights,
  parseSpotlightSelection,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";

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
  readonly analytics: RunAnalytics;
  readonly stageOutputs: readonly StageOutput[];
  readonly collectedSources: CollectedSources;
  readonly historicalContext: HistoricalResearchContext;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifacts;
}

const MAX_PREDICTION_REPROMPTS = 2;

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
  reprompt: StageReprompt = {},
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
          reprompt.predictionErrors ?? [],
          reprompt.reportValidationErrors ?? [],
          reprompt.allowedSourceIds ?? [],
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

function spotlightCap(command: ResearchCommand, config: AppConfig): number {
  const options = marketSpotlightOptions(config);
  return command.depth === "deep" ? options.deepLimit : options.briefLimit;
}

function emptySpotlightSelection(cap: number, candidateCount: number): SpotlightSelectionResult {
  return {
    selected: [],
    rejected: [],
    audit: {
      cap,
      candidateCount,
      selectedCount: 0,
      rejectedCount: 0,
      malformed: false,
    },
  };
}

async function runSpotlightSelection(
  input: RunResearchJobInput,
  collectedSources: CollectedSources,
  context: ResearchContext,
  candidates: readonly SpotlightCandidate[],
  cap: number,
): Promise<{
  readonly output?: StageOutput;
  readonly selection: SpotlightSelectionResult;
}> {
  if (cap <= 0 || candidates.length === 0) {
    return { selection: emptySpotlightSelection(cap, candidates.length) };
  }
  const loaded = await loadStagePrompt(
    "spotlight-selection",
    input.command,
    input.config.promptDir,
  );
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
        content: buildSpotlightSelectionPrompt(
          input.command,
          collectedSources,
          context,
          loaded,
          candidates,
          cap,
        ),
      },
    ],
  });
  return {
    output: {
      stage: "spotlight-selection",
      content: response.content,
      tokenEstimate: response.tokenEstimate,
      costEstimateUsd: response.costEstimateUsd,
    },
    selection: parseSpotlightSelection(response.content, candidates, cap),
  };
}

function refreshSpotlightSelection(
  selection: SpotlightSelectionResult,
  candidates: readonly SpotlightCandidate[],
): SpotlightSelectionResult {
  const candidateBySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
  return {
    ...(selection.rationale !== undefined ? { rationale: selection.rationale } : {}),
    selected: selection.selected.flatMap((item) => {
      const candidate = candidateBySymbol.get(item.symbol);
      return candidate === undefined ? [] : [{ ...item, candidate }];
    }),
    rejected: selection.rejected,
    audit: selection.audit,
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const completedAt = (): string =>
    input.now === undefined ? new Date().toISOString() : new Date(now.getTime() + 1).toISOString();
  const runId = createRunId(now);
  const calibrationContext = await loadCalibrationContext(input.config.dataDir);
  const runParams = resolveRunParams(input.command, input.config, input.runConfig);
  let { collectedSources } = input;
  let context: ResearchContext = {
    depthProfile: buildDepthProfileFromParams(input.command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(input.command.assetClass, collectedSources.marketSnapshots),
      collectedSources.marketContext,
    ),
    calibrationContext,
  };
  const historicalContextReader = await createHistoricalContextReader(input.config.dataDir);
  let historicalContext = await historicalContextReader.load({
    command: input.command,
    config: input.config,
    now,
  });
  context = { ...context, historicalContext };
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
  let spotlightCandidates: readonly SpotlightCandidate[] | undefined = undefined;
  let spotlightSelection: SpotlightSelectionResult | undefined = undefined;
  let spotlightOutput: StageOutput | undefined = undefined;
  if (isMarketUpdateJobType(input.command.jobType)) {
    const marketOnlyHistoricalContext = historicalContext;
    const currentMarketSymbols = [
      ...new Set(
        collectedSources.marketSnapshots
          .filter((snapshot) => snapshot.assetClass === input.command.assetClass)
          .map((snapshot) => snapshot.symbol.toUpperCase()),
      ),
    ];
    if (currentMarketSymbols.length > 0) {
      historicalContext = await historicalContextReader.load({
        command: input.command,
        config: input.config,
        now,
        spotlightSymbols: currentMarketSymbols,
      });
      context = { ...context, historicalContext };
    }
    const alpha = await loadAlphaWatchlistForSpotlights(input.config.dataDir);
    const cap = spotlightCap(input.command, input.config);
    spotlightCandidates = buildSpotlightCandidates({
      marketSnapshots: collectedSources.marketSnapshots.filter(
        (snapshot) => snapshot.assetClass === input.command.assetClass,
      ),
      historicalContext,
      ...(alpha.watchlist !== undefined ? { alphaWatchlist: alpha.watchlist } : {}),
    });
    const spotlight = await runSpotlightSelection(
      input,
      collectedSources,
      { ...context, spotlightCandidates },
      spotlightCandidates,
      cap,
    );
    spotlightSelection = spotlight.selection;
    spotlightOutput = spotlight.output;
    if (spotlightSelection.selected.length > 0) {
      historicalContext = await historicalContextReader.load({
        command: input.command,
        config: input.config,
        now,
        spotlightSymbols: spotlightSelection.selected.map((item) => item.symbol),
      });
      spotlightCandidates = buildSpotlightCandidates({
        marketSnapshots: collectedSources.marketSnapshots.filter(
          (snapshot) => snapshot.assetClass === input.command.assetClass,
        ),
        historicalContext,
        ...(alpha.watchlist !== undefined ? { alphaWatchlist: alpha.watchlist } : {}),
      });
      spotlightSelection = refreshSpotlightSelection(spotlightSelection, spotlightCandidates);
    } else {
      historicalContext = marketOnlyHistoricalContext;
    }
    context = {
      ...context,
      historicalContext,
      spotlightCandidates: spotlightSelection.selected.map((item) => item.candidate),
      spotlightSelection,
    };
  }
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
  const sources = buildSourceList(input.command, collectedSources, historicalContext);
  const knownSourceIds = new Set(sources.map((source) => source.id));

  const synthesis = await synthesizeReportUntilValid({
    runId,
    generatedAt,
    command: input.command,
    collectedSources,
    context: playbookContext,
    sources,
    knownSourceIds,
    priorStages: [...analysisOutputs, critiqueOutput],
    maxPredictionReprompts: MAX_PREDICTION_REPROMPTS,
    runFinalSynthesis: (priorStages, reprompt) =>
      runStage(
        "final-synthesis",
        runParams.synthesisModel,
        input,
        collectedSources,
        playbookContext,
        priorStages,
        reprompt,
      ),
  });
  const { report, predictionErrors, predictionRetryErrors, reportValidationErrors } = synthesis;
  const stageOutputs: readonly StageOutput[] = [
    ...evidenceLoop.stageOutputs,
    ...(spotlightOutput === undefined ? [] : [spotlightOutput]),
    playbookSelection.output,
    ...analysisOutputs,
    critiqueOutput,
    ...synthesis.stageOutputs,
  ];

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
    completedAt: completedAt(),
    sourceGaps: report.dataGaps,
    stages: ["source-collection", ...stageOutputs.map((output) => output.stage)],
    tokenEstimate: stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    costEstimateUsd: stageOutputs.reduce((total, output) => total + output.costEstimateUsd, 0),
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    historicalContext: historicalContext.audit,
    ...(spotlightSelection !== undefined ? { spotlightSelection: spotlightSelection.audit } : {}),
    domainPlaybooks: playbookSelection.audit,
    ...(predictionRetryErrors.length > 0 ? { predictionRetryErrors } : {}),
    ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
    ...(reportValidationErrors.length > 0 ? { reportValidationErrors } : {}),
  };
  const analytics = buildRunAnalytics({
    report,
    trace,
    collectedSources,
    stageOutputs,
    minimumPredictions: context.depthProfile.minimumPredictions,
  });

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
    analytics,
    stageOutputs,
    collectedSources,
    historicalContext,
    ...(spotlightCandidates !== undefined ? { spotlightCandidates } : {}),
    ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
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
    result.collectedSources.supplementalMarketSnapshots,
  );
  await writeJson(
    join(artifacts.normalizedDir, "news-sources.json"),
    result.collectedSources.newsSources,
  );
  await writeJson(
    join(artifacts.normalizedDir, "extended-sources.json"),
    result.collectedSources.extendedSources,
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
    result.collectedSources.sourceGaps,
  );
  await writeJson(
    join(artifacts.normalizedDir, "historical-context.json"),
    result.historicalContext,
  );
  if (isMarketUpdateJobType(input.command.jobType)) {
    await writeJson(
      join(artifacts.normalizedDir, "spotlight-candidates.json"),
      result.spotlightCandidates ?? [],
    );
    await writeJson(
      join(artifacts.normalizedDir, "spotlight-selection.json"),
      result.spotlightSelection ??
        emptySpotlightSelection(spotlightCap(input.command, input.config), 0),
    );
  }
  await writeJson(join(artifacts.runDir, "stages.json"), result.stageOutputs);
  await writeJson(join(artifacts.runDir, "analytics.json"), result.analytics);
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
