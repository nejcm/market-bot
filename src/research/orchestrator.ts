import type { AppConfig } from "../config";
import { readCodeVersion } from "../code-version";
import { dirtySourceHash } from "../reproducibility";
import { assessEvidenceQuality } from "./evidence-quality";
import { resolveRunParams, type ResolvedRunParams, type RunConfig } from "../config/runs";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { createRunId, prepareRunArtifacts, type RunArtifactPaths } from "../artifacts";
import {
  isMarketUpdateJobType,
  marketUpdateHorizonBucket,
  type Mover,
  type ResearchReport,
  type RunTrace,
} from "../domain/types";
import { buildResearchRunManifest, persistRunArtifactWrites } from "../run-artifact-writer";
import type { ModelProvider } from "../model/types";
import { sumKnownCosts, type CostPricing } from "../model/pricing";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { renderMarkdownReport } from "../report/markdown";
import type { CollectedSources, FetchLike } from "../sources/types";
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
import { buildForecastPersistence } from "./forecast-persistence";
import {
  eligiblePlaybookCandidates,
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  mandatoryPlaybookSelections,
  parsePlaybookSelection,
  playbookScopeWithSubjectKey,
  type PlaybookSelectionAudit,
  type PlaybookStage,
} from "./playbooks";
import { refreshCalibrationContext } from "./calibration-context";
import {
  buildPlaybookSelectionPrompt,
  buildStagePrompt,
  buildStageSteeringSegment,
} from "./prompts";
import { buildDepthProfileFromParams } from "./depth-profile";
import type { ResearchContext } from "./research-context-types";
import { buildSourceList } from "./report-assembly";
import { validateResearchReport } from "../report/schema";
import {
  runForecastDisagreement,
  type ForecastDisagreementArtifact,
  type ForecastDisagreementExtra,
} from "./forecast-disagreement";
import { reconcileEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { computeWebSourceUsage, runWebEvidencePhase } from "../web-evidence";
import {
  loadAlphaWatchlistForSpotlights,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";
import { runMarketUpdatePhase } from "./market-update-phase";
import { auditPostSynthesisReport } from "./post-synthesis-audit";
import { auditReportIntegrity } from "./report-integrity-audit";
import { normalizeCanonicalSourceGaps } from "./source-gap-normalization";
import { applyOfficialEarningsDateConfirmation } from "../sources/extended-evidence/earnings-date-confirmation";
import {
  assessSourcePlan,
  buildSourcePlan,
  type EvidenceLanesArtifact,
  type SourceLedgerArtifact,
  type SourcePlanArtifact,
  type SourcePlanArtifactV2,
} from "./source-plan";
import { normalizeResearchCommandDepth, resolveResearchSubject } from "./research-subject-identity";
import { plannedResearchStages, runAnalysisPhase } from "./analysis-phase";
import { buildRunTrace } from "./run-trace";
import { createSourceRequestContext } from "../sources/source-request";
import {
  runFinancialTableExtractionPhase,
  type FinancialTableExtractionPhaseResult,
} from "./financial-table-extraction-phase";
import type { FinancialTablePacket } from "../sources/extended-evidence/untagged-financial-tables-contract";
import { FINANCIAL_TABLE_SEMANTIC_FIELDS } from "../sources/extended-evidence/untagged-financial-table-validation";

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
  const loaded = await loadStagePrompt(stage, job.command, job.config.promptDir);
  const prompt = buildStagePrompt(stage, {
    command: job.command,
    collectedSources,
    config: job.config,
    context,
    loaded,
    priorStages,
    predictionRepromptErrors: reprompt.predictionErrors ?? [],
    reportValidationErrors: reprompt.reportValidationErrors ?? [],
    allowedSourceIds: reprompt.allowedSourceIds ?? [],
    ...(reprompt.predictionCompletion !== undefined
      ? { predictionCompletion: reprompt.predictionCompletion }
      : {}),
  });
  const startedAt = performance.now();
  const response = await job.provider.generate({
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
        content: prompt,
      },
    ],
  });
  const endedAt = performance.now();

  const steering = buildStageSteeringSegment(
    stage,
    job.command,
    collectedSources,
    context,
    reprompt.predictionErrors ?? [],
    reprompt.predictionCompletion,
  );

  return {
    stage,
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    durationMs: Math.max(endedAt - startedAt, Number.EPSILON),
    ...(response.costEstimateUsd !== undefined
      ? { costEstimateUsd: response.costEstimateUsd }
      : {}),
    ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
    ...(steering !== undefined ? { steering } : {}),
  };
}

