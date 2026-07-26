import { isInstrumentCommand } from "../../cli/args";
import type { DeepEquityModelPacket } from "../../deep-equity/types";
import type { Source } from "../../domain/types";
import { subjectKindForCommand } from "../../web-evidence";
import { buildCalibrationBlock } from "../calibration-context";
import {
  buildMarketForecastErrorBlock,
  buildPriorThesisErrorBlock,
  buildResearchForecastErrorBlock,
} from "../prior-forecast-errors";
import {
  verifiedSnapshotCitationRule,
  verifiedSnapshotSourceId,
} from "../verified-snapshot-contract";
import { FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE } from "./source-id-guidance";
import {
  assembleStagePrompt,
  stagePlaybooks,
  type PredictionCompletionPrompt,
  type StageInput,
} from "./stage-envelope";
import {
  buildCompletionEvidencePayload,
  buildCompletionReportDraft,
  buildPredictionCompletionInstruction,
  buildPredictionRepairInstruction,
  buildPrimaryPredictionInstruction,
  buildReportLanguageRepairInstruction,
  completionCritiqueStage,
  finalReportShape,
  postSynthesisAuditGuidance,
} from "./final-synthesis";

const DETERMINISTIC_CITATION_GUIDANCE =
  "For exact numeric market claims, cite deterministic snapshot sourceIds from canonicalFacts, marketContext, evidenceItems, or the verified market snapshot when available. Use history-report-* sources for narrative prior-context claims, not as the only citation for a specific number.";

function requireSimplifiedInput(
  input: StageInput,
): Pick<Required<StageInput>, "deepEquityModelPacket" | "canonicalSources"> {
  if (input.deepEquityModelPacket === undefined || input.canonicalSources === undefined) {
    throw new Error("simplified deep-equity prompts require a model packet and canonical sources");
  }
  return {
    deepEquityModelPacket: input.deepEquityModelPacket,
    canonicalSources: input.canonicalSources,
  };
}

function webSubjectProfile(input: StageInput): Record<string, unknown> | undefined {
  const profile = input.collectedSources.webSubjectProfile;
  if (profile === undefined || profile.sourceIds.length === 0) {
    return undefined;
  }
  return {
    subjectSummary: profile.subjectSummary,
    questions: profile.questions,
    factLedger: profile.factLedger,
    recentMaterialEvents: profile.recentMaterialEvents,
    openGaps: profile.openGaps,
  };
}

function promptSideEvidence(input: StageInput): Record<string, unknown> {
  const snapshot = input.deepEquityModelPacket?.canonicalFacts.verifiedMarketSnapshot;
  const profile = webSubjectProfile(input);
  return {
    marketRegime: input.context.marketRegime,
    ...(input.collectedSources.marketContext !== undefined
      ? { marketContext: input.collectedSources.marketContext }
      : {}),
    ...(profile !== undefined ? { webSubjectProfile: profile } : {}),
    ...(input.collectedSources.resolvedInstrumentIdentity !== undefined
      ? {
          resolvedInstrumentIdentity: input.collectedSources.resolvedInstrumentIdentity,
          resolvedIdentityInstruction:
            "This is the canonical instrument identity for this run. Use this identity; do not substitute a different company.",
        }
      : {}),
    deterministicCitationGuidance: DETERMINISTIC_CITATION_GUIDANCE,
    ...(snapshot !== undefined
      ? {
          verifiedMarketSnapshotSourceId: verifiedSnapshotSourceId(snapshot.symbol),
          verifiedMarketSnapshotCitationRule: verifiedSnapshotCitationRule(snapshot.symbol),
        }
      : {}),
  };
}

