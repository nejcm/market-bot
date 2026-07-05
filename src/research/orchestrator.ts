import type { AppConfig } from "../config";
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
  marketUpdateHorizonBucket,
  marketUpdateMetadataOf,
  type Mover,
  type ResearchReport,
  type RunTrace,
} from "../domain/types";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import type { ModelProvider } from "../model/types";
import { sumKnownCosts, type CostPricing } from "../model/pricing";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { renderMarkdownReport } from "../report/markdown";
import type { CollectedSources, FetchLike } from "../sources/types";
import { compactOversizedRawSnapshots } from "../sources/raw-snapshots";
import { recordSeenNewsSources } from "../sources/news-seen";
import { mergeModelInputSanitization } from "../sources/model-input-sanitizer";
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
import { createSanitizedHistoricalContextReader } from "./historical-context-sanitization";
import {
  eligiblePlaybookCandidates,
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  mandatoryPlaybookSelections,
  parsePlaybookSelection,
  type PlaybookSelectionAudit,
  type PlaybookStage,
} from "./playbooks";
import { refreshCalibrationContext } from "./calibration-context";
import {
  buildPlaybookSelectionPrompt,
  buildDepthProfileFromParams,
  buildStagePrompt,
  type ResearchContext,
} from "./research-context";
import { buildSourceList } from "./report-assembly";
import { validateResearchReport } from "../report/schema";
import {
  runForecastDisagreement,
  type ForecastDisagreementArtifact,
  type ForecastDisagreementExtra,
} from "./forecast-disagreement";
import { runWebEvidencePhase } from "./web-evidence-phase";
import {
  loadAlphaWatchlistForSpotlights,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";
import { emptySpotlightSelectionFor, runMarketUpdatePhase } from "./market-update-phase";
import { auditPostSynthesisReport } from "./post-synthesis-audit";
import { auditReportIntegrity } from "./report-integrity-audit";
import { normalizeCanonicalSourceGaps } from "./source-gap-normalization";
import {
  assessSourcePlan,
  buildSourcePlan,
  type EvidenceLanesArtifact,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
  type SourcePlanArtifactV2,
} from "./source-plan";
import { resolveResearchSubject } from "./research-subject-identity";

export { reconcileBusinessFrameworkEvidence } from "./web-evidence-phase";

export interface RunResearchJobInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly runConfig?: RunConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  // The frozen pre-collection Source Plan. Callers that run collection build it
  // Before the first source-provider I/O and pass it here; when omitted (tests,
  // Replays of pre-existing collected sources) the orchestrator derives the
  // Identical plan from the command, since plan contents never depend on
  // Collection outcomes.
  readonly sourcePlan?: SourcePlanArtifactV2;
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
        content: withUntrustedModelInputRule(loaded.system),
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
          reprompt.predictionCompletion,
        ),
      },
    ],
  });

  return {
    stage,
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    ...(response.costEstimateUsd !== undefined
      ? { costEstimateUsd: response.costEstimateUsd }
      : {}),
    ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
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
        content: withUntrustedModelInputRule(loaded.system),
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
      ...(response.costEstimateUsd !== undefined
        ? { costEstimateUsd: response.costEstimateUsd }
        : {}),
      ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
    },
    audit,
    context: { ...context, domainPlaybooks },
  };
}

function stageCostPricing(stageOutputs: readonly StageOutput[]): readonly CostPricing[] {
  return [
    ...new Map(
      stageOutputs
        .flatMap((output) => (output.costPricing === undefined ? [] : [output.costPricing]))
        .map((pricing) => [`${pricing.source}\n${pricing.asOf}`, pricing]),
    ).values(),
  ];
}

function marketUpdateTraceFields(command: ResearchCommand): Partial<RunTrace> {
  return marketUpdateMetadataOf(command) ?? {};
}

