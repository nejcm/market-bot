import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ForecastKindMix } from "../../config/runs";
import {
  NEAR_BASE_RATE_BAND,
  type ExtendedEvidenceItem,
  type MarketSnapshot,
  type Prediction,
  type ResearchReport,
  type Source,
} from "../../domain/types";
import {
  BROAD_US_INDEX_BENCHMARK_SYMBOLS,
  BROAD_US_INDEX_BENCHMARKS,
  BROAD_US_INDEX_CLASS,
  MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS,
} from "../../forecast/observable";
import { subjectKindForCommand, webSubjectProfileRequiredShape } from "../../web-evidence";
import type { CollectedSources } from "../../sources/types";
import { verifiedSnapshotSourceId } from "../verified-snapshot-contract";
import { buildCalibrationBlock } from "../calibration-context";
import { EVIDENCE_POSTURE_LABELS } from "../post-synthesis-audit";
import type { StageLabel } from "../prompt-loader";
import type { DepthProfile, ResearchContext } from "../research-context-types";
import { buildEvidencePayload } from "./evidence-payload";
import {
  hasCiteableOptionsIvEvidence,
  isVixAllowedSubject,
  predictionCoverageGuidance,
  supportedPredictionKinds,
} from "./prediction-coverage";
import { FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE } from "./source-id-guidance";
import {
  assembleStagePrompt,
  stagePlaybooks,
  type PredictionCompletionPrompt,
  type StageInput,
} from "./stage-envelope";
import { buildFreshWebSteering } from "./steering";

const NEAR_BASE_RATE_LOWER_BOUND = (0.5 - NEAR_BASE_RATE_BAND).toFixed(2);
const NEAR_BASE_RATE_UPPER_BOUND = (0.5 + NEAR_BASE_RATE_BAND).toFixed(2);

const NEAR_BASE_RATE_PROBABILITY_RULE = `probability outside the inclusive ${NEAR_BASE_RATE_LOWER_BOUND}-${NEAR_BASE_RATE_UPPER_BOUND} near-base-rate band. A probability inside that band signals an uninformative claim: either commit to the probability the cited evidence actually supports, or choose a different observable claim with more resolving power. Never inflate a probability beyond the evidence just to leave the band`;