function compactCanonicalFacts(
  packet: DeepEquityModelPacket,
  includeHistory: boolean,
): Record<string, unknown> {
  const statements = packet.canonicalFacts.financialStatements;
  const history = packet.canonicalFacts.fundamentalHistory;
  return {
    marketSnapshots: packet.canonicalFacts.marketSnapshots,
    supplementalMarketSnapshots: packet.canonicalFacts.supplementalMarketSnapshots,
    ...(packet.canonicalFacts.verifiedMarketSnapshot !== undefined
      ? { verifiedMarketSnapshot: packet.canonicalFacts.verifiedMarketSnapshot }
      : {}),
    ...(statements !== undefined
      ? {
          financialStatements: {
            analysisAsOf: statements.analysisAsOf,
            sourceId: statements.sourceId,
            reportingCurrency: statements.reportingCurrency,
            interimCadence: statements.interimCadence,
            extractionMethod: statements.extractionMethod,
            statementCoverage: Object.fromEntries(
              Object.entries(statements.statements).map(([statement, series]) => [
                statement,
                Object.keys(series),
              ]),
            ),
          },
        }
      : {}),
    ...(includeHistory && history !== undefined
      ? {
          fundamentalHistory: {
            sourceId: history.sourceId,
            series: Object.fromEntries(
              Object.entries(history.series).map(([key, series]) => [
                key,
                {
                  label: series.label,
                  unit: series.unit,
                  annual: series.annual.map((period) => ({
                    value: period.value,
                    periodEnd: period.periodEnd,
                    filedAt: period.filedAt,
                    ...(period.currency !== undefined ? { currency: period.currency } : {}),
                  })),
                  ...(series.ttm !== undefined ? { ttm: series.ttm } : {}),
                  ...(series.cagr !== undefined ? { cagr: series.cagr } : {}),
                  ...(series.notes.length > 0 ? { notes: series.notes } : {}),
                },
              ]),
            ),
          },
        }
      : {}),
  };
}

function compactDerivedViews(
  packet: DeepEquityModelPacket,
  critique: boolean,
): Record<string, unknown> {
  const views = packet.derivedViews;
  const {valuationComps} = views;
  const workbench = views.valuationWorkbench;
  const {businessFramework} = views;
  const emittedViews: Record<string, unknown> = {
    ...(!critique && views.capitalOwnership !== undefined
      ? { capitalOwnership: views.capitalOwnership }
      : {}),
    ...(!critique && views.subsequentFinancing !== undefined
      ? { subsequentFinancing: views.subsequentFinancing }
      : {}),
    ...(!critique && views.analystExpectations !== undefined
      ? { analystExpectations: views.analystExpectations }
      : {}),
    ...(!critique && views.institutionalOwnership !== undefined
      ? { institutionalOwnership: views.institutionalOwnership }
      : {}),
    ...(valuationComps !== undefined
      ? {
          valuationComps: {
            summary: valuationComps.summary,
            impliedPriceRange: valuationComps.impliedPriceRange,
            freshnessFlags: valuationComps.freshnessFlags,
            excludedPeers: valuationComps.excludedPeers,
          },
        }
      : {}),
    ...(workbench !== undefined
      ? {
          valuationWorkbench: critique
            ? {
                reportingCurrency: workbench.reportingCurrency,
                quoteCurrency: workbench.quoteCurrency,
                suppressionReasons: workbench.historicalMultiples.suppressionReasons,
              }
            : {
                reportingCurrency: workbench.reportingCurrency,
                quoteCurrency: workbench.quoteCurrency,
                priceSelectionRule: workbench.historicalMultiples.priceSelectionRule,
                trailingBasis: workbench.historicalMultiples.trailingBasis,
                suppressionReasons: workbench.historicalMultiples.suppressionReasons,
              },
        }
      : {}),
    ...(views.reverseDcf !== undefined
      ? {
          reverseDcf:
            views.reverseDcf.status === "computed" && !critique
              ? {
                  status: views.reverseDcf.status,
                  assumptions: views.reverseDcf.assumptions,
                }
              : {
                  status: views.reverseDcf.status,
                  ...(views.reverseDcf.status === "suppressed"
                    ? { reason: views.reverseDcf.reason, detail: views.reverseDcf.detail }
                    : {}),
                },
        }
      : {}),
    ...(views.earningsSetup !== undefined ? { earningsSetup: views.earningsSetup } : {}),
    ...(businessFramework !== undefined
      ? {
          businessFramework: {
            phase: businessFramework.phase,
            sections: businessFramework.sections.map((section) => ({
              name: section.name,
              posture: section.posture,
              summary: section.summary,
              sourceIds: section.sourceIds,
            })),
          },
        }
      : {}),
  };
  return {
    available: Object.keys(emittedViews),
    ...emittedViews,
  };
}