async function runForecastDisagreementPhase(input: {
  readonly jobInput: RunResearchJobInput;
  readonly generatedAt: string;
  readonly runParams: ResolvedRunParams;
  readonly report: ResearchReport;
}): Promise<{
  readonly report: ResearchReport;
  readonly challengerModels: readonly string[];
  readonly stageOutputs: readonly StageOutput[];
  readonly artifact?: ForecastDisagreementArtifact;
}> {
  const challengerModels = forecastDisagreementModels(
    input.jobInput,
    input.runParams.synthesisModel,
  );
  let { report } = input;
  if (challengerModels.length > 0 && report.predictions.length > 0) {
    try {
      const loaded = await loadStagePrompt(
        "forecast-disagreement",
        input.jobInput.command,
        input.jobInput.config.promptDir,
      );
      const disagreement = await runForecastDisagreement({
        generatedAt: input.generatedAt,
        provider: input.jobInput.provider,
        providerName: input.jobInput.provider.name,
        baselineModel: input.runParams.synthesisModel,
        challengerModels,
        ...(input.runParams.modelParams !== undefined
          ? { modelParams: input.runParams.modelParams }
          : {}),
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
      report = validateResearchReport({
        ...report,
        dataGaps: [...report.dataGaps, ...disagreement.dataGaps],
        extras: {
          ...report.extras,
          forecastDisagreement: compactForecastDisagreementExtra(disagreement.artifact),
        },
      });
      return {
        report,
        challengerModels,
        stageOutputs: disagreement.stageOutputs,
        artifact: disagreement.artifact,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report = validateResearchReport({
        ...report,
        dataGaps: [
          ...report.dataGaps,
          `forecastDisagreement: stage failed (${message}); uncertainty signal unavailable`,
        ],
      });
    }
  } else if (challengerModels.length > 0) {
    report = validateResearchReport({
      ...report,
      dataGaps: [
        ...report.dataGaps,
        "forecastDisagreement: skipped because report emitted no predictions",
      ],
    });
  }
  return { report, challengerModels, stageOutputs: [] };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const completedAt = (): string => (input.endClock?.() ?? new Date()).toISOString();
  const runId = createRunId(now);
  const calibrationContext = await refreshCalibrationContext(input.config.dataDir, now);
  const runParams = resolveRunParams(input.command, input.config, input.runConfig);
  let { collectedSources } = input;
  const resolvedSubject = collectedSources.resolvedSubject ?? resolveResearchSubject(input.command);
  if (resolvedSubject !== undefined && collectedSources.resolvedSubject === undefined) {
    collectedSources = { ...collectedSources, resolvedSubject };
  }
  let context: ResearchContext = {
    analysisAsOf: generatedAt,
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    depthProfile: buildDepthProfileFromParams(input.command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(input.command.assetClass, collectedSources.marketSnapshots),
      collectedSources.marketContext,
    ),
    calibrationContext,
  };
  const historicalContextReader = createSanitizedHistoricalContextReader(
    await createHistoricalContextReader(input.config.dataDir),
  );
  // Read before the first historical-context load so an unreadable watchlist is
  // Surfaced as a cross-run gap (LoadHistoricalContextInput.extraGaps) on every
  // Load in this run, not dropped silently. Cheap (single-file read).
  const alpha = await loadAlphaWatchlistForSpotlights(input.config.dataDir);
  // The watchlist is only consumed for market-update spotlight enrichment, so its
  // Load failure is only a meaningful gap for market-update runs. Scoping it here
  // Keeps the signal out of ticker/alpha-search reports, which never enrich.
  const alphaGaps =
    isMarketUpdateJobType(input.command.jobType) && alpha.gap !== undefined ? [alpha.gap] : [];
  const initialHistoricalContext = await historicalContextReader.load({
    command: input.command,
    config: input.config,
    now,
    extraGaps: alphaGaps,
  });
  let historicalContext = initialHistoricalContext.context;
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
  const webEvidence = await runWebEvidencePhase({
    command: input.command,
    config: input.config,
    collectedSources,
    context,
    generatedAt,
    now,
    ...(input.sourceFetchImpl !== undefined ? { fetchImpl: input.sourceFetchImpl } : {}),
    ...(input.sourceRetryDelaysMs !== undefined
      ? { retryDelaysMs: input.sourceRetryDelaysMs }
      : {}),
    generateStage: (stage, currentSources, stageContext, priorStages = []) =>
      runStage(stage, runParams.quickModel, input, currentSources, stageContext, priorStages),
  });
  ({ collectedSources } = webEvidence);
  const { webGatherLoop, webSubjectProfile } = webEvidence;
  const marketUpdate = await runMarketUpdatePhase({
    command: input.command,
    config: input.config,
    provider: input.provider,
    collectedSources,
    context,
    historicalContext,
    historicalContextReader,
    alpha,
    alphaGaps,
    now,
  });
  ({ context, historicalContext } = marketUpdate);
  collectedSources = {
    ...collectedSources,
    modelInputSanitization: mergeModelInputSanitization(
      collectedSources.modelInputSanitization,
      initialHistoricalContext.modelInputSanitization,
      marketUpdate.modelInputSanitization,
    ),
  };
  const { spotlightCandidates, spotlightSelection, spotlightOutput, marketUpdateMovers } =
    marketUpdate;
  // Final canonical source-gap boundary; later phases must not append gaps without re-normalizing.
  collectedSources = normalizeCanonicalSourceGaps(collectedSources);
  // The fallback plan must derive from checked-in subject resolution only, not
  // The collection-carried resolvedSubject, so it matches a pre-collection build.
  const frozenSourcePlan = input.sourcePlan ?? buildSourcePlan(input.command, generatedAt);
  const sourcePlanning = assessSourcePlan(frozenSourcePlan, collectedSources, generatedAt);
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
  const postSynthesisWarnings = auditPostSynthesisReport(synthesis.report);
  // Deterministic Report Integrity Audit: prune blocking violations from the
  // Schema-valid synthesis output before forecast disagreement so pruned
  // Predictions never reach challengers, persistence, or scoring.
  const integrityAudit = auditReportIntegrity(synthesis.report);
  const forecastDisagreementPhase = await runForecastDisagreementPhase({
    jobInput: input,
    generatedAt,
    runParams,
    report: validateResearchReport(integrityAudit.report),
  });
  const { report, challengerModels } = forecastDisagreementPhase;
  const forecastDisagreement = forecastDisagreementPhase.artifact;
  const forecastDisagreementStageOutputs = forecastDisagreementPhase.stageOutputs;
  const configuredForecastDisagreementModels =
    input.config.forecastDisagreementOptions?.challengerModels ?? [];
  const {
    predictionErrors,
    predictionRetryErrors,
    predictionTrimWarnings,
    predictionCompletion,
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
  const costEstimateUsd = sumKnownCosts(stageOutputs.map((output) => output.costEstimateUsd));
  const costPricing = stageCostPricing(stageOutputs);

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
    stageRecords: stageOutputs.map((output) => ({
      stage: output.stage,
      ...(output.attempt !== undefined ? { attempt: output.attempt } : {}),
      ...(output.repromptReason !== undefined ? { repromptReason: output.repromptReason } : {}),
    })),
    tokenEstimate: stageOutputs.reduce((total, output) => total + output.tokenEstimate, 0),
    ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
    ...(costPricing.length > 0 ? { costPricing } : {}),
    modelInputSanitization: collectedSources.modelInputSanitization ?? { entries: [] },
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    ...(webGatherLoop.audit !== undefined ? { webGatherLoop: webGatherLoop.audit } : {}),
    historicalContext: historicalContext.audit,
    ...(spotlightSelection !== undefined ? { spotlightSelection: spotlightSelection.audit } : {}),
    domainPlaybooks: playbookSelection.audit,
    ...(predictionRetryErrors.length > 0 ? { predictionRetryErrors } : {}),
    ...(predictionTrimWarnings.length > 0 ? { predictionTrimWarnings } : {}),
    ...(predictionCompletion !== undefined ? { predictionCompletion } : {}),
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
    reportIntegrityAudit: {
      reportIntegrity: integrityAudit.reportIntegrity,
      researchQuality: integrityAudit.researchQuality,
      prunedItemCount: integrityAudit.prunedItemCount,
      advisoryWarningCount: integrityAudit.advisoryWarningCount,
      pruned: integrityAudit.pruned,
    },
    sourcePlan: {
      plannedLaneCount: sourcePlanning.evidenceLanes.summary.plannedLaneCount,
      coreLaneCount: sourcePlanning.evidenceLanes.summary.coreLaneCount,
      materialLaneCount: sourcePlanning.evidenceLanes.summary.materialLaneCount,
      supplementalLaneCount: sourcePlanning.evidenceLanes.summary.supplementalLaneCount,
    },
    evidenceLanes: {
      coveredLaneCount: sourcePlanning.evidenceLanes.summary.coveredLaneCount,
      gapLaneCount: sourcePlanning.evidenceLanes.summary.gapLaneCount,
      coreGapLaneCount: sourcePlanning.evidenceLanes.summary.coreGapLaneCount,
      materialGapLaneCount: sourcePlanning.evidenceLanes.summary.materialGapLaneCount,
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
    calibrationGuidanceKeys: {
      assetClass: input.command.assetClass,
      jobType: input.command.jobType,
      predictionHorizon: marketUpdateHorizonBucket(context.depthProfile.defaultPredictionHorizon),
      marketRegime: context.marketRegime.label,
    },
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
    compactOversizedRawSnapshots(result.collectedSources.rawSnapshots),
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
  if (input.command.jobType === "research") {
    await writeJson(
      join(artifacts.runDir, RUN_ARTIFACT_FILES.resolvedSubject),
      result.collectedSources.resolvedSubject ?? null,
    );
  }
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
      result.spotlightSelection ?? emptySpotlightSelectionFor(input.command, input.config),
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