function finalReportShape(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  depthProfile: DepthProfile,
  hasEarningsSetup: boolean,
  hasBusinessFramework: boolean,
  hasWebSubjectProfile: boolean,
  webSubjectKind: ReturnType<typeof subjectKindForCommand>,
): Record<string, unknown> {
  const exampleSubject = depthProfile.predictionSubjects[0] ?? "SPY";
  // Build the model-visible kind string from the same gated logic that steers the prose
  // (supportedPredictionKinds), so the required shape never advertises volatility/iv/conditional
  // When the prompt correctly omits them (no ^VIX subject, no citeable options-iv evidence,
  // Or a non-deep run). See the 2026-07-05 review: an ungated shape burned the ^VIX candidate.
  const predictionKinds = supportedPredictionKinds(
    command,
    collectedSources,
    depthProfile.predictionSubjects,
  ).join("|");
  const earningsSetupShape = hasEarningsSetup
    ? {
        earningsSetup: {
          expectationBar: [{ text: "string", sourceIds: ["source-id"] }],
          qualityLandmines: [{ text: "string", sourceIds: ["source-id"] }],
          guidanceCredibility: [{ text: "string", sourceIds: ["source-id"] }],
        },
      }
    : {};
  const businessFrameworkShape = hasBusinessFramework
    ? {
        businessFramework: {
          sections: [
            {
              name: "Business|Phase|Moat|Growth|Management|Risk|Valuation",
              text: "string",
              sourceIds: ["source-id"],
            },
          ],
        },
      }
    : {};
  const webSubjectProfileShape = hasWebSubjectProfile
    ? {
        webSubjectProfile: webSubjectProfileRequiredShape(webSubjectKind ?? "company"),
      }
    : {};
  return {
    summary: "string",
    keyFindings: [{ text: "string", sourceIds: ["source-id"] }],
    bullCase: [{ text: "string", sourceIds: ["source-id"] }],
    bearCase: [{ text: "string", sourceIds: ["source-id"] }],
    risks: [{ text: "string", sourceIds: ["source-id"] }],
    catalysts: [{ text: "string", sourceIds: ["source-id"] }],
    scenarios: [{ name: "string", description: "string", sourceIds: ["source-id"] }],
    dataGaps: ["string"],
    // One exemplar only: this array conveys prediction shape, not how many to emit.
    // The soft target count lives in depthProfile.targetPredictions and the
    // Instruction text; a target-length array here would pressure the count upward.
    predictions: [
      {
        id: "pred-1",
        kind: predictionKinds,
        subject: exampleSubject,
        measurableAs: `close(${exampleSubject}, +${String(depthProfile.defaultPredictionHorizon)}) > close(${exampleSubject}, 0)`,
        horizonTradingDays: depthProfile.defaultPredictionHorizon,
        probability: 0.6,
        sourceIds: ["source-id"],
      },
    ],
    extras: {
      historicalContext: {
        summary: "string",
        sourceIds: ["history-report-run-id"],
        items: [{ text: "string", sourceIds: ["history-report-run-id"] }],
        gaps: ["string"],
      },
      spotlights: {
        items: [{ symbol: "string", rationale: "string", sourceIds: ["source-id"] }],
      },
      ...earningsSetupShape,
      ...businessFrameworkShape,
      ...webSubjectProfileShape,
    },
  };
}

function buildForecastDiversityGuidance(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): string {
  if (command.depth !== "deep" || !isInstrumentCommand(command)) {
    return "";
  }
  const shapes: string[] = [
    "direction (close up/down)",
    "relative (vs benchmark)",
    "range (outside [Lo, Hi])",
  ];
  if (hasCiteableOptionsIvEvidence(collectedSources)) {
    shapes.push("IV (iv(SUBJECT, +N) > T)");
  }
  if (collectedSources.earningsSetup !== undefined) {
    shapes.push("earnings-direction or earnings-move (event-anchored)");
  }
  shapes.push("conditional (if-then when evidence supports a setup)");

  return ` Before stopping, consider whether the available evidence supports distinct forecast shapes: ${shapes.join("; ")}. Explore shape and horizon variety to find the most informative forecasts rather than defaulting to the same kind repeatedly. A better-measured kind such as relative is informative only when its probability departs from 0.5; several same-horizon relative forecasts against equivalent broad US index benchmarks (e.g. SPY, QQQ, DIA) restate one view rather than adding independent signal. The count is still a soft target; do not pad with low-conviction forecasts.`;
}

function predictionDslInstruction(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  predictionSubjects: readonly string[],
): string {
  const equityExtras: string[] = [];
  if (command.assetClass === "equity") {
    if (isVixAllowedSubject(predictionSubjects)) {
      equityExtras.push("max(close(^VIX), 0..+N) > T for volatility");
    }
    if (hasCiteableOptionsIvEvidence(collectedSources)) {
      equityExtras.push("iv(SUBJECT, +N) > T for IV");
    }
  }
  const equityOnly = equityExtras.length > 0 ? `, ${equityExtras.join(", ")}` : "";
  return `Each prediction must use the measurableAs DSL: close(SUBJECT, +N) > close(SUBJECT, 0) for direction, close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative, close(SUBJECT, +N) outside [Lo, Hi] for range, fred(SERIES, +N) > fred(SERIES, 0) for macro${equityOnly}.`;
}