function packetEvidence(input: StageInput, critique = false): Record<string, unknown> {
  const { deepEquityModelPacket: packet } = requireSimplifiedInput(input);
  return {
    analysisAsOf: packet.run.analysisAsOf,
    command: input.command,
    run: packet.run,
    canonicalFacts: compactCanonicalFacts(packet, !critique),
    evidenceItems: packet.evidenceItems,
    derivedViews: compactDerivedViews(packet, critique),
    sources: critique
      ? packet.sources.map((source) => ({
          id: source.id,
          title: source.title,
          fetchedAt: source.fetchedAt,
          kind: source.kind,
          ...(source.provider !== undefined ? { provider: source.provider } : {}),
        }))
      : packet.sources,
    gaps: packet.gaps,
    sourcePlan: packet.governance.sourcePlan,
    evidenceLanes: packet.governance.evidenceLanes,
    historicalContext: packet.historicalContext,
    ...promptSideEvidence(input),
  };
}

function compactSourceIndex(sources: readonly Source[]): readonly Record<string, unknown>[] {
  return sources.map((source) => {
    const snippet = source.snippet ?? source.summary;
    return {
      id: source.id,
      title: source.title,
      fetchedAt: source.fetchedAt,
      ...(source.url !== undefined ? { url: source.url } : {}),
      ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    };
  });
}

function distilledPriorStages(
  priorStages: readonly unknown[],
): readonly { readonly stage: string; readonly content: string }[] {
  return priorStages.flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("stage" in entry) ||
      typeof (entry as { readonly stage?: unknown }).stage !== "string"
    ) {
      return [];
    }
    const {stage} = (entry as { readonly stage: string });
    const {content} = (entry as { readonly content?: unknown });
    return [{ stage, content: typeof content === "string" ? content : "" }];
  });
}

function simplifiedFinalEvidence(input: StageInput): Record<string, unknown> {
  const { deepEquityModelPacket: packet, canonicalSources } = requireSimplifiedInput(input);
  const calibrationBlock = buildCalibrationBlock(
    input.context.calibrationContext,
    input.command,
    input.context,
  );
  const priorThesisErrors = buildPriorThesisErrorBlock(
    input.command,
    input.context.historicalContext,
  );
  const priorMarketForecastErrors = buildMarketForecastErrorBlock(input.command, input.context);
  const priorThematicForecastErrors = buildResearchForecastErrorBlock(
    input.command,
    input.context.historicalContext,
  );
  return {
    analysisAsOf: packet.run.analysisAsOf,
    run: packet.run,
    canonicalSourceIndex: compactSourceIndex(canonicalSources),
    finalEvidenceQuality: input.context.evidenceQualityAssessment,
    sourceGapCount: packet.gaps.length,
    reportConstraints: {
      researchOnly:
        "No buy/sell/hold calls, advice, position sizing, execution instructions, or portfolio actions.",
      observablePredictions:
        "Every prediction must use the supplied observable grammar and public price data.",
      citations: FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE,
    },
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
    ...(priorThesisErrors !== undefined ? { priorThesisErrors } : {}),
    ...(priorMarketForecastErrors !== undefined ? { priorMarketForecastErrors } : {}),
    ...(priorThematicForecastErrors !== undefined ? { priorThematicForecastErrors } : {}),
    ...promptSideEvidence(input),
  };
}

function simplifiedSteeringInstruction(
  input: StageInput,
  completion: PredictionCompletionPrompt | undefined,
): string {
  return completion === undefined
    ? buildPrimaryPredictionInstruction(input.command, input.collectedSources, input.context)
    : buildPredictionCompletionInstruction(
        input.command,
        input.collectedSources,
        input.context,
        completion,
      );
}

export function buildEquityAnalysisStagePrompt(input: StageInput): string {
  return assembleStagePrompt({
    stage: "equity-analysis",
    instruction: input.loaded.instruction,
    stageGoal: input.loaded.goal,
    depthProfile: input.context.depthProfile,
    evidence: packetEvidence(input),
    playbooks: stagePlaybooks("equity-analysis", input.context),
    priorStages: input.priorStages ?? [],
    predictionRepromptErrors: input.predictionRepromptErrors ?? [],
    reportValidationErrors: input.reportValidationErrors ?? [],
    requiredShape: {
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    },
  });
}