async function runFinancialTableMappingStage(
  packet: FinancialTablePacket,
  filingReportDate: string,
  job: RunResearchJobInput,
  runParams: ResolvedRunParams,
): Promise<StageOutput & { readonly stage: "financial-table-mapping" }> {
  const loaded = await loadStagePrompt(
    "financial-table-mapping",
    job.command,
    job.config.promptDir,
  );
  const prompt = JSON.stringify({
    stage: "financial-table-mapping",
    instruction: loaded.instruction,
    goal: loaded.goal,
    filing: packet.source,
    filingReportDate,
    allowedFields: FINANCIAL_TABLE_SEMANTIC_FIELDS,
    tables: packet.tables.map((table) => ({
      id: table.id,
      sourceTableIndex: table.sourceTableIndex,
      context: table.context,
      ...(table.title !== undefined ? { title: table.title } : {}),
      ...(table.unitText !== undefined ? { unitText: table.unitText } : {}),
      ...(table.unitCellRef !== undefined ? { unitCellRef: table.unitCellRef } : {}),
      ...(table.inheritedHeaderRefs !== undefined
        ? { inheritedHeaderRefs: table.inheritedHeaderRefs }
        : {}),
      rows: table.rows.map((row) => ({
        rowIndex: row.rowIndex,
        cells: row.cells.map((cell) => ({
          ref: cell.ref,
          text: cell.text,
          headerRefs: cell.headerRefs,
        })),
      })),
    })),
  });
  const startedAt = performance.now();
  const response = await job.provider.generate({
    model: runParams.quickModel,
    ...(runParams.modelParams !== undefined ? { params: runParams.modelParams } : {}),
    responseFormat: "json",
    messages: [
      { role: "system", content: withUntrustedModelInputRule(loaded.system) },
      { role: "user", content: prompt },
    ],
  });
  const endedAt = performance.now();
  return {
    stage: "financial-table-mapping",
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    durationMs: Math.max(endedAt - startedAt, Number.EPSILON),
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
  const scope = playbookScopeWithSubjectKey(
    input.command,
    collectedSources.resolvedSubject?.subjectKey,
  );
  const candidates = eligiblePlaybookCandidates(scope, plannedStages, registry);
  const loaded = await loadStagePrompt("playbook-selection", input.command, input.config.promptDir);
  const prompt = buildPlaybookSelectionPrompt(
    input.command,
    collectedSources,
    context,
    loaded,
    plannedStages,
    candidates,
  );
  const startedAt = performance.now();
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
        content: prompt,
      },
    ],
  });
  const endedAt = performance.now();
  const audit = parsePlaybookSelection(
    response.content,
    candidates,
    mandatoryPlaybookSelections(scope, plannedStages, candidates, registry),
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
      durationMs: Math.max(endedAt - startedAt, Number.EPSILON),
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
  const command = normalizeResearchCommandDepth(input.command);
  const jobInput: RunResearchJobInput = command === input.command ? input : { ...input, command };
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const completedAt = (): string => (input.endClock?.() ?? new Date()).toISOString();
  const runId = createRunId(now);
  const calibrationContext = await refreshCalibrationContext(input.config.dataDir, now);
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
      summarizeMarketRegime(command.assetClass, collectedSources.marketSnapshots),
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
  const webEvidence = await runWebEvidencePhase({
    command,
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
  const { webGatherLoop, webSubjectProfile } = webEvidence;
  const marketUpdate = await runMarketUpdatePhase({
    command,
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
  const frozenSourcePlan = input.sourcePlan ?? buildSourcePlan(command, generatedAt);
  const sourcePlanning = assessSourcePlan(frozenSourcePlan, collectedSources, generatedAt);
  const evidenceQualityAssessment = assessEvidenceQuality(sourcePlanning, generatedAt);
  context = { ...context, sourcePlanning, evidenceQualityAssessment };
  const plannedStages = plannedResearchStages(command);
  const playbookSelection = await runPlaybookSelection(
    jobInput,
    collectedSources,
    context,
    plannedStages,
  );
  const playbookContext = playbookSelection.context;
  const { analysisOutputs, critiqueOutput } = await runAnalysisPhase({
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
  const sources = buildSourceList(command, collectedSources, historicalContext, generatedAt);
  const knownSourceIds = new Set(sources.map((source) => source.id));
  // Build the emission-time subject allowlist from the resolved run params.
  // Research runs use researchPredictionGate instead; pass undefined so no double-drop occurs.
  const allowedSubjects =
    command.jobType !== "research" ? new Set(runParams.predictionSubjects) : undefined;

  const synthesis = await synthesizeReportUntilValid({
    runId,
    generatedAt,
    command,
    collectedSources,
    context: playbookContext,
    sources,
    knownSourceIds,
    ...(allowedSubjects !== undefined ? { allowedSubjects } : {}),
    priorStages: [...analysisOutputs, critiqueOutput],
    maxPredictionReprompts: MAX_PREDICTION_REPROMPTS,
    runFinalSynthesis: (priorStages, reprompt) =>
      runModelStage("final-synthesis", runParams.synthesisModel, {
        job: jobInput,
        collectedSources,
        context: playbookContext,
        priorStages,
        ...(reprompt !== undefined ? { reprompt } : {}),
      }),
  });
  const postSynthesisWarnings = auditPostSynthesisReport(
    synthesis.report,
    computeWebSourceUsage(synthesis.report, collectedSources),
  );
  // Deterministic Report Integrity Audit: prune blocking violations from the
  // Schema-valid synthesis output before forecast disagreement so pruned
  // Predictions never reach challengers, persistence, or scoring.
  const integrityAudit = auditReportIntegrity(synthesis.report, evidenceQualityAssessment);
  const integrityReport = reconcileEarningsForecastTelemetry(integrityAudit.report);
  const forecastDisagreementPhase = await runForecastDisagreementPhase({
    jobInput,
    generatedAt,
    runParams,
    report: validateResearchReport(integrityReport),
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
    ...financialTableExtraction.stageOutputs,
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
    ...(costEstimateUsd !== undefined ? { costEstimateUsd } : {}),
    costPricing,
    collectedSources,
    ...(evidenceLoop.audit !== undefined ? { evidenceRequestLoop: evidenceLoop.audit } : {}),
    ...(webGatherLoop.audit !== undefined ? { webGatherLoop: webGatherLoop.audit } : {}),
    historicalContext,
    ...(spotlightSelection !== undefined ? { spotlightSelection } : {}),
    playbookAudit: playbookSelection.audit,
    predictionRetryErrors,
    predictionTrimWarnings,
    predictionCompletion,
    predictionErrors,
    reportValidationErrors,
    postSynthesisWarnings,
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
  const analytics = buildRunAnalytics({
    report,
    trace,
    collectedSources,
    stageOutputs,
    targetPredictions: context.depthProfile.targetPredictions,
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
  const command = normalizeResearchCommandDepth(input.command);
  const jobInput: RunResearchJobInput = command === input.command ? input : { ...input, command };
  const result = await runResearchJob(jobInput);
  const artifacts = await prepareRunArtifacts(input.config.dataDir, result.report.runId);
  await persistRunArtifactWrites(
    artifacts,
    buildResearchRunManifest(command, input.config, result),
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
