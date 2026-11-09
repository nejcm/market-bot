import { buildModelStageRequest } from "./model-stage-prompt";
import { replayValue } from "../replay/session";
import type { AppConfig } from "../config";
import { readCodeVersion, type CodeVersion } from "../code-version";
import { progress } from "../progress";
import { dirtySourceHash } from "../reproducibility";
import { assessEvidenceQuality } from "./evidence-quality";
import { resolveRunParams, type RunConfig } from "../config/runs";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { createRunId, publishRunArtifacts, type RunArtifactPaths } from "../artifacts";
import { isMarketUpdateJobType, marketUpdateHorizonBucket } from "../domain/job-type";
import { type MarketSnapshot, type Mover } from "../domain/market-data";
import { type ResearchReport } from "../domain/report";
import { type RunTrace } from "../domain/run-trace";
import { buildResearchRunManifest, persistRunArtifactWrites } from "../run-artifact-writer";
import type { ModelProvider } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import type { CollectedSources, FetchLike } from "../sources/types";
import { recordSeenNewsSources } from "../sources/news-seen";
import { mergeModelInputSanitization } from "../sources/model-input-sanitizer";
import { runEvidenceRequestLoop } from "./evidence-request-loop";
import type { StageOutput, StageReprompt } from "./final-synthesis";
import { addMarketContextToRegime, summarizeMarketRegime } from "./regime";
import { buildRunAnalytics, type RunAnalytics } from "./run-analytics";
import { isLedgered, ledgerTotals, withModelCallLedger } from "../model/call-ledger";
import {
  createHistoricalContextReader,
  type HistoricalResearchContext,
} from "./historical-context";
import { createSanitizedHistoricalContextReader } from "./historical-context-sanitization";
import { buildForecastPersistence } from "./forecast-persistence";
import type { PlaybookSelectionAudit } from "./playbooks";
import { refreshCalibrationContext } from "./calibration-context";
import { buildDepthProfileFromParams } from "./depth-profile";
import type { ResearchContext } from "./research-context-types";
import { buildSourceList } from "./report-assembly";
import type { ForecastDisagreementArtifact } from "./forecast-disagreement";
import { runWebEvidencePhase } from "../web-evidence";
import {
  loadAlphaWatchlistForSpotlights,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";
import { runMarketUpdatePhase } from "./market-update-phase";
import { normalizeCanonicalSourceGaps } from "./source-gap-normalization";
import {
  currentIncompleteStatements,
  deriveEquityAnalysisCompleteness,
  equityAnalysisCompletenessGaps,
  type EquityAnalysisCompletenessInput,
} from "../sources/extended-evidence/equity-analysis-completeness";
import {
  applyEarningsDateConflict,
  applyOfficialEarningsDateConfirmation,
} from "../sources/extended-evidence/earnings-date-confirmation";
import {
  assessSourcePlan,
  buildSourcePlan,
  type EvidenceLanesArtifact,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
  type SourcePlanArtifactV2,
} from "./source-plan";
import { normalizeResearchCommandDepth, resolveResearchSubject } from "./research-subject-identity";
import { plannedResearchStages, runAnalysisPhase, runPlaybookSelection } from "./analysis-phase";
import { runForecastDisagreementPhase } from "./forecast-disagreement-phase";
import { runSynthesisPhase } from "./synthesis-phase";
import { buildRunTrace } from "./run-trace";
import { buildSubsystemOutcomes, type WrittenSubsystemOutcome } from "./subsystem-outcomes";
import { createSourceRequestContext } from "../sources/source-request";
import {
  runFinancialTableExtractionPhase,
  runFinancialTableMappingStage,
  type FinancialTableExtractionPhaseResult,
} from "./financial-table-extraction-phase";
import type { DeepEquityEvidenceBundleV1 } from "../deep-equity/types";
import { listingCommand } from "../sources/identity-gate";
import { exchangeProfileFor } from "../domain/exchange-profile";
import {
  runIssuerReportMappingStage,
  runIssuerReportPhase,
  type IssuerReportPhaseResult,
} from "./issuer-report-figures";

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
  // Captured before collection so a checkout during a long run is not recorded.
  readonly codeVersion?: CodeVersion;
  readonly sourceStateHash?: string;
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
  readonly outcomes: readonly WrittenSubsystemOutcome[];
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
  readonly deepEquityEvidenceBundle?: DeepEquityEvidenceBundleV1;
}