function buildKindMixGuidance(mix: ForecastKindMix): string {
  const favored = mix.favored.join(", ");
  const floor =
    mix.minNonDirection !== undefined && mix.minNonDirection > 0
      ? ` Aim for at least ${String(mix.minNonDirection)} prediction(s) using a kind other than \`direction\` where the evidence supports it.`
      : "";
  return ` Favor more informative forecast kinds in this priority order where the evidence supports them: ${favored}. Use bare \`direction\` only when no better-measured kind fits the available evidence — its short-horizon base rate sits near a coin flip. Favoring a kind reflects measurement quality, not conviction: a better-measured kind still earns its place only when its probability moves off 0.5.${floor}`;
}

// Allowed-subject + benchmark-equivalence steering shared by the completion and repair passes.
// Both handle the same validator rejection classes (disallowed-subject and broad-US-index
// Redundancy at observable.ts resolveCandidate/redundancyKey), so the prompt spells out the
// Enforced semantics: the pre-colon primary of a relative forecast must be an allowed subject,
// And relative forecasts against equivalent broad-index benchmarks collapse to one class slot.
function buildAllowedSubjectSteering(predictionSubjects: readonly string[]): string {
  const subjects = predictionSubjects.join(", ");
  const benchmarks = BROAD_US_INDEX_BENCHMARK_SYMBOLS.join(", ");
  return `Allowed prediction subjects for this run: ${subjects}. For a relative forecast written as PRIMARY:BENCHMARK, the primary (pre-colon) symbol must be one of these allowed subjects; the benchmark may be any citeable instrument. Relative forecasts against any of ${benchmarks} share the ${BROAD_US_INDEX_CLASS} class, so only one such forecast per primary subject and exact horizon adds signal — to add another, vary the horizon, use a non-equivalent benchmark such as a sector ETF, or use a different kind.`;
}

