import { isInstrumentCommand } from "../../cli/args";
import type { DeepEquityModelPacket } from "../../deep-equity/types";
import type { Source } from "../../domain/types";
import type { PeerImpliedRange } from "../../sources/extended-evidence/valuation-comps";
import { subjectKindForCommand } from "../../web-evidence";
import { buildCalibrationBlock } from "../calibration-context";
import {
  buildMarketForecastErrorBlock,
  buildPriorThesisErrorBlock,
  buildResearchForecastErrorBlock,
} from "../prior-forecast-errors";
import {
  forPrompt,
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

// Posture rules for the write-up stage. The 2026-07-27 live pair showed the simplified report
// Asserting "TTM operating cash flow was about $132B and a free-cash-flow proxy was about $118B" as
// An observed fact — both are aggregates over the supplied statements — and presenting 2026-05-01
// Verified-snapshot indicators alongside a 2026-06-15 live quote as one market state. The label
// Vocabulary already exists (postSynthesisAuditGuidance); what was missing was which figures the
// Rules bind to. Provenance, not authorship, decides: a TTM aggregate, peer multiple, or implied
// Range that arrived precomputed in fundamentalHistory or derivedViews is still derived, so reading
// It off the packet rather than computing it does not make it an observation.
// The 2026-07-28 paired eval then lost AAPL on evidence-grounding, downside, and gap disclosure.
// Legacy treated the live-quote versus verified-bar gap as central; simplified only labelled it.
// Both sides held the data, so snapshotRecency became a placement rule rather than a naming rule.
// Three paid repetitions recovered all three dimensions and lost financial-valuation-reasoning.
// Pinning staleness onto every multiple resting on the older bar hedged the valuation prose.
// State the gap and where it belongs; the valuation discussion stays free to be crisp.
const DERIVED_FIGURE_CONSTRAINTS = {
  derivedFigures:
    "A figure is observed only where a filing, statement, or quote reports it directly. Anything built on top of one — a trailing-twelve-month aggregate, margin, growth rate, per-share or free-cash-flow proxy, valuation multiple, peer-implied range — is a derived calculation even when the packet supplies it already computed. Label it as derived and name the reported line items and periods it rests on.",
  snapshotRecency:
    "The verified snapshot is a dated bar, not the current tape. Carry its session date with every claim drawn from it and do not merge the two into one market state. Where the two diverge materially, that gap is a contradiction in the evidence rather than a labelling detail: give both figures with their dates and their own sourceIds where the evidence is discussed, carry it into the downside and counterevidence discussion, and name it in the uncertainty and gap disclosure. Where the two agree closely, or no current quote was collected, say so once and do not construct a conflict the figures do not show.",
} as const;

const DETERMINISTIC_CITATION_GUIDANCE =
  "For exact numeric market claims, cite deterministic snapshot sourceIds from canonicalFacts, marketContext, evidenceItems, or the verified market snapshot when available. Use history-report-* sources for narrative prior-context claims, not as the only citation for a specific number.";

// The 2026-07-27 live pair produced a +/-30% peer-band forecast. The derived-figure rule was
// Already present; the simplified final passes lacked the recent price dispersion needed to size
// A band from observed movement, so this adds that input without adding another valuation rule.
const SIMPLIFIED_PRICE_HISTORY_SESSIONS = 30;

const PRICE_HISTORY_USAGE =
  "Closes and indicators share one sourceId; cite it for claims using either. latestClose is a dated-bar close, not the current tape; carry latestSessionDate with any claim drawn from it. A forecast band should reflect the closes' observed dispersion over this window; atr14 is short-horizon volatility context.";

// The 2026-07-27 evaluation pair centred bands on valuationComps.impliedPriceRange.
// This stage received only a 45-day-old verified bar, not the already-collected live quote.
const SIMPLIFIED_CURRENT_PRICE_USAGE =
  "Most recent observed price for the run symbol: a live quote fetched at observedAt; cite sourceId for it. Use it — not a bar close or an implied range — wherever a claim needs the current market level, and carry observedAt with it. Where it diverges materially from priceHistory.latestClose, handle that gap as reportConstraints.snapshotRecency requires.";

const SIMPLIFIED_NO_CURRENT_PRICE_USAGE =
  "No current quote for the run symbol was collected for this run. The most recent price available is the dated verified-bar close at its session date. State it with that date, do not present it as the current price, and say the current price is unavailable where a claim would otherwise need it.";

const SIMPLIFIED_FINAL_FIGURE_USAGE =
  "Use issuerFundamentals as fields from the run-symbol quote record. Under reportConstraints.derivedFigures, label every valuation multiple, peer-implied range, trailing aggregate, growth rate, or other calculation in these blocks as derived and name its reported inputs and periods. valuation omits live-price comparison fields; use currentPriceReference for the current market level.";

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

function compactFundamentalHistory(
  packet: DeepEquityModelPacket,
  headlineOnly = false,
): Record<string, unknown> | undefined {
  const history = packet.canonicalFacts.fundamentalHistory;
  if (history === undefined) {
    return undefined;
  }
  const series = Object.fromEntries(
    Object.entries(history.series).flatMap(([key, item]) => {
      const headline = {
        ...(item.ttm !== undefined ? { ttm: item.ttm } : {}),
        ...(item.cagr !== undefined ? { cagr: item.cagr } : {}),
        ...(item.notes.length > 0 ? { notes: item.notes } : {}),
      };
      if (headlineOnly) {
        return Object.keys(headline).length > 0 ? [[key, headline]] : [];
      }
      return [
        [
          key,
          {
            label: item.label,
            unit: item.unit,
            annual: item.annual.map((period) => ({
              value: period.value,
              periodEnd: period.periodEnd,
              filedAt: period.filedAt,
              ...(period.currency !== undefined ? { currency: period.currency } : {}),
            })),
            ...headline,
          },
        ],
      ];
    }),
  );
  if (headlineOnly && Object.keys(series).length === 0) {
    return undefined;
  }
  return {
    sourceId: history.sourceId,
    series,
  };
}

function compactCanonicalFacts(
  packet: DeepEquityModelPacket,
  includeHistory: boolean,
): Record<string, unknown> {
  const statements = packet.canonicalFacts.financialStatements;
  const fundamentalHistory = includeHistory ? compactFundamentalHistory(packet) : undefined;
  return {
    marketSnapshots: forPrompt(packet.canonicalFacts.marketSnapshots),
    supplementalMarketSnapshots: forPrompt(packet.canonicalFacts.supplementalMarketSnapshots),
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
    ...(fundamentalHistory !== undefined ? { fundamentalHistory } : {}),
  };
}

function compactDerivedViews(
  packet: DeepEquityModelPacket,
  critique: boolean,
  valuationOnly = false,
): Record<string, unknown> {
  const views = packet.derivedViews;
  const { valuationComps } = views;
  const workbench = views.valuationWorkbench;
  const { businessFramework } = views;
  const impliedPriceRange = valuationComps?.impliedPriceRange;
  const includeImpliedPriceRange = !valuationOnly || impliedPriceRange?.status === "derived";
  const projectedImpliedPriceRange =
    valuationOnly && impliedPriceRange?.status === "derived"
      ? compactFinalImpliedPriceRange(impliedPriceRange)
      : impliedPriceRange;
  let valuationWorkbench: Record<string, unknown> | undefined = undefined;
  if (workbench !== undefined) {
    if (critique) {
      valuationWorkbench = {
        reportingCurrency: workbench.reportingCurrency,
        quoteCurrency: workbench.quoteCurrency,
        suppressionReasons: workbench.historicalMultiples.suppressionReasons,
      };
    } else if (valuationOnly) {
      valuationWorkbench = {
        historicalMultiples: {
          trailingBasis: workbench.historicalMultiples.trailingBasis,
          priceSelectionRule: workbench.historicalMultiples.priceSelectionRule,
          suppressionReasons: workbench.historicalMultiples.suppressionReasons,
        },
      };
    } else {
      valuationWorkbench = {
        reportingCurrency: workbench.reportingCurrency,
        quoteCurrency: workbench.quoteCurrency,
        priceSelectionRule: workbench.historicalMultiples.priceSelectionRule,
        trailingBasis: workbench.historicalMultiples.trailingBasis,
        suppressionReasons: workbench.historicalMultiples.suppressionReasons,
      };
    }
  }
  const emittedViews: Record<string, unknown> = {
    ...(!valuationOnly && !critique && views.capitalOwnership !== undefined
      ? { capitalOwnership: views.capitalOwnership }
      : {}),
    ...(!valuationOnly && !critique && views.subsequentFinancing !== undefined
      ? { subsequentFinancing: views.subsequentFinancing }
      : {}),
    ...(!valuationOnly && !critique && views.analystExpectations !== undefined
      ? { analystExpectations: views.analystExpectations }
      : {}),
    ...(!valuationOnly && !critique && views.institutionalOwnership !== undefined
      ? { institutionalOwnership: views.institutionalOwnership }
      : {}),
    ...(valuationComps !== undefined
      ? {
          valuationComps: {
            summary: valuationComps.summary,
            ...(includeImpliedPriceRange ? { impliedPriceRange: projectedImpliedPriceRange } : {}),
            ...(!valuationOnly ? { freshnessFlags: valuationComps.freshnessFlags } : {}),
            excludedPeers: valuationComps.excludedPeers,
          },
        }
      : {}),
    ...(valuationWorkbench !== undefined ? { valuationWorkbench } : {}),
    ...(!valuationOnly && views.reverseDcf !== undefined
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
    ...(!valuationOnly && views.earningsSetup !== undefined
      ? { earningsSetup: views.earningsSetup }
      : {}),
    ...(!valuationOnly && businessFramework !== undefined
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
    ...(!valuationOnly ? { available: Object.keys(emittedViews) } : {}),
    ...emittedViews,
  };
}

function compactFinalImpliedPriceRange(
  range: Extract<PeerImpliedRange, { readonly status: "derived" }>,
): Record<string, unknown> {
  return {
    status: range.status,
    label: range.label,
    basis: range.basis,
    formula: range.formula,
    inputs: {
      peerP25EvToAnnualizedRevenue: range.inputs.peerP25EvToAnnualizedRevenue,
      peerMedianEvToAnnualizedRevenue: range.inputs.peerMedianEvToAnnualizedRevenue,
      peerP75EvToAnnualizedRevenue: range.inputs.peerP75EvToAnnualizedRevenue,
      annualizedRevenue: range.inputs.annualizedRevenue,
      netDebt: range.inputs.netDebt,
      sharesOutstanding: range.inputs.sharesOutstanding,
      quoteCurrency: range.inputs.quoteCurrency,
    },
    low: range.low,
    mid: range.mid,
    high: range.high,
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
    const { stage } = entry as { readonly stage: string };
    const { content } = entry as { readonly content?: unknown };
    return [{ stage, content: typeof content === "string" ? content : "" }];
  });
}

function simplifiedPriceHistory(
  packet: DeepEquityModelPacket,
): Record<string, unknown> | undefined {
  const snapshot = packet.canonicalFacts.verifiedMarketSnapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const window = snapshot.recentCloses.slice(-SIMPLIFIED_PRICE_HISTORY_SESSIONS);
  if (window.length === 0) {
    return undefined;
  }
  // Only ATR14 earns prompt cost for short-horizon width. Bollinger values are deliberately
  // Withheld because they are a precomputed price band the model could copy as forecast bounds,
  // Not because the verified snapshot lacks them.
  const indicators = {
    atr14: roundToTwoDecimals(snapshot.indicators.atr14),
  };
  return {
    priceHistory: {
      sourceId: verifiedSnapshotSourceId(snapshot.symbol),
      latestSessionDate: snapshot.latestSessionDate,
      windowStartDate: window[0]!.date,
      // Keep this beside latestSessionDate so the dated-bar warning does not rely on array position.
      latestClose: roundToTwoDecimals(snapshot.ohlcv.close),
      closes: window.map((bar) => roundToTwoDecimals(bar.close)),
      indicators,
      usage: PRICE_HISTORY_USAGE,
    },
  };
}

function simplifiedCurrentPriceReference(
  packet: DeepEquityModelPacket,
): Record<string, unknown> | undefined {
  const symbol = packet.run.symbol.toUpperCase();
  const quote = packet.canonicalFacts.marketSnapshots.find(
    (snapshot) => snapshot.symbol.toUpperCase() === symbol,
  );
  const verifiedSnapshot = packet.canonicalFacts.verifiedMarketSnapshot;
  if (
    quote !== undefined &&
    (verifiedSnapshot === undefined ||
      quote.observedAt.slice(0, 10) >= verifiedSnapshot.latestSessionDate)
  ) {
    return {
      status: "quote-observed",
      price: quote.price,
      observedAt: quote.observedAt,
      sourceId: quote.sourceId,
      ...(quote.identity?.quoteCurrency !== undefined
        ? { quoteCurrency: quote.identity.quoteCurrency }
        : {}),
      usage: SIMPLIFIED_CURRENT_PRICE_USAGE,
    };
  }
  if (verifiedSnapshot !== undefined) {
    return {
      status: "unavailable",
      reason: quote === undefined ? "no-quote" : "quote-older-than-latest-bar",
      usage: SIMPLIFIED_NO_CURRENT_PRICE_USAGE,
    };
  }
  return undefined;
}

function simplifiedIssuerFundamentals(
  packet: DeepEquityModelPacket,
): Record<string, unknown> | undefined {
  const symbol = packet.run.symbol.toUpperCase();
  const quote = packet.canonicalFacts.marketSnapshots.find(
    (snapshot) => snapshot.symbol.toUpperCase() === symbol,
  );
  if (quote === undefined) {
    return undefined;
  }
  const { fundamentals } = quote;
  const fields = {
    ...(quote.marketCap !== undefined ? { marketCap: quote.marketCap } : {}),
    ...(fundamentals?.trailingPE !== undefined ? { trailingPE: fundamentals.trailingPE } : {}),
    ...(fundamentals?.forwardPE !== undefined ? { forwardPE: fundamentals.forwardPE } : {}),
    ...(fundamentals?.priceToBook !== undefined ? { priceToBook: fundamentals.priceToBook } : {}),
    ...(fundamentals?.bookValue !== undefined ? { bookValue: fundamentals.bookValue } : {}),
    ...(fundamentals?.dividendYield !== undefined
      ? { dividendYield: fundamentals.dividendYield }
      : {}),
    ...(fundamentals?.epsTrailingTwelveMonths !== undefined
      ? { epsTrailingTwelveMonths: fundamentals.epsTrailingTwelveMonths }
      : {}),
    ...(fundamentals?.epsForward !== undefined ? { epsForward: fundamentals.epsForward } : {}),
    ...(fundamentals?.sharesOutstanding !== undefined
      ? { sharesOutstanding: fundamentals.sharesOutstanding }
      : {}),
    ...(fundamentals?.trailingAnnualDividendRate !== undefined
      ? { trailingAnnualDividendRate: fundamentals.trailingAnnualDividendRate }
      : {}),
  };
  return Object.keys(fields).length > 0 ? { sourceId: quote.sourceId, ...fields } : undefined;
}

function simplifiedFinalFigureEvidence(packet: DeepEquityModelPacket): Record<string, unknown> {
  const issuerFundamentals = simplifiedIssuerFundamentals(packet);
  const valuation = compactDerivedViews(packet, false, true);
  const fundamentalHistory = compactFundamentalHistory(packet, true);
  const hasValuation = Object.keys(valuation).length > 0;
  const hasFigures =
    issuerFundamentals !== undefined || hasValuation || fundamentalHistory !== undefined;
  return {
    ...(issuerFundamentals !== undefined ? { issuerFundamentals } : {}),
    ...(hasValuation ? { valuation } : {}),
    ...(fundamentalHistory !== undefined ? { fundamentalHistory } : {}),
    ...(hasFigures ? { figureUsage: SIMPLIFIED_FINAL_FIGURE_USAGE } : {}),
  };
}

function roundToTwoDecimals(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function simplifiedFinalEvidence(input: StageInput): Record<string, unknown> {
  const { deepEquityModelPacket: packet, canonicalSources } = requireSimplifiedInput(input);
  const currentPriceReference = simplifiedCurrentPriceReference(packet);
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
    ...(currentPriceReference !== undefined ? { currentPriceReference } : {}),
    ...simplifiedPriceHistory(packet),
    ...simplifiedFinalFigureEvidence(packet),
    canonicalSourceIndex: compactSourceIndex(canonicalSources),
    finalEvidenceQuality: input.context.evidenceQualityAssessment,
    sourceGapCount: packet.gaps.length,
    reportConstraints: {
      researchOnly:
        "No buy/sell/hold calls, advice, position sizing, execution instructions, or portfolio actions.",
      observablePredictions:
        "Every prediction must use the supplied observable grammar and public price data.",
      citations: FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE,
      ...DERIVED_FIGURE_CONSTRAINTS,
    },
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
    ...(priorThesisErrors !== undefined ? { priorThesisErrors } : {}),
    ...(priorMarketForecastErrors !== undefined ? { priorMarketForecastErrors } : {}),
    ...(priorThematicForecastErrors !== undefined ? { priorThematicForecastErrors } : {}),
    ...promptSideEvidence(input),
  };
}

// Any reprompt here is a stateless whole-report regeneration: the model is told what failed but
// Never shown the predictions that passed, so on the evidence-thin simplified prompt it returns
// Fewer than the attempt it was repairing (equity-fpi-ifrs-semiannual lost 3 and finished with 1).
// Naming the survivors turns the repair back into a repair. This applies to report-only validation
// Retries as well: those carry no predictionRepromptErrors, so the prediction-repair block never
// Renders for them, yet they regenerate the predictions array just the same.
function survivorGuidance(input: StageInput): string {
  const retained = input.retainedPredictions ?? [];
  if (retained.length === 0) {
    return "";
  }
  const survivors = retained.map((prediction) => ({
    id: prediction.id,
    kind: prediction.kind,
    subject: prediction.subject,
    measurableAs: prediction.measurableAs,
    horizonTradingDays: prediction.horizonTradingDays,
    probability: prediction.probability,
    sourceIds: prediction.sourceIds,
  }));
  return ` These predictions from your previous attempt already validated: ${JSON.stringify(survivors)}. Re-emit every one of them unchanged, then repair or replace only what this reprompt flagged. Dropping a prediction that already validated is a regression, not a repair.`;
}

function simplifiedSteeringInstruction(
  input: StageInput,
  completion: PredictionCompletionPrompt | undefined,
): string {
  const base =
    completion === undefined
      ? buildPrimaryPredictionInstruction(input.command, input.collectedSources, input.context)
      : buildPredictionCompletionInstruction(
          input.command,
          input.collectedSources,
          input.context,
          completion,
        );
  return `${base}${survivorGuidance(input)}`;
}

function simplifiedRepairInstruction(input: StageInput): string | undefined {
  return (input.predictionRepromptErrors?.length ?? 0) > 0
    ? buildPredictionRepairInstruction(input.context)
    : undefined;
}

// Single source for the steering the simplified final-synthesis prompt carries. The prompt builder
// Below and the orchestrator's recorded StageOutput.steering compose from these same instructions,
// So stages.json cannot claim guidance the model never received. The record is a recomposition —
// Trimmed and "\n\n"-joined rather than byte-identical to the prompt's instruction field — so the
// Guarantee is content equivalence, not byte equality. That audit trail is the only reason the
// 2026-07-27 prediction-count regression was diagnosable at all.
export function buildSimplifiedSteeringSegment(input: StageInput): string | undefined {
  const steering = [
    simplifiedSteeringInstruction(input, input.predictionCompletion),
    simplifiedRepairInstruction(input) ?? "",
  ]
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("\n\n");
  return steering.length > 0 ? steering : undefined;
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
  const { deepEquityModelPacket: packet } = requireSimplifiedInput(input);
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
  // The measured token budget does not allow replaying the bounded report-writing figures here.
  // The primary pass may therefore cite a peer-implied range that completion-pass predictions
  // Cannot see; current-price and price-history anchors remain on both passes.
  const completionContext =
    predictionCompletion === undefined
      ? undefined
      : (() => {
          const currentPriceReference = simplifiedCurrentPriceReference(packet);
          return {
            evidence: {
              ...buildCompletionEvidencePayload(
                predictionCompletion.reportDraft,
                input.command,
                input.collectedSources,
                input.context,
              ),
              ...(currentPriceReference !== undefined ? { currentPriceReference } : {}),
              ...simplifiedPriceHistory(packet),
            },
            priorStages: (() => {
              const critique = completionCritiqueStage(input.priorStages ?? []);
              return critique === undefined ? [] : [critique];
            })(),
            reportDraft: buildCompletionReportDraft(predictionCompletion.reportDraft),
          };
        })();
  const repairInstruction = simplifiedRepairInstruction(input);
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
