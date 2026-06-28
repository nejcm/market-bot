import { marketSpotlightOptions, type AppConfig } from "../config";
import { readCodeVersion } from "../code-version";
import { dirtySourceHash, effectiveConfigHash } from "../reproducibility";
import { assessEvidenceQuality } from "./evidence-quality";
import { resolveRunParams, type ResolvedRunParams, type RunConfig } from "../config/runs";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { join } from "node:path";
import {
  createRunId,
  prepareRunArtifacts,
  type RunArtifactPaths,
  writeJson,
  writeRunOutputs,
} from "../artifacts";
import {
  isMarketUpdateJobType,
  marketUpdateHorizonBucketOf,
  type Mover,
  type ResearchReport,
  type RunTrace,
} from "../domain/types";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { rankMovers } from "../movers/ranking";
import { buildMarketUpdateDelta } from "./market-update-delta";
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
  mandatoryPlaybookSelections,
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
  moverLimitFor,
  type ResearchContext,
} from "./research-context";
import { buildSourceList } from "./report-assembly";
import { validateResearchReport } from "../report/schema";
import {
  runForecastDisagreement,
  type ForecastDisagreementArtifact,
  type ForecastDisagreementExtra,
} from "./forecast-disagreement";
import { isWebGatherLoopEnabled, runWebGatherLoop } from "./web-gather-loop";
import {
  buildWebSubjectProfileEvidence,
  buildWebSubjectProfileFailureEvidence,
  webSubjectProfileSubjectForCommand,
} from "../sources/extended-evidence/web-subject-profile";
import {
  attachReusableWebSubjectProfile,
  findReusableWebSubjectProfile,
  latestSecFilingDate,
} from "./web-subject-profile-reuse";
import { reconcileBusinessFramework } from "../sources/extended-evidence/business-framework-reconcile";
import {
  buildSpotlightCandidates,
  loadAlphaWatchlistForSpotlights,
  parseSpotlightSelection,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";
import { auditPostSynthesisReport } from "./post-synthesis-audit";
import {
  buildSourcePlan,
  type EvidenceLanesArtifact,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
} from "./source-plan";

export interface RunResearchJobInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly runConfig?: RunConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  readonly now?: Date;
  readonly endClock?: () => Date;
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
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
  readonly forecastDisagreement?: ForecastDisagreementArtifact;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly marketUpdateMovers?: readonly Mover[];
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifactPaths;
}

const MAX_PREDICTION_REPROMPTS = 2;

function forecastDisagreementModels(
  input: RunResearchJobInput,
  synthesisModel: string,
): readonly string[] {
  if (input.command.depth !== "deep") {
    return [];
  }
  return (input.config.forecastDisagreementOptions?.challengerModels ?? []).filter(
    (model) => model !== synthesisModel,
  );
}