// Names the broad-US-index class+horizon slots already taken by existingPredictions so the
// Completion pass does not re-propose a relative forecast the redundancy rule would reject.
function describeOccupiedBroadIndexSlots(predictions: readonly Prediction[]): string {
  const slots: string[] = [];
  const seen = new Set<string>();
  for (const prediction of predictions) {
    if (prediction.kind !== "relative" || !prediction.subject.includes(":")) {
      continue;
    }
    const [primary, benchmark] = prediction.subject.split(":");
    if (
      primary === undefined ||
      benchmark === undefined ||
      !BROAD_US_INDEX_BENCHMARKS.has(benchmark)
    ) {
      continue;
    }
    const key = `${primary}|${String(prediction.horizonTradingDays)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slots.push(
      `${primary} relative @ ${String(prediction.horizonTradingDays)}d (${BROAD_US_INDEX_CLASS})`,
    );
  }
  return slots.length > 0
    ? ` Existing predictions already occupy these ${BROAD_US_INDEX_CLASS} slots: ${slots.join("; ")} — do not restate them.`
    : "";
}

function buildPredictionRepairInstruction(context: ResearchContext): string {
  const subjects = context.depthProfile.predictionSubjects.join(", ");
  const favoredKinds = context.depthProfile.targetKindMix.favored.join(", ");
  return `Return a complete final report with a valid predictions array, fixing the flagged predictions. Do not omit the predictions array, and do not return a partial patch. The array may hold fewer than ${String(context.depthProfile.targetPredictions)} predictions when the evidence does not support more — do not pad with coin-flips to reach a count. Make every prediction distinct: replace any dropped near-duplicate rather than re-emitting it. Prefer replacement forecasts using these subjects: ${subjects}; favor these kinds when supported: ${favoredKinds}. ${buildAllowedSubjectSteering(context.depthProfile.predictionSubjects)} For ticker relative forecasts, use subject form TICKER:BENCHMARK. For range forecasts, vary the horizon or range bounds when another range forecast already covers the same subject and horizon. Keep two direction calls on the same subject at least ${String(MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS)} trading days apart — otherwise vary the subject, kind, or horizon.`;
}

// MeasurableAs grammar for the event-anchored earnings kinds, shared verbatim by the primary and
// Completion prediction instructions. Completion previously advertised earnings-direction and
// Earnings-move as supported kinds (via coverage guidance) without ever showing their grammar, so
// The model paired an advertised earnings kind with the plain direction close() grammar and the
// Validator rejected it with "kind does not match measurableAs" (run-review finding #3). Sharing
// One string keeps both passes advertising a single consistent surface.
function earningsForecastGrammar(): string {
  return "kind earnings-direction with measurableAs earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0 for post-print direction, or kind earnings-move with measurableAs abs(earningsReturn(SUBJECT, YYYY-MM-DD, +N)) > T for an absolute post-print move beyond threshold T — use the deterministic earningsSetup.impliedMove as the reference bar for T. Use earningsSetup.event.date as YYYY-MM-DD; horizonTradingDays counts post-event trading days, not days from today.";
}

// MeasurableAs grammar for the deep-only conditional kind, shared by the primary and completion
// Prediction instructions for the same reason as earningsForecastGrammar (run-review finding #3):
// Completion advertised conditional as a supported kind without pairing it with its grammar.
function conditionalForecastGrammar(): string {
  return "kind conditional with measurableAs syntax if (<existing expression>) then (<existing expression>): subject and horizonTradingDays come from the consequent, the antecedent horizon must be earlier than the consequent horizon, and probability means P(consequent | antecedent). Do not nest conditionals.";
}

// Pairs every additional advertised kind with its measurableAs grammar for the completion pass.
// The base DSL (direction/relative/range/macro plus equity extras) comes from
// PredictionDslInstruction; this adds the earnings and conditional grammars under the same gates
// SupportedPredictionKinds uses to advertise them, so the pass never nudges a kind whose grammar
// The model has not been shown (run-review finding #3).
function buildCompletionKindGrammar(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): string {
  const clauses: string[] = [];
  if (isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined) {
    clauses.push(`For an earnings-anchored forecast, use ${earningsForecastGrammar()}`);
  }
  if (command.depth === "deep") {
    clauses.push(`For a conditional forecast, use ${conditionalForecastGrammar()}`);
  }
  return clauses.length > 0 ? ` ${clauses.join(" ")}` : "";
}

interface CompletionSourceEntry {
  readonly id: string;
  readonly title: string;
  readonly fetchedAt: string;
  readonly publisher?: string;
  readonly url?: string;
  readonly snippet?: string;
}

function toCompletionSourceEntry(source: Source): CompletionSourceEntry {
  const snippet = source.snippet ?? source.summary;
  return {
    id: source.id,
    title: source.title,
    fetchedAt: source.fetchedAt,
    ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
    ...(source.url !== undefined ? { url: source.url } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

function completionMarketSnapshot(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): MarketSnapshot | undefined {
  if (isInstrumentCommand(command)) {
    const symbol = command.symbol.toUpperCase();
    return collectedSources.marketSnapshots.find(
      (snapshot) => snapshot.symbol.toUpperCase() === symbol,
    );
  }
  return collectedSources.marketSnapshots.at(0);
}

function completionLatestClose(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): Record<string, unknown> | undefined {
  if (
    isInstrumentCommand(command) &&
    collectedSources.verifiedMarketSnapshot?.symbol.toUpperCase() === command.symbol.toUpperCase()
  ) {
    const snapshot = collectedSources.verifiedMarketSnapshot;
    return {
      subject: snapshot.symbol,
      close: snapshot.ohlcv.close,
      sessionDate: snapshot.latestSessionDate,
      sourceId: verifiedSnapshotSourceId(snapshot.symbol),
    };
  }

  const snapshot = completionMarketSnapshot(command, collectedSources);
  if (snapshot === undefined) {
    return undefined;
  }
  return {
    subject: snapshot.symbol,
    price: snapshot.price,
    observedAt: snapshot.observedAt,
    sourceId: snapshot.sourceId,
    ...(snapshot.identity?.quoteCurrency !== undefined
      ? { quoteCurrency: snapshot.identity.quoteCurrency }
      : {}),
  };
}

function completionEarningsSetup(
  collectedSources: CollectedSources,
): Record<string, unknown> | undefined {
  const setup = collectedSources.earningsSetup;
  if (setup === undefined) {
    return undefined;
  }
  return {
    event: {
      symbol: setup.event.symbol,
      date: setup.event.date,
      timing: setup.event.timing,
      sourceIds: setup.event.sourceIds,
      fetchedAt: setup.event.fetchedAt,
      ...(setup.event.epsEstimate !== undefined ? { epsEstimate: setup.event.epsEstimate } : {}),
      ...(setup.event.revenueEstimate !== undefined
        ? { revenueEstimate: setup.event.revenueEstimate }
        : {}),
    },
    ...(setup.impliedMove !== undefined
      ? {
          impliedMove: {
            expiration: setup.impliedMove.expiration,
            strike: setup.impliedMove.strike,
            spot: setup.impliedMove.spot,
            straddleMidpoint: setup.impliedMove.straddleMidpoint,
            impliedMovePct: setup.impliedMove.impliedMovePct,
            sourceIds: setup.impliedMove.sourceIds,
            observedAt: setup.impliedMove.observedAt,
          },
        }
      : {}),
    ...(setup.gaps.length > 0 ? { gaps: setup.gaps } : {}),
  };
}

function completionOptionsIv(
  collectedSources: CollectedSources,
): readonly Pick<ExtendedEvidenceItem, "title" | "sourceIds" | "observedAt" | "metrics">[] {
  return (
    collectedSources.extendedEvidence?.items
      .filter((item) => item.category === "options-iv" && item.sourceIds.length > 0)
      .map((item) => ({
        title: item.title,
        sourceIds: item.sourceIds,
        observedAt: item.observedAt,
        ...(item.metrics !== undefined ? { metrics: item.metrics } : {}),
      })) ?? []
  );
}

// Compact catalog of citeable sources plus deterministic forecast anchors for the completion pass:
// Enough context to author sourced forecasts without replaying the full evidence payload. Web
// Sources stay under `webSources` so the completion instruction's fresh-web steering reference
// Still resolves; `allowedSourceIds` remains the citation authority.
function buildCompletionEvidencePayload(
  report: ResearchReport,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
): Record<string, unknown> {
  const webSources: CompletionSourceEntry[] = [];
  const sources: CompletionSourceEntry[] = [];
  for (const source of report.sources) {
    (source.kind === "web" ? webSources : sources).push(toCompletionSourceEntry(source));
  }
  const latestClose = completionLatestClose(command, collectedSources);
  const earningsSetup = completionEarningsSetup(collectedSources);
  const optionsIv = completionOptionsIv(collectedSources);
  const calibrationBlock = buildCalibrationBlock(context.calibrationContext, command, context);
  return {
    sources,
    ...(webSources.length > 0 ? { webSources } : {}),
    ...(latestClose !== undefined ? { latestClose } : {}),
    ...(earningsSetup !== undefined ? { earningsSetup } : {}),
    ...(optionsIv.length > 0 ? { optionsIv } : {}),
    ...(calibrationBlock !== undefined ? { priorCalibration: calibrationBlock } : {}),
  };
}

// Narrative-only projection of the first-attempt report so the completion pass can see what has
// Already been written without the raw evidence or prior-stage transcript. Predictions and sources
// Are omitted: existingPredictions and the compact source index already carry them.
function buildCompletionReportDraft(report: ResearchReport): Record<string, unknown> {
  return {
    summary: report.summary,
    keyFindings: report.keyFindings,
    bullCase: report.bullCase,
    bearCase: report.bearCase,
    risks: report.risks,
    catalysts: report.catalysts,
    scenarios: report.scenarios,
    dataGaps: report.dataGaps,
  };
}

// The critique stage output from the prior-stage transcript, projected to stage + content only.
// The completion pass keeps just this stage instead of the full analysis transcript.
function completionCritiqueStage(
  priorStages: readonly unknown[],
): { readonly stage: string; readonly content: string } | undefined {
  for (const entry of priorStages) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "stage" in entry &&
      (entry as { readonly stage?: unknown }).stage === "critique"
    ) {
      const { content } = entry as { readonly content?: unknown };
      return { stage: "critique", content: typeof content === "string" ? content : "" };
    }
  }
  return undefined;
}

function buildPredictionCompletionInstruction(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  completion: PredictionCompletionPrompt,
): string {
  const subjects = context.depthProfile.predictionSubjects.join(", ");
  const favoredKinds = context.depthProfile.targetKindMix.favored.join(", ");
  const coverage = predictionCoverageGuidance(
    completion.existingPredictions,
    supportedPredictionKinds(command, collectedSources, context.depthProfile.predictionSubjects),
  );
  const allowedSubjectSteering = buildAllowedSubjectSteering(
    context.depthProfile.predictionSubjects,
  );
  const occupiedSlots = describeOccupiedBroadIndexSlots(completion.existingPredictions);
  return `Return a JSON object containing only a predictions array with up to ${String(completion.requestedCount)} additional forecasts. An empty array is valid when the evidence supports no additional informative forecast. Do not repeat, replace, or revise existingPredictions. Every candidate must be distinct from existingPredictions, cite a sourceId, and have ${NEAR_BASE_RATE_PROBABILITY_RULE}. ${allowedSubjectSteering}${occupiedSlots} Prefer these subjects: ${subjects}; favor these kinds when supported: ${favoredKinds}.${coverage} ${predictionDslInstruction(command, collectedSources, context.depthProfile.predictionSubjects)}${buildCompletionKindGrammar(command, collectedSources)}${buildFreshWebSteering(collectedSources)}${buildForecastDiversityGuidance(command, collectedSources)}`;
}

function buildPrimaryPredictionInstruction(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
): string {
  const conditionalPredictionInstruction =
    command.depth === "deep"
      ? ` Deep runs may use Conditional Predictions when evidence supports a conditional setup — ${conditionalForecastGrammar()}`
      : "";
  const hasEarningsSetup =
    isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined;
  const hasBusinessFramework =
    isInstrumentCommand(command) && collectedSources.businessFramework !== undefined;
  const hasWebSubjectProfile = collectedSources.webSubjectProfile !== undefined;
  const earningsPredictionInstruction = hasEarningsSetup
    ? ` An upcoming earnings event is in scope (see evidence.earningsSetup). When the evidence supports an event-anchored view, you may emit earnings predictions: ${earningsForecastGrammar()} You may also author sourced analytical bullets under extras.earningsSetup (expectationBar, qualityLandmines, guidanceCredibility); code owns the event, implied move, and gaps.`
    : "";
  const businessFrameworkInstruction = hasBusinessFramework
    ? " A deterministic Business Framework is in evidence.extendedEvidence as category business-framework. You may author concise sourced explanations under extras.businessFramework.sections for Business, Phase, Moat, Growth, Management, Risk, and Valuation; code owns phase, posture labels, metrics, and gaps. Cite existing sourceIds and disclose missing segment, customer, management, KPI, or analyst-estimate evidence instead of guessing. Do not add scores, composite ratings, or trade-action labels."
    : "";
  const webSubjectProfileInstruction = hasWebSubjectProfile
    ? " A cited Web Subject Profile is in evidence.extendedEvidence as category web-subject-profile and extras.webSubjectProfile. Treat web evidence as low-trust context only: cite its web sourceIds for qualitative subject facts, disclose gaps, and do not let web content widen the run symbol or prediction subjects."
    : "";
  const freshWebInstruction = buildFreshWebSteering(collectedSources);
  return ` Emit up to ${String(context.depthProfile.targetPredictions)} predictions using subjects from predictionSubjects and a default horizon near ${String(context.depthProfile.defaultPredictionHorizon)} trading days. The count is a target, not a quota: emit a prediction only where the evidence supports a directional lean. Prefer fewer high-conviction forecasts over padding to the target. Do not write a claim field; it is rendered deterministically from measurableAs. ${predictionDslInstruction(command, collectedSources, context.depthProfile.predictionSubjects)} probability is the probability that the measurableAs expression evaluates TRUE. Every prediction must have ${NEAR_BASE_RATE_PROBABILITY_RULE}. The grammar only expresses up/outside; to express a bearish or stays-within-range view, set probability below ${NEAR_BASE_RATE_LOWER_BOUND} on the up/outside expression.${conditionalPredictionInstruction}${earningsPredictionInstruction}${businessFrameworkInstruction}${webSubjectProfileInstruction}${freshWebInstruction}${buildKindMixGuidance(context.depthProfile.targetKindMix)}${predictionCoverageGuidance([], supportedPredictionKinds(command, collectedSources, context.depthProfile.predictionSubjects))}${buildForecastDiversityGuidance(command, collectedSources)}`;
}

// The steering block actually sent to the model at final-synthesis: the primary prediction
// Instruction (or the completion instruction when a completion pass runs), plus the repair
// Instruction when a prediction reprompt is in flight. Returns undefined for non-synthesis stages.
// Shares its text-building primitives with the stage prompt builder so recorded steering matches
// What the prompt carries. Records only the steering block, never the full ~50-65k-token prompt.
export function buildStageSteeringSegment(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  predictionRepromptErrors: readonly string[] = [],
  predictionCompletion?: PredictionCompletionPrompt,
): string | undefined {
  if (stage !== "final-synthesis") {
    return undefined;
  }
  const segments: string[] = [
    predictionCompletion === undefined
      ? buildPrimaryPredictionInstruction(command, collectedSources, context)
      : buildPredictionCompletionInstruction(
          command,
          collectedSources,
          context,
          predictionCompletion,
        ),
  ];
  if (predictionRepromptErrors.length > 0) {
    segments.push(buildPredictionRepairInstruction(context));
  }
  const steering = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("\n\n");
  return steering.length > 0 ? steering : undefined;
}

function postSynthesisAuditGuidance(): Record<string, string> {
  return {
    status: "warning-only telemetry; do not retry or omit supported findings solely for this audit",
    unsupportedNumericClaims:
      "history-only numeric or technical claims need either a current non-history sourceId, an evidence-posture label such as prior forecast outcome or model inference, or softer non-current wording",
    weakEvidencePosture:
      "claims framed as assumptions, stale evidence, conflicts, unsupported inferences, source gaps, or data gaps should carry an explicit evidence-posture label",
    requiredPostureLabels: `claims that are assumptions, inferences, stale, conflicting, or cited only to history-report-* sources must carry one of these exact labels: ${EVIDENCE_POSTURE_LABELS.join(", ")}`,
  };
}

// Recognizes the research-only language rejection from assertSafeReportLanguage (report/schema.ts)
// So a reprompt can carry concrete rewrite guidance instead of the bare error string.
// Recommendation-shaped subjects ("promising stocks", rankings) draw reader-directed advice even
// Though the base prompt forbids it, so the retry must name the exact violation and the neutral
// Phrasing that replaces it.
function buildReportLanguageRepairInstruction(
  reportValidationErrors: readonly string[],
): string | undefined {
  const languageErrors = reportValidationErrors.filter((error) =>
    error.includes("trade-action language"),
  );
  if (languageErrors.length === 0) {
    return undefined;
  }
  return `Your previous report was rejected for reader-directed advice or trade-action language: ${languageErrors.join("; ")}. Rewrite every affected field in neutral, research-only language. Never instruct anyone to act: do not write "investors should", "readers should", "you should", "buy", "sell", "hold", "accumulate", or any recommendation, allocation, position-sizing, or execution phrasing. Replace advice with observational phrasing such as "evidence supports", "the data shows", "a source states", or "the setup is consistent with". Valuation-certainty wording is rejected by the same gate: never write "fair value", "margin of safety", "undervalued", "overvalued", "price target", or "target price" — even when quoting a source. Describe prices positionally instead, such as "trades below the peer-median multiple" or "the quote sits above the peer-implied reference range". Keep the same factual claims and sourceIds; change only the wording.`;
}

export function buildFinalSynthesisStagePrompt(input: StageInput): string {
  const {
    command,
    collectedSources,
    config,
    context,
    loaded,
    priorStages = [],
    predictionRepromptErrors = [],
    reportValidationErrors = [],
    allowedSourceIds = [],
    predictionCompletion,
  } = input;
  const hasEarningsSetup =
    isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined;
  const hasBusinessFramework =
    isInstrumentCommand(command) && collectedSources.businessFramework !== undefined;
  const hasWebSubjectProfile = collectedSources.webSubjectProfile !== undefined;
  const predictionRepair =
    predictionRepromptErrors.length > 0
      ? { instruction: buildPredictionRepairInstruction(context) }
      : undefined;
  const reportShape = finalReportShape(
    command,
    collectedSources,
    context.depthProfile,
    hasEarningsSetup,
    hasBusinessFramework,
    hasWebSubjectProfile,
    subjectKindForCommand(command),
  );
  const requiredShape =
    predictionCompletion !== undefined ? { predictions: reportShape.predictions } : reportShape;
  // Prediction completion pass: swap the full evidence payload and prior-stage transcript for a
  // Distilled context (report narrative + critique + compact source index plus deterministic
  // Forecast anchors).
  const completionContext =
    predictionCompletion !== undefined
      ? {
          evidence: buildCompletionEvidencePayload(
            predictionCompletion.reportDraft,
            command,
            collectedSources,
            context,
          ),
          priorStages: (() => {
            const critique = completionCritiqueStage(priorStages);
            return critique === undefined ? [] : [critique];
          })(),
          reportDraft: buildCompletionReportDraft(predictionCompletion.reportDraft),
        }
      : undefined;

  return assembleStagePrompt({
    stage: "final-synthesis",
    instruction:
      predictionCompletion === undefined
        ? loaded.instruction + buildPrimaryPredictionInstruction(command, collectedSources, context)
        : buildPredictionCompletionInstruction(
            command,
            collectedSources,
            context,
            predictionCompletion,
          ),
    stageGoal:
      predictionCompletion === undefined
        ? loaded.goal
        : "Add only distinct, evidence-backed observable forecasts without changing the accepted report.",
    depthProfile: context.depthProfile,
    evidence:
      completionContext === undefined
        ? buildEvidencePayload(
            { includePriorCalibration: true, webSourceText: "fresh-only" },
            command,
            collectedSources,
            config,
            context,
          )
        : completionContext.evidence,
    playbooks: stagePlaybooks("final-synthesis", context),
    priorStages: completionContext === undefined ? priorStages : completionContext.priorStages,
    reportDraft: completionContext?.reportDraft,
    predictionRepromptErrors,
    predictionRepair,
    predictionCompletion:
      predictionCompletion !== undefined
        ? {
            requestedCount: predictionCompletion.requestedCount,
            existingPredictions: predictionCompletion.existingPredictions,
          }
        : undefined,
    allowedSourceIds,
    sourceIdGuidance: FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE,
    postSynthesisAuditGuidance: postSynthesisAuditGuidance(),
    reportValidationErrors,
    reportLanguageRepair: buildReportLanguageRepairInstruction(reportValidationErrors),
    requiredShape,
  });
}