export interface PersistedResearchJobResult extends RunResearchJobResult {
  readonly artifacts: RunArtifactPaths;
}

function matchingMarketSnapshot(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): MarketSnapshot | undefined {
  if (!isInstrumentCommand(command)) {
    return undefined;
  }
  const symbol = command.symbol.toUpperCase();
  return collectedSources.marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

// The constant job plus the per-stage evidence, context, prior stages, and reprompt.
interface ModelStageInput {
  readonly job: RunResearchJobInput;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly priorStages?: readonly StageOutput[];
  readonly reprompt?: StageReprompt;
}

async function runModelStage(
  stage: StageOutput["stage"],
  model: string,
  input: ModelStageInput,
): Promise<StageOutput> {
  const { job, collectedSources, context } = input;
  const priorStages = input.priorStages ?? [];
  const reprompt = input.reprompt ?? {};
  const { request, steering } = await buildModelStageRequest(stage, model, job.config.promptDir, {
    command: job.command,
    collectedSources,
    config: {
      sourceOptions: {
        equityMoverLimit: job.config.sourceOptions.equityMoverLimit,
        cryptoMoverLimit: job.config.sourceOptions.cryptoMoverLimit,
      },
    },
    context,
    priorStages,
    predictionRepromptErrors: reprompt.predictionErrors ?? [],
    reportValidationErrors: reprompt.reportValidationErrors ?? [],
    allowedSourceIds: reprompt.allowedSourceIds ?? [],
    ...(reprompt.sourceIdRepair === undefined ? {} : { sourceIdRepair: reprompt.sourceIdRepair }),
  });
  const round = (stage === "web-gather" ? context.webGather : context.evidenceRequest)?.round;
  const step =
    (stage === "web-gather" || stage === "evidence-request") && round !== undefined
      ? `round-${String(round)}`
      : undefined;
  progress(`stage ${stage} → ${model}`);
  const startedAt = performance.now();
  const response = await job.provider.generate(step === undefined ? request : { ...request, step });
  const endedAt = performance.now();
  progress(
    `stage ${stage} done in ${((endedAt - startedAt) / 1000).toFixed(1)}s (~${String(response.tokenEstimate)} tok)`,
  );

  return {
    stage,
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    usage: response.usage ?? "unknown",
    durationMs: Math.max(endedAt - startedAt, Number.EPSILON),
    ...(response.costEstimateUsd !== undefined
      ? { costEstimateUsd: response.costEstimateUsd }
      : {}),
    ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
    ...(steering !== undefined ? { steering } : {}),
  };
}

// The optional slice of CollectedSources the completeness derivation reads. Exact-optional
// Property types mean each field has to be spread conditionally rather than passed as undefined.
function equityCompletenessSources(
  collectedSources: CollectedSources,
): Partial<EquityAnalysisCompletenessInput> {
  return {
    ...(collectedSources.financialStatements !== undefined
      ? { financialStatements: collectedSources.financialStatements }
      : {}),
    ...(collectedSources.extendedEvidence !== undefined
      ? { extendedEvidence: collectedSources.extendedEvidence }
      : {}),
    ...(collectedSources.earningsSetup !== undefined
      ? { earningsSetup: collectedSources.earningsSetup }
      : {}),
    ...(collectedSources.analystExpectations !== undefined
      ? { analystExpectations: collectedSources.analystExpectations }
      : {}),
    ...(collectedSources.analystExpectationsSignal !== undefined
      ? { analystExpectationsSignal: collectedSources.analystExpectationsSignal }
      : {}),
    ...(collectedSources.institutionalOwnership !== undefined
      ? { institutionalOwnership: collectedSources.institutionalOwnership }
      : {}),
    ...(collectedSources.institutionalOwnershipSignal !== undefined
      ? { institutionalOwnershipSignal: collectedSources.institutionalOwnershipSignal }
      : {}),
    ...(collectedSources.capitalOwnership !== undefined
      ? { capitalOwnership: collectedSources.capitalOwnership }
      : {}),
  };
}

export async function runResearchJob(input: RunResearchJobInput): Promise<RunResearchJobResult> {
  const command = normalizeResearchCommandDepth(input.command);
  const provider = isLedgered(input.provider)
    ? input.provider
    : withModelCallLedger(input.provider);
  const jobInput: RunResearchJobInput = { ...input, command, provider };
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const completedAt = (): string => (input.endClock?.() ?? new Date()).toISOString();
  const runId = createRunId(now);
  const codeVersion = input.codeVersion ?? readCodeVersion();
  const sourceStateHash =
    input.codeVersion === undefined && codeVersion.dirty
      ? dirtySourceHash()
      : input.sourceStateHash;
  const calibrationContext = await replayValue("calibration", () =>
    refreshCalibrationContext(input.config.dataDir, now),
  );
  const runParams = resolveRunParams(command, input.config, input.runConfig);
  let { collectedSources } = input;
  const resolvedSubject = collectedSources.resolvedSubject ?? resolveResearchSubject(command);
  if (resolvedSubject !== undefined && collectedSources.resolvedSubject === undefined) {
    collectedSources = { ...collectedSources, resolvedSubject };
  }
  let context: ResearchContext = {
    analysisAsOf: generatedAt,
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    depthProfile: buildDepthProfileFromParams(command, runParams),
    runParams,
    marketRegime: addMarketContextToRegime(
      summarizeMarketRegime(
        command.assetClass,
        collectedSources.marketSnapshots,
        isInstrumentCommand(command) ? exchangeProfileFor(command.symbol)?.benchmark : undefined,
      ),
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
    isMarketUpdateJobType(command.jobType) && alpha.gap !== undefined ? [alpha.gap] : [];
  const initialHistoricalContext = await historicalContextReader.load({
    command,
    config: input.config,
    now,
    extraGaps: alphaGaps,
  });
  let historicalContext = initialHistoricalContext.context;
  context = { ...context, historicalContext };
  progress("evidence-request loop");
  const evidenceLoop = await runEvidenceRequestLoop({
    command,
    config: input.config,
    collectedSources,
    context,
    now,
    ...(input.sourceFetchImpl !== undefined ? { fetchImpl: input.sourceFetchImpl } : {}),
    ...(input.sourceRetryDelaysMs !== undefined
      ? { retryDelaysMs: input.sourceRetryDelaysMs }
      : {}),
    generateRound: (currentSources, roundContext, priorStages) =>
      runModelStage("evidence-request", runParams.quickModel, {
        job: jobInput,
        collectedSources: currentSources,
        context: roundContext,
        priorStages,
      }) as Promise<StageOutput & { readonly stage: "evidence-request" }>,
  });
  ({ collectedSources } = evidenceLoop);
  let financialTableExtraction: FinancialTableExtractionPhaseResult = {
    collectedSources,
    stageOutputs: [],
  };
  if (
    isInstrumentCommand(command) &&
    command.assetClass === "equity" &&
    collectedSources.financialStatements?.structuredFinancialGaps.some(
      (gap) => gap.code === "untagged-6-k",
    ) === true
  ) {
    const requestContext = createSourceRequestContext(
      input.config.sourceOptions,
      now,
      input.sourceFetchImpl ?? fetch,
      input.sourceRetryDelaysMs,
    );
    progress("financial-table extraction");
    financialTableExtraction = await runFinancialTableExtractionPhase({
      symbol: command.symbol,
      generatedAt,
      collectedSources,
      collect: {
        request: requestContext.request,
        ...(input.config.sourceOptions.secUserAgent !== undefined
          ? { secUserAgent: input.config.sourceOptions.secUserAgent }
          : {}),
      },
      generateMapping: (packet, filingReportDate) =>
        runFinancialTableMappingStage(packet, filingReportDate, jobInput, runParams),
    });
    collectedSources = {
      ...financialTableExtraction.collectedSources,
      sourceGaps: [
        ...financialTableExtraction.collectedSources.sourceGaps,
        ...requestContext.staleFallbackGaps,
      ],
    };
  }
  progress("web-evidence phase");
  const webEvidence = await runWebEvidencePhase({
    command,
    config: input.config,
    collectedSources,
    context,
    generatedAt,
    runId,
    now,
    ...(input.sourceFetchImpl !== undefined ? { fetchImpl: input.sourceFetchImpl } : {}),
    ...(input.sourceRetryDelaysMs !== undefined
      ? { retryDelaysMs: input.sourceRetryDelaysMs }
      : {}),
    generateStage: (stage, currentSources, stageContext, priorStages = []) =>
      runModelStage(stage, runParams.quickModel, {
        job: jobInput,
        collectedSources: currentSources,
        context: stageContext,
        priorStages,
      }),
  });
  ({ collectedSources } = webEvidence);
  collectedSources = applyOfficialEarningsDateConfirmation({
    collectedSources,
    analysisAsOf: generatedAt,
  });
  collectedSources = applyEarningsDateConflict({
    collectedSources,
    analysisAsOf: generatedAt,
  });
  const { webGatherLoop, webSubjectProfile, profileReuse } = webEvidence;
  let issuerReport: IssuerReportPhaseResult = { collectedSources, stageOutputs: [] };
  if (
    isInstrumentCommand(command) &&
    command.assetClass === "equity" &&
    exchangeProfileFor(command.symbol) !== undefined
  ) {
    progress("issuer-report phase");
    issuerReport = await runIssuerReportPhase({
      symbol: command.symbol,
      collectedSources,
      generateMapping: (packet) =>
        runIssuerReportMappingStage(packet, command.symbol, jobInput, runParams),
    });
    ({ collectedSources } = issuerReport);
  }
  progress("market-update phase");
  const marketUpdate = await runMarketUpdatePhase({
    command,
    config: input.config,
    provider,
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
  // Completeness is derived once, here, so its freshness gaps reach the model along with every
  // Other gap and report assembly re-uses the same verdict instead of relabelling after the fact.
  const equityAnalysisCompleteness =
    command.jobType === "equity"
      ? deriveEquityAnalysisCompleteness({
          // Collection's timestamp, not the run's: `reportingFreshness` was derived at
          // `analysisAsOf` (both are the collector's `fetchedAt`), and a run that starts before
          // UTC midnight and collects after it would otherwise put a filing deadline on one side
          // For the lens metrics and the other for the gaps.
          asOf: collectedSources.financialStatements?.analysisAsOf ?? generatedAt,
          assetClass: command.assetClass,
          ...(isInstrumentCommand(command) ? { symbol: command.symbol } : {}),
          ...equityCompletenessSources(collectedSources),
        })
      : undefined;
  if (equityAnalysisCompleteness !== undefined) {
    collectedSources = {
      ...collectedSources,
      sourceGaps: [
        ...collectedSources.sourceGaps,
        ...equityAnalysisCompletenessGaps(
          equityAnalysisCompleteness,
          collectedSources.reportingFreshness,
          isInstrumentCommand(command) ? command.symbol : undefined,
          currentIncompleteStatements(
            collectedSources.financialStatements,
            equityAnalysisCompleteness.asOf,
          ),
        ),
      ],
    };
  }
  // Final canonical source-gap boundary; later phases must not append gaps without re-normalizing.
  collectedSources = normalizeCanonicalSourceGaps(collectedSources);
  // The fallback plan must derive from checked-in subject resolution only, not
  // The collection-carried resolvedSubject, so it matches a pre-collection build.
  const frozenSourcePlan = input.sourcePlan ?? buildSourcePlan(command, generatedAt);
  const sourcePlanning = assessSourcePlan(frozenSourcePlan, collectedSources, generatedAt);
  const evidenceQualityAssessment = assessEvidenceQuality(sourcePlanning, generatedAt);
  context = { ...context, sourcePlanning, evidenceQualityAssessment };
  const sources = buildSourceList(command, collectedSources, historicalContext, generatedAt);
  const plannedStages = plannedResearchStages(command);
  const playbookSelection = await runPlaybookSelection(
    jobInput,
    collectedSources,
    context,
    plannedStages,
  );
  const playbookContext = playbookSelection.context;
  const playbookAudit: PlaybookSelectionAudit = playbookSelection.audit;
  progress(`analysis phase (${String(plannedStages.length)} planned stage(s))`);
  const reasoning = await runAnalysisPhase({
    command,
    collectedSources,
    context: playbookContext,
    quickModel: runParams.quickModel,
    runStage: (stage, model, stageInput) =>
      runModelStage(stage, model, {
        job: jobInput,
        collectedSources: stageInput.collectedSources,
        context: stageInput.context,
        ...(stageInput.priorStages !== undefined ? { priorStages: stageInput.priorStages } : {}),
      }),
  });
  const { analysisOutputs, critiqueOutput } = reasoning;
  const preSynthesisStageOutputs: readonly StageOutput[] = [
    ...evidenceLoop.stageOutputs,
    ...financialTableExtraction.stageOutputs,
    ...webGatherLoop.stageOutputs,
    ...(webSubjectProfile?.output === undefined ? [] : [webSubjectProfile.output]),
    ...issuerReport.stageOutputs,
    ...(spotlightOutput === undefined ? [] : [spotlightOutput]),
    ...analysisOutputs,
    critiqueOutput,
  ];
  const synthesisPhase = await runSynthesisPhase({
    config: input.config,
    provider,
    runParams,
    runId,
    generatedAt,
    completedAt,
    command,
    collectedSources,
    context: playbookContext,
    sources,
    ...(equityAnalysisCompleteness !== undefined ? { equityAnalysisCompleteness } : {}),
    priorStages: [...analysisOutputs, critiqueOutput],
    historicalContext,
    sourcePlanning,
    evidenceQualityAssessment,
    failedRunManifest: {
      stageOutputs: preSynthesisStageOutputs,
      ...(webGatherLoop.audit !== undefined ? { webGatherAudit: webGatherLoop.audit } : {}),
      ...(webGatherLoop.skipCode !== undefined
        ? { webGatherSkipCode: webGatherLoop.skipCode }
        : {}),
      ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
      playbookAudit,
      codeVersion,
      ...(sourceStateHash !== undefined ? { sourceStateHash } : {}),
    },
    runFinalSynthesis: (priorStages, reprompt) =>
      runModelStage("final-synthesis", runParams.synthesisModel, {
        job: jobInput,
        collectedSources,
        context: playbookContext,
        priorStages,
        ...(reprompt !== undefined ? { reprompt } : {}),
      }),
  });
  const {
    synthesis,
    report: integrityReport,
    postSynthesisWarnings,
    integrityAudit,
    peerMedianAuditOutput,
    deepEquityEvidenceBundle,
  } = synthesisPhase;
  ({ collectedSources } = synthesisPhase);
  progress("forecast-disagreement phase");
  const forecastDisagreementPhase = await runForecastDisagreementPhase({
    jobInput,
    generatedAt,
    runParams,
    report: integrityReport,
  });
  const {
    report,
    challengerModels,
    outcomeCode: forecastDisagreementOutcomeCode,
  } = forecastDisagreementPhase;
  const forecastDisagreement = forecastDisagreementPhase.artifact;
  const forecastDisagreementStageOutputs = forecastDisagreementPhase.stageOutputs;
  const configuredForecastDisagreementModels =
    input.config.forecastDisagreementOptions?.challengerModels ?? [];
  const {
    predictionErrors,
    predictionRetryErrors,
    predictionTrimWarnings,
    reportValidationErrors,
    relocatedGapClaims,
  } = synthesis;
  const stageOutputs: readonly StageOutput[] = [
    ...preSynthesisStageOutputs,
    ...synthesis.stageOutputs,
    ...(peerMedianAuditOutput === undefined ? [] : [peerMedianAuditOutput]),
    ...forecastDisagreementStageOutputs,
  ];
  // Ledger totals include calls with no stage output, such as peer-universe proposals.
  const { tokenEstimate, costEstimateUsd, costPricing } = ledgerTotals(provider.modelCalls());

  const trace = buildRunTrace({
    jobInput,
    runId,
    generatedAt,
    completedAt: completedAt(),
    runParams,
    codeVersion,
    ...(sourceStateHash !== undefined ? { sourceStateHash } : {}),
    evidenceQualityAssessment,
    report,
    stageOutputs,
    tokenEstimate,
    ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
    costPricing,
    collectedSources,
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    ...(webGatherLoop.audit !== undefined ? { webGatherLoop: webGatherLoop.audit } : {}),
    ...(profileReuse !== undefined ? { webSubjectProfileReuse: profileReuse } : {}),
    historicalContext,
    ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
    playbookAudit,
    predictionRetryErrors,
    predictionTrimWarnings,
    predictionErrors,
    reportValidationErrors,
    relocatedGapClaims,
    postSynthesisWarnings:
      forecastDisagreementPhase.warning === undefined
        ? postSynthesisWarnings
        : [...postSynthesisWarnings, forecastDisagreementPhase.warning],
    integrityAudit,
    sourcePlanning,
    configuredForecastDisagreementModels,
    challengerModels,
    ...(forecastDisagreement !== undefined ? { forecastDisagreement } : {}),
  });
  // Computed once the report is final (post integrity audit and forecast
  // Disagreement) so repetition telemetry reflects exactly what was emitted.
  const forecastPersistence = buildForecastPersistence({
    report,
    baseline: historicalContextReader.findForecastPersistenceBaseline(report),
  });
  const outcomes = buildSubsystemOutcomes({
    sourcePlan: sourcePlanning.sourcePlan,
    evidenceLanes: sourcePlanning.evidenceLanes,
    sourceGaps: collectedSources.sourceGaps,
    webSubjectProfilePresent: collectedSources.webSubjectProfile !== undefined,
    ...(collectedSources.webSubjectProfileReuse !== undefined
      ? { webSubjectProfileReuse: collectedSources.webSubjectProfileReuse }
      : {}),
    ...(webGatherLoop.audit !== undefined ? { webGatherAudit: webGatherLoop.audit } : {}),
    ...(webGatherLoop.skipCode !== undefined ? { webGatherSkipCode: webGatherLoop.skipCode } : {}),
    ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
    playbookAudit,
    ...(trace.reportIntegrityAudit !== undefined
      ? { reportIntegrityAudit: trace.reportIntegrityAudit }
      : {}),
    ...(trace.forecastDisagreement !== undefined
      ? { forecastDisagreement: trace.forecastDisagreement }
      : {}),
    forecastDisagreementCode: forecastDisagreementOutcomeCode,
  });
  const analytics = buildRunAnalytics({
    report,
    trace,
    collectedSources,
    stageOutputs,
    modelCalls: provider.modelCalls(),
    targetPredictions: context.depthProfile.targetPredictions,
    outcomes,
    sourcePlanSummary: sourcePlanning.evidenceLanes.summary,
    calibrationGuidanceKeys: {
      assetClass: command.assetClass,
      jobType: command.jobType,
      predictionHorizon: marketUpdateHorizonBucket(context.depthProfile.defaultPredictionHorizon),
      marketRegime: context.marketRegime.label,
    },
    ...(calibrationContext !== undefined ? { calibrationContext } : {}),
    ...(forecastPersistence !== undefined ? { forecastPersistence } : {}),
  });
  const marketSnapshot = matchingMarketSnapshot(command, collectedSources);

  return {
    report,
    markdown: renderMarkdownReport(report, marketSnapshot, collectedSources),
    trace,
    analytics,
    outcomes,
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
    ...(deepEquityEvidenceBundle !== undefined ? { deepEquityEvidenceBundle } : {}),
  };
}

export async function persistResearchJob(
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  const command = listingCommand(
    normalizeResearchCommandDepth(input.command),
    input.collectedSources.listingResolution,
  );
  const { sourcePlan, ...withoutPlan } = input;
  // A plan built for the typed code is rebuilt for the resolved listing.
  const keepPlan =
    input.collectedSources.listingResolution === undefined && sourcePlan !== undefined;
  const jobInput: RunResearchJobInput =
    command === input.command
      ? input
      : { ...withoutPlan, command, ...(keepPlan ? { sourcePlan } : {}) };
  const result = await runResearchJob(jobInput);
  progress("writing run artifacts");
  const artifacts = await publishRunArtifacts(input.config.dataDir, result.report.runId, (staged) =>
    persistRunArtifactWrites(staged, buildResearchRunManifest(command, input.config, result)),
  );

  if (
    input.config.sourceOptions.newsSeenPath !== undefined &&
    input.config.sourceOptions.newsSeenRetentionDays !== undefined
  ) {
    await recordSeenNewsSources({
      path: input.config.sourceOptions.newsSeenPath,
      retentionDays: input.config.sourceOptions.newsSeenRetentionDays,
      command,
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