function compactForecastDisagreementExtra(
  artifact: ForecastDisagreementArtifact,
): ForecastDisagreementExtra {
  return {
    version: artifact.version,
    generatedAt: artifact.generatedAt,
    participantCount: artifact.participantCount,
    successfulParticipantCount: artifact.successfulParticipantCount,
    errorCount: artifact.errorCount,
    predictions: artifact.predictions,
  };
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
  const audit = parsePlaybookSelection(
    response.content,
    candidates,
    mandatoryPlaybookSelections(input.command, plannedStages, candidates),
  );
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

function marketUpdateTraceFields(command: ResearchCommand): Partial<RunTrace> {
  const marketUpdateHorizonBucket = marketUpdateHorizonBucketOf(command);
  if (marketUpdateHorizonBucket === undefined) {
    return {};
  }
  if (command.jobType === "market-overview") {
    return {
      marketUpdateHorizonBucket,
      ...(command.legacyAlias !== undefined
        ? { legacyMarketUpdateAlias: command.legacyAlias }
        : {}),
    };
  }
  if (command.jobType === "daily" || command.jobType === "weekly") {
    return { marketUpdateHorizonBucket, marketUpdateCadence: command.jobType };
  }
  return {};
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

async function runWebSubjectProfileExtraction(input: {
  readonly jobInput: RunResearchJobInput;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly generatedAt: string;
  readonly runParams: ResolvedRunParams;
  readonly secFilingBasisDate?: string;
}): Promise<{
  readonly collectedSources: CollectedSources;
  readonly output?: StageOutput;
}> {
  const webSources = input.collectedSources.extendedSources.filter(
    (source) => source.kind === "web",
  );
  const subject = webSubjectProfileSubjectForCommand(input.jobInput.command);
  if (subject === undefined || webSources.length === 0) {
    return { collectedSources: input.collectedSources };
  }
  try {
    const output = (await runStage(
      "web-subject-profile",
      input.runParams.quickModel,
      input.jobInput,
      input.collectedSources,
      input.context,
    )) as StageOutput & { readonly stage: "web-subject-profile" };
    const result = buildWebSubjectProfileEvidence({
      command: input.jobInput.command,
      subject,
      generatedAt: input.generatedAt,
      modelContent: output.content,
      webSources,
      extendedEvidence: input.collectedSources.extendedEvidence,
      ...(subject.subjectKind === "company" && input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
    });
    return {
      collectedSources: {
        ...input.collectedSources,
        ...(result.extendedEvidence !== undefined
          ? { extendedEvidence: result.extendedEvidence }
          : {}),
        ...(result.artifact !== undefined ? { webSubjectProfile: result.artifact } : {}),
        sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
      },
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = buildWebSubjectProfileFailureEvidence({
      command: input.jobInput.command,
      subject,
      generatedAt: input.generatedAt,
      message: `Web Subject Profile stage failed (${message})`,
      cause: "malformed-response",
      extendedEvidence: input.collectedSources.extendedEvidence,
      ...(subject.subjectKind === "company" && input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
    });
    return {
      collectedSources: {
        ...input.collectedSources,
        ...(result.extendedEvidence !== undefined
          ? { extendedEvidence: result.extendedEvidence }
          : {}),
        ...(result.artifact !== undefined ? { webSubjectProfile: result.artifact } : {}),
        sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
      },
    };
  }
}

/**
 * Post-web evidence reconciliation: when a non-empty Web Subject Profile exists
 * alongside a Business Framework, reconcile GAP[0] if the profile carries cited
 * answers for howItMakesMoney/customers/purchaseRecurrence.
 *
 * Swaps the reconciled artifact and regenerated framework SourceGap onto
 * collectedSources. Postures and phase are never changed.
 *
 * @param {CollectedSources} collectedSources - The collected sources to reconcile.
 * @returns {CollectedSources} Updated collected sources with reconciled framework.
 */
export function reconcileBusinessFrameworkEvidence(
  collectedSources: CollectedSources,
): CollectedSources {
  const framework = collectedSources.businessFramework;
  const profile = collectedSources.webSubjectProfile;
  if (framework === undefined || profile === undefined || profile.sourceIds.length === 0) {
    return collectedSources;
  }
  const result = reconcileBusinessFramework(framework, profile);
  if (result.artifact === framework) {
    // No change — reconciliation was a no-op.
    return collectedSources;
  }
  /*
   * The collector writes the framework gap to both collectedSources.sourceGaps and
   * collectedSources.extendedEvidence.gaps, and extendedEvidence is projected wholesale
   * into the synthesis prompt. Swap the old gap for the regenerated one (or drop it) in
   * BOTH places so synthesis never sees a gap reconciliation already cleared.
   */
  const oldGapSource = "business-framework";
  const withoutOldGap = <T extends { readonly source: string }>(gaps: readonly T[]): readonly T[] =>
    gaps.filter((gap) => gap.source !== oldGapSource);
  const sourceGaps =
    result.sourceGap !== undefined
      ? [...withoutOldGap(collectedSources.sourceGaps), result.sourceGap]
      : withoutOldGap(collectedSources.sourceGaps);
  const extendedEvidence =
    collectedSources.extendedEvidence === undefined
      ? undefined
      : {
          ...collectedSources.extendedEvidence,
          gaps:
            result.sourceGap !== undefined
              ? [...withoutOldGap(collectedSources.extendedEvidence.gaps), result.sourceGap]
              : withoutOldGap(collectedSources.extendedEvidence.gaps),
        };
  return {
    ...collectedSources,
    businessFramework: result.artifact,
    sourceGaps,
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const completedAt = (): string => (input.endClock?.() ?? new Date()).toISOString();
  const runId = createRunId(now);
  const calibrationContext = await loadCalibrationContext(input.config.dataDir);
  const runParams = resolveRunParams(input.command, input.config, input.runConfig);
  let { collectedSources } = input;
  let context: ResearchContext = {
    analysisAsOf: generatedAt,
    depthProfile: buildDepthProfileFromParams(input.command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(input.command.assetClass, collectedSources.marketSnapshots),
      collectedSources.marketContext,
    ),
    calibrationContext,
  };
  const historicalContextReader = await createHistoricalContextReader(input.config.dataDir);
  // Read before the first historical-context load so an unreadable watchlist is
  // Surfaced as a cross-run gap (LoadHistoricalContextInput.extraGaps) on every
  // Load in this run, not dropped silently. Cheap (single-file read).
  const alpha = await loadAlphaWatchlistForSpotlights(input.config.dataDir);
  // The watchlist is only consumed for market-update spotlight enrichment, so its
  // Load failure is only a meaningful gap for market-update runs. Scoping it here
  // Keeps the signal out of ticker/alpha-search reports, which never enrich.
  const alphaGaps =
    isMarketUpdateJobType(input.command.jobType) && alpha.gap !== undefined ? [alpha.gap] : [];
  let historicalContext = await historicalContextReader.load({
    command: input.command,
    config: input.config,
    now,
    extraGaps: alphaGaps,
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
  const currentSecFilingDate = latestSecFilingDate(collectedSources.extendedEvidence);
  let webGatherLoop: Awaited<ReturnType<typeof runWebGatherLoop>> = {
    collectedSources,
    stageOutputs: [],
  };
  let webSubjectProfile: Awaited<ReturnType<typeof runWebSubjectProfileExtraction>> | undefined =
    undefined;
  if (isWebGatherLoopEnabled(input.command, input.config)) {
    const reusableWebSubjectProfile = await findReusableWebSubjectProfile({
      dataDir: input.config.dataDir,
      command: input.command,
      now,
      reuseDays: input.config.webProfileReuseDays,
      ...(currentSecFilingDate !== undefined ? { currentSecFilingDate } : {}),
    });
    if (reusableWebSubjectProfile !== undefined) {
      collectedSources = attachReusableWebSubjectProfile({
        command: input.command,
        collectedSources,
        reuse: reusableWebSubjectProfile,
      });
    } else {
      webGatherLoop = await runWebGatherLoop({
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
            "web-gather",
            runParams.quickModel,
            input,
            currentSources,
            roundContext,
            priorStages,
          ) as Promise<StageOutput & { readonly stage: "web-gather" }>,
      });
      ({ collectedSources } = webGatherLoop);
      webSubjectProfile = await runWebSubjectProfileExtraction({
        jobInput: input,
        collectedSources,
        context,
        generatedAt,
        runParams,
        ...(currentSecFilingDate !== undefined ? { secFilingBasisDate: currentSecFilingDate } : {}),
      });
      ({ collectedSources } = webSubjectProfile);
    }
    collectedSources = reconcileBusinessFrameworkEvidence(collectedSources);
  }
  let spotlightCandidates: readonly SpotlightCandidate[] | undefined = undefined;
  let spotlightSelection: SpotlightSelectionResult | undefined = undefined;
  let spotlightOutput: StageOutput | undefined = undefined;
  let marketUpdateMovers: readonly Mover[] | undefined = undefined;
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
        extraGaps: alphaGaps,
      });
      context = { ...context, historicalContext };
    }
    const cap = spotlightCap(input.command, input.config);
    const { candidateLimit } = marketSpotlightOptions(input.config);
    spotlightCandidates = buildSpotlightCandidates({
      marketSnapshots: collectedSources.marketSnapshots.filter(
        (snapshot) => snapshot.assetClass === input.command.assetClass,
      ),
      historicalContext,
      candidateLimit,
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
        extraGaps: alphaGaps,
      });
      spotlightCandidates = buildSpotlightCandidates({
        marketSnapshots: collectedSources.marketSnapshots.filter(
          (snapshot) => snapshot.assetClass === input.command.assetClass,
        ),
        historicalContext,
        candidateLimit,
        ...(alpha.watchlist !== undefined ? { alphaWatchlist: alpha.watchlist } : {}),
      });
      spotlightSelection = refreshSpotlightSelection(spotlightSelection, spotlightCandidates);
    } else {
      historicalContext = marketOnlyHistoricalContext;
    }
    marketUpdateMovers = rankMovers(
      collectedSources.marketSnapshots.filter(
        (snapshot) => snapshot.assetClass === input.command.assetClass,
      ),
      moverLimitFor(input.command, input.config),
    );
    const marketUpdateDelta = await buildMarketUpdateDelta({
      dataDir: input.config.dataDir,
      command: input.command,
      now,
      currentMovers: marketUpdateMovers,
      currentRegime: context.marketRegime,
      moverLimit: moverLimitFor(input.command, input.config),
    });
    context = {
      ...context,
      historicalContext,
      spotlightCandidates: spotlightSelection.selected.map((item) => item.candidate),
      spotlightSelection,
      marketUpdateDelta,
    };
  }
  const sourcePlanning = buildSourcePlan(input.command, collectedSources, generatedAt);
  const evidenceQualityAssessment = assessEvidenceQuality(sourcePlanning, generatedAt);
  context = { ...context, sourcePlanning, evidenceQualityAssessment };
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
  const sources = buildSourceList(input.command, collectedSources, historicalContext, generatedAt);
  const knownSourceIds = new Set(sources.map((source) => source.id));
  // Build the emission-time subject allowlist from the resolved run params.
  // Research runs use researchPredictionGate instead; pass undefined so no double-drop occurs.
  const allowedSubjects =
    input.command.jobType !== "research" ? new Set(runParams.predictionSubjects) : undefined;

  const synthesis = await synthesizeReportUntilValid({
    runId,
    generatedAt,
    command: input.command,
    collectedSources,
    context: playbookContext,
    sources,
    knownSourceIds,
    ...(allowedSubjects !== undefined ? { allowedSubjects } : {}),
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
  let { report } = synthesis;
  const postSynthesisWarnings = auditPostSynthesisReport(report);
  let forecastDisagreement: ForecastDisagreementArtifact | undefined = undefined;
  let forecastDisagreementStageOutputs: readonly StageOutput[] = [];
  const configuredForecastDisagreementModels =
    input.config.forecastDisagreementOptions?.challengerModels ?? [];
  const challengerModels = forecastDisagreementModels(input, runParams.synthesisModel);
  if (challengerModels.length > 0 && report.predictions.length > 0) {
    // The whole stage is optional, evidence-only, and must never fail the run.
    // Per-challenger errors are already non-fatal inside runForecastDisagreement.
    // This guard degrades prompt-load or unexpected stage failures into a data gap.
    // See ADR 0023 for the non-fatal contract.
    try {
      const loaded = await loadStagePrompt(
        "forecast-disagreement",
        input.command,
        input.config.promptDir,
      );
      const disagreement = await runForecastDisagreement({
        generatedAt,
        provider: input.provider,
        providerName: input.provider.name,
        baselineModel: runParams.synthesisModel,
        challengerModels,
        ...(runParams.modelParams !== undefined ? { modelParams: runParams.modelParams } : {}),
        loaded,
        report: {
          runId: report.runId,
          generatedAt: report.generatedAt,
          summary: report.summary,
          keyFindings: report.keyFindings,
          bullCase: report.bullCase,
          bearCase: report.bearCase,
          risks: report.risks,
          catalysts: report.catalysts,
          scenarios: report.scenarios,
          predictions: report.predictions,
        },
      });
      forecastDisagreement = disagreement.artifact;
      forecastDisagreementStageOutputs = disagreement.stageOutputs;
      report = validateResearchReport({
        ...report,
        dataGaps: [...report.dataGaps, ...disagreement.dataGaps],
        extras: {
          ...report.extras,
          forecastDisagreement: compactForecastDisagreementExtra(disagreement.artifact),
        },
      });
    } catch (error) {
      forecastDisagreement = undefined;
      forecastDisagreementStageOutputs = [];
      const message = error instanceof Error ? error.message : String(error);
      report = validateResearchReport({
        ...report,
        dataGaps: [
          ...report.dataGaps,
          `forecastDisagreement: stage failed (${message}); uncertainty signal unavailable`,
        ],
      });
    }
  } else if (challengerModels.length > 0 && report.predictions.length === 0) {
    report = validateResearchReport({
      ...report,
      dataGaps: [
        ...report.dataGaps,
        "forecastDisagreement: skipped because report emitted no predictions",
      ],
    });
  }
  const {
    predictionErrors,
    predictionRetryErrors,
    predictionTrimWarnings,
    predictionReplacementAttempted,
    reportValidationErrors,
  } = synthesis;
  const codeVersion = readCodeVersion();
  const sourceStateHash = codeVersion.dirty ? dirtySourceHash() : undefined;
  const stageOutputs: readonly StageOutput[] = [
    ...evidenceLoop.stageOutputs,
    ...webGatherLoop.stageOutputs,
    ...(webSubjectProfile?.output === undefined ? [] : [webSubjectProfile.output]),
    ...(spotlightOutput === undefined ? [] : [spotlightOutput]),
    playbookSelection.output,
    ...analysisOutputs,
    critiqueOutput,
    ...synthesis.stageOutputs,
    ...forecastDisagreementStageOutputs,
  ];

  const trace: RunTrace = {
    schemaVersion: 2,
    runId,
    jobType: input.command.jobType,
    ...marketUpdateTraceFields(input.command),
    assetClass: input.command.assetClass,
    ...(isInstrumentCommand(input.command) ? { symbol: input.command.symbol } : {}),
    depth: input.command.depth,
    provider: input.provider.name,
    codeVersion,
    reproducibility: {
      effectiveConfigHash: effectiveConfigHash(input.config),
      ...(sourceStateHash !== undefined ? { dirtySourceHash: sourceStateHash } : {}),
    },
    evidenceQualityAssessment,
    quickModel: runParams.quickModel,
    synthesisModel: runParams.synthesisModel,
    startedAt: generatedAt,
    completedAt: completedAt(),
    sourceGaps: report.dataGaps,
    stages: ["source-collection", ...stageOutputs.map((output) => output.stage)],
    tokenEstimate: stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    costEstimateUsd: stageOutputs.reduce((total, output) => total + output.costEstimateUsd, 0),
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    ...(webGatherLoop.audit !== undefined ? { webGatherLoop: webGatherLoop.audit } : {}),
    historicalContext: historicalContext.audit,
    ...(spotlightSelection !== undefined ? { spotlightSelection: spotlightSelection.audit } : {}),
    domainPlaybooks: playbookSelection.audit,
    ...(predictionRetryErrors.length > 0 ? { predictionRetryErrors } : {}),
    ...(predictionTrimWarnings.length > 0 ? { predictionTrimWarnings } : {}),
    ...(predictionReplacementAttempted ? { predictionReplacementAttempted } : {}),
    ...(predictionErrors.length > 0 ? { predictionErrors } : {}),
    ...(reportValidationErrors.length > 0
      ? { reportValidationRetryErrors: reportValidationErrors }
      : {}),
    ...(postSynthesisWarnings.length > 0
      ? {
          postSynthesisAudit: {
            warningCount: postSynthesisWarnings.length,
            warnings: postSynthesisWarnings,
          },
        }
      : {}),
    sourcePlan: {
      plannedLaneCount: sourcePlanning.evidenceLanes.summary.plannedLaneCount,
      coreLaneCount: sourcePlanning.evidenceLanes.summary.coreLaneCount ?? 0,
      materialLaneCount: sourcePlanning.evidenceLanes.summary.materialLaneCount ?? 0,
      supplementalLaneCount: sourcePlanning.evidenceLanes.summary.supplementalLaneCount ?? 0,
    },
    evidenceLanes: {
      coveredLaneCount: sourcePlanning.evidenceLanes.summary.coveredLaneCount,
      gapLaneCount: sourcePlanning.evidenceLanes.summary.gapLaneCount,
      coreGapLaneCount: sourcePlanning.evidenceLanes.summary.coreGapLaneCount ?? 0,
      materialGapLaneCount: sourcePlanning.evidenceLanes.summary.materialGapLaneCount ?? 0,
      sourceCount: sourcePlanning.evidenceLanes.summary.sourceCount,
      gapCount: sourcePlanning.evidenceLanes.summary.gapCount,
      coverageRatio: sourcePlanning.evidenceLanes.summary.coverageRatio,
    },
    ...(forecastDisagreement !== undefined
      ? {
          forecastDisagreement: {
            configuredModelCount: configuredForecastDisagreementModels.length,
            challengerModelCount: challengerModels.length,
            participantCount: forecastDisagreement.participantCount,
            successfulParticipantCount: forecastDisagreement.successfulParticipantCount,
            errorCount: forecastDisagreement.errorCount,
          },
        }
      : {}),
  };
  const analytics = buildRunAnalytics({
    report,
    trace,
    collectedSources,
    stageOutputs,
    targetPredictions: context.depthProfile.targetPredictions,
    sourcePlanSummary: sourcePlanning.evidenceLanes.summary,
    ...(calibrationContext !== undefined ? { calibrationContext } : {}),
  });

  return {
    report,
    markdown: renderMarkdownReport(report),
    trace,
    analytics,
    stageOutputs,
    collectedSources,
    historicalContext,
    sourcePlan: sourcePlanning.sourcePlan,
    evidenceLanes: sourcePlanning.evidenceLanes,
    sourceLedger: sourcePlanning.sourceLedger,
    ...(forecastDisagreement !== undefined ? { forecastDisagreement } : {}),
    ...(spotlightCandidates !== undefined ? { spotlightCandidates } : {}),
    ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
    ...(marketUpdateMovers !== undefined ? { marketUpdateMovers } : {}),
  };
}

export async function persistResearchJob(
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  const result = await runResearchJob(input);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);

  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.rawSnapshots),
    result.collectedSources.rawSnapshots,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.marketSnapshots),
    result.collectedSources.marketSnapshots,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.supplementalMarketSnapshots),
    result.collectedSources.supplementalMarketSnapshots,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.newsSources),
    result.collectedSources.newsSources,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.extendedSources),
    result.collectedSources.extendedSources,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.extendedEvidence),
    result.collectedSources.extendedEvidence ?? null,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.marketContext),
    result.collectedSources.marketContext ?? null,
  );
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.sourceGaps),
    result.collectedSources.sourceGaps,
  );
  await writeJson(join(artifacts.runDir, RUN_ARTIFACT_FILES.sourcePlan), result.sourcePlan);
  await writeJson(join(artifacts.runDir, RUN_ARTIFACT_FILES.evidenceLanes), result.evidenceLanes);
  await writeJson(join(artifacts.runDir, RUN_ARTIFACT_FILES.sourceLedger), result.sourceLedger);
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.historicalContext),
    result.historicalContext,
  );
  if (result.trace.webGatherLoop !== undefined) {
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.webGatherAudit),
      result.trace.webGatherLoop,
    );
  }
  // Verified Market Snapshot + Instrument Identity sidecars: ticker runs only (ADR 0019)
  if (isInstrumentCommand(input.command)) {
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.verifiedMarketSnapshot),
      result.collectedSources.verifiedMarketSnapshot ?? null,
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.instrumentIdentity),
      result.collectedSources.resolvedInstrumentIdentity ?? null,
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.valuationComps),
      result.collectedSources.valuationComps ?? null,
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.financialLenses),
      result.collectedSources.financialLenses ?? null,
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.businessFramework),
      result.collectedSources.businessFramework ?? null,
    );
  }
  await writeJson(
    join(artifacts.runDir, RUN_ARTIFACT_FILES.webSubjectProfile),
    result.collectedSources.webSubjectProfile ?? null,
  );
  if (isMarketUpdateJobType(input.command.jobType)) {
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.spotlightCandidates),
      result.spotlightCandidates ?? [],
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.spotlightSelection),
      result.spotlightSelection ??
        emptySpotlightSelection(spotlightCap(input.command, input.config), 0),
    );
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.movers),
      result.marketUpdateMovers ?? [],
    );
  }
  await writeJson(join(artifacts.runDir, RUN_ARTIFACT_FILES.stages), result.stageOutputs);
  await writeJson(join(artifacts.runDir, RUN_ARTIFACT_FILES.analytics), result.analytics);
  if (result.forecastDisagreement !== undefined) {
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.forecastDisagreement),
      result.forecastDisagreement,
    );
  }
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