export function buildSimplifiedCritiqueStagePrompt(input: StageInput): string {
  return assembleStagePrompt({
    stage: "critique",
    instruction: `${input.loaded.instruction} Independently identify omissions, unsupported conclusions, weak counterarguments, and invalid prediction reasoning.`,
    stageGoal: input.loaded.goal,
    depthProfile: input.context.depthProfile,
    evidence: packetEvidence(input, true),
    playbooks: stagePlaybooks("critique", input.context),
    priorStages: distilledPriorStages(input.priorStages ?? []),
    predictionRepromptErrors: input.predictionRepromptErrors ?? [],
    reportValidationErrors: input.reportValidationErrors ?? [],
    requiredShape: {
      findings: [{ text: "string", sourceIds: ["source-id"] }],
      dataGaps: ["string"],
    },
  });
}

export function buildSimplifiedFinalSynthesisStagePrompt(input: StageInput): string {
  const { predictionCompletion } = input;
  requireSimplifiedInput(input);
  const hasEarningsSetup =
    isInstrumentCommand(input.command) && input.collectedSources.earningsSetup !== undefined;
  const hasBusinessFramework =
    isInstrumentCommand(input.command) && input.collectedSources.businessFramework !== undefined;
  const hasWebSubjectProfile = input.collectedSources.webSubjectProfile !== undefined;
  const reportShape = finalReportShape(
    input.command,
    input.collectedSources,
    input.context.depthProfile,
    hasEarningsSetup,
    hasBusinessFramework,
    hasWebSubjectProfile,
    subjectKindForCommand(input.command),
  );
  const requiredShape =
    predictionCompletion === undefined ? reportShape : { predictions: reportShape.predictions };
  const completionContext =
    predictionCompletion === undefined
      ? undefined
      : {
          evidence: buildCompletionEvidencePayload(
            predictionCompletion.reportDraft,
            input.command,
            input.collectedSources,
            input.context,
          ),
          priorStages: (() => {
            const critique = completionCritiqueStage(input.priorStages ?? []);
            return critique === undefined ? [] : [critique];
          })(),
          reportDraft: buildCompletionReportDraft(predictionCompletion.reportDraft),
        };
  const repairInstruction =
    (input.predictionRepromptErrors?.length ?? 0) > 0
      ? buildPredictionRepairInstruction(input.context)
      : undefined;
  const languageRepair = buildReportLanguageRepairInstruction(input.reportValidationErrors ?? []);

  return assembleStagePrompt({
    stage: "final-synthesis",
    instruction:
      (predictionCompletion === undefined ? input.loaded.instruction : "") +
      simplifiedSteeringInstruction(input, predictionCompletion),
    stageGoal:
      predictionCompletion === undefined
        ? input.loaded.goal
        : "Add only distinct, evidence-backed observable forecasts without changing the accepted report.",
    depthProfile: input.context.depthProfile,
    evidence: completionContext?.evidence ?? simplifiedFinalEvidence(input),
    playbooks: stagePlaybooks("final-synthesis", input.context),
    priorStages: completionContext?.priorStages ?? distilledPriorStages(input.priorStages ?? []),
    reportDraft: completionContext?.reportDraft,
    predictionRepromptErrors: input.predictionRepromptErrors ?? [],
    predictionRepair:
      repairInstruction === undefined ? undefined : { instruction: repairInstruction },
    predictionCompletion:
      predictionCompletion === undefined
        ? undefined
        : {
            requestedCount: predictionCompletion.requestedCount,
            existingPredictions: predictionCompletion.existingPredictions,
          },
    allowedSourceIds: input.allowedSourceIds ?? [],
    sourceIdGuidance: FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE,
    postSynthesisAuditGuidance: postSynthesisAuditGuidance(),
    reportValidationErrors: input.reportValidationErrors ?? [],
    reportLanguageRepair: languageRepair,
    requiredShape,
  });
}
