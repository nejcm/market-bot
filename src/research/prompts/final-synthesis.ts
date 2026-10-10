import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ForecastKindMix } from "../../config/runs";
import { NEAR_BASE_RATE_BAND, type PredictionKind } from "../../domain/prediction";
import {
  BROAD_US_INDEX_BENCHMARK_SYMBOLS,
  BROAD_US_INDEX_CLASS,
  MAX_PREDICTION_HORIZON_TRADING_DAYS,
  MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS,
  MIN_PREDICTION_HORIZON_TRADING_DAYS,
  RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON,
} from "../../forecast/observable";
import { subjectKindForCommand, webSubjectProfileRequiredShape } from "../../web-evidence";
import type { CollectedSources } from "../../sources/types";
import { EVIDENCE_POSTURE_LABELS } from "../post-synthesis-audit";
import type { StageLabel } from "../prompt-loader";
import type { DepthProfile, ResearchContext } from "../research-context-types";
import type { ConditionalCalibrationSummary } from "../../scoring/types";
import { buildEvidencePayload } from "./evidence-payload";
import {
  hasCiteableOptionsIvEvidence,
  isFredAllowedSubject,
  isVixAllowedSubject,
  predictionCoverageGuidance,
  supportedPredictionKinds,
} from "./prediction-coverage";
import { FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE } from "./source-id-guidance";
import { assembleStagePrompt, stagePlaybooks, type StageInput } from "./stage-envelope";
import { buildFreshWebSteering } from "./steering";
import { hasConfirmedEarningsDate } from "../../forecast/earnings-eligibility";

const NEAR_BASE_RATE_LOWER_BOUND = (0.5 - NEAR_BASE_RATE_BAND).toFixed(2);
const NEAR_BASE_RATE_UPPER_BOUND = (0.5 + NEAR_BASE_RATE_BAND).toFixed(2);
const MIN_CONDITIONAL_PREDICTION_SAMPLE_SIZE = 10;
const MATERIAL_CONDITIONAL_VOID_RATE = 0.5;

const NEAR_BASE_RATE_PROBABILITY_RULE = `probability outside the inclusive ${NEAR_BASE_RATE_LOWER_BOUND}-${NEAR_BASE_RATE_UPPER_BOUND} near-base-rate band. A probability inside that band signals an uninformative claim: either commit to the probability the cited evidence actually supports, or choose a different observable claim with more resolving power. Never inflate a probability beyond the evidence just to leave the band`;

function finalReportShape(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  depthProfile: DepthProfile,
  hasEarningsSetup: boolean,
  hasBusinessFramework: boolean,
  hasWebSubjectProfile: boolean,
  webSubjectKind: ReturnType<typeof subjectKindForCommand>,
  excludedKinds: readonly PredictionKind[] = [],
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
    excludedKinds,
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
      ...(command.jobType === "equity"
        ? {}
        : {
            spotlights: {
              items: [{ symbol: "string", rationale: "string", sourceIds: ["source-id"] }],
            },
          }),
      ...earningsSetupShape,
      ...businessFrameworkShape,
      ...webSubjectProfileShape,
    },
  };
}

function buildForecastDiversityGuidance(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  excludedKinds: readonly PredictionKind[] = [],
): string {
  if (command.depth !== "deep" || !isInstrumentCommand(command)) {
    return "";
  }
  const shapes: string[] = [
    "direction (close up/down)",
    "relative (vs benchmark)",
    ...(excludedKinds.includes("range") ? [] : ["range (outside [Lo, Hi])"]),
  ];
  if (hasCiteableOptionsIvEvidence(collectedSources)) {
    shapes.push("IV (iv(SUBJECT, +N) > T)");
  }
  if (hasConfirmedEarningsDate(collectedSources.earningsSetup)) {
    shapes.push("earnings-direction or earnings-move (event-anchored)");
  }
  shapes.push("conditional (if-then when evidence supports a setup)");

  return ` Before stopping, consider whether the available evidence supports distinct forecast shapes: ${shapes.join("; ")}. Explore shape and resolution-window variety to find the most informative forecasts rather than defaulting to the same kind repeatedly, varying horizons only where the evidence supports it. A better-measured kind such as relative is informative only when its probability departs from 0.5; several same-horizon relative forecasts against equivalent broad US index benchmarks (e.g. SPY, QQQ, DIA) restate one view rather than adding independent signal. The count is still a soft target; do not pad with low-conviction forecasts.`;
}

// The observable grammar only ever asserts the positive side of a comparison, so a bearish or
// Stays-within view is expressed through the probability rather than the expression. With `range`
// Withdrawn there is no `outside` expression to talk about, and naming one would advertise the
// Withdrawn kind's semantic well enough to elicit it — the gate would then drop the forecast and
// The slot would be wasted. Default output is unchanged for every path that keeps range.
function buildPolarityGuidance(excludedKinds: readonly PredictionKind[]): string {
  return excludedKinds.includes("range")
    ? ` The grammar only expresses up; to express a bearish view, set probability below ${NEAR_BASE_RATE_LOWER_BOUND} on the up expression.`
    : ` The grammar only expresses up/outside; to express a bearish or stays-within-range view, set probability below ${NEAR_BASE_RATE_LOWER_BOUND} on the up/outside expression.`;
}

const RANGE_REFERENCE_MIN_CLOSES = 11;
const RANGE_REFERENCE_HORIZONS = [1, 5, 10, 20] as const;
// Closes are split-unadjusted (ADR 0004); a move far outside the MAD scale reads as a split.
const MAD_TO_SIGMA = 1.4826;
const SPLIT_SIGNATURE_ROBUST_SIGMAS = 8;

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

// Range-band probabilities ran ~1.6x above realized outcomes (F6); a vol-scaled band gives the model a base rate.
function buildRangeVolatilityReference(
  collectedSources: CollectedSources,
  excludedKinds: readonly PredictionKind[],
): string {
  const snapshot = collectedSources.verifiedMarketSnapshot;
  const closes = snapshot?.recentCloses.map((bar) => bar.close).filter((close) => close > 0) ?? [];
  if (
    snapshot === undefined ||
    excludedKinds.includes("range") ||
    closes.length < RANGE_REFERENCE_MIN_CLOSES
  ) {
    return "";
  }
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]!));
  const center = median(returns);
  const robustSigma = MAD_TO_SIGMA * median(returns.map((value) => Math.abs(value - center)));
  // MAD is 0 when most days are flat; then jumps are the volatility, not a split signature.
  const largestMove = Math.max(...returns.map(Math.abs));
  if (robustSigma > 0 && largestMove > SPLIT_SIGNATURE_ROBUST_SIGMAS * robustSigma) {
    return "";
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const sigma = Math.sqrt(
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1),
  );
  const spot = closes.at(-1)!;
  const bands = RANGE_REFERENCE_HORIZONS.map((horizon) => {
    const move = sigma * Math.sqrt(horizon);
    return `+${String(horizon)}: [${(spot * Math.exp(-move)).toFixed(2)}, ${(spot * Math.exp(move)).toFixed(2)}]`;
  }).join("; ");
  return ` Range reference for ${snapshot.symbol} (deterministic, from the ${String(returns.length)} daily log returns in verifiedMarketSnapshot.recentCloses): realized daily volatility (sample standard deviation) ${(sigma * 100).toFixed(2)}% around the last close ${spot.toFixed(2)}; ±1σ close bands ${bands}. Daily returns are fat-tailed, so treat these bands as a scale for how wide an [Lo, Hi] range is relative to recent movement, not as exact probabilities. Anchor range probabilities to this reference and move above it only for a cited catalyst inside the window, such as a confirmed earnings date.`;
}

export function buildConditionalPredictionActivationGuidance(
  conditionalPredictions: ConditionalCalibrationSummary | undefined,
): string | undefined {
  if (conditionalPredictions === undefined) {
    return undefined;
  }
  const { activatedCount, voidedCount } = conditionalPredictions;
  const resolvedCount = activatedCount + voidedCount;
  if (resolvedCount < MIN_CONDITIONAL_PREDICTION_SAMPLE_SIZE) {
    return undefined;
  }
  const voidRate = voidedCount / resolvedCount;
  if (voidRate < MATERIAL_CONDITIONAL_VOID_RATE) {
    return undefined;
  }
  return ` Continue emitting Conditional Predictions when the evidence supports a genuinely conditional setup. Anchor antecedents to scheduled events such as earnings dates, index rebalances, or economic releases, or to threshold levels that the cited price history has already reached, so the antecedent can plausibly occur inside the resolution window. Activation history shows why antecedent quality matters: ${String(activatedCount)} of ${String(resolvedCount)} resolved conditionals activated; ${String(voidedCount)} voided because their antecedents did not occur.`;
}

function predictionDslInstruction(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  predictionSubjects: readonly string[],
  excludedKinds: readonly PredictionKind[] = [],
): string {
  const clauses: string[] = [
    "close(SUBJECT, +N) > close(SUBJECT, 0) for direction",
    "close(A, +N)/close(A, 0) > close(B, +N)/close(B, 0) for relative",
    ...(excludedKinds.includes("range") ? [] : ["close(SUBJECT, +N) outside [Lo, Hi] for range"]),
    ...(isFredAllowedSubject(predictionSubjects)
      ? ["fred(SERIES, +N) > fred(SERIES, 0) for macro"]
      : []),
  ];
  if (command.assetClass === "equity") {
    if (isVixAllowedSubject(predictionSubjects)) {
      clauses.push("max(close(^VIX), 0..+N) > T for volatility");
    }
    if (hasCiteableOptionsIvEvidence(collectedSources)) {
      clauses.push("iv(SUBJECT, +N) > T for IV");
    }
  }
  return `Each prediction must use the measurableAs DSL: ${clauses.join(", ")}. The legal range for N is ${MIN_PREDICTION_HORIZON_TRADING_DAYS}–${MAX_PREDICTION_HORIZON_TRADING_DAYS} trading days.`;
}

function withoutExcludedKinds(
  mix: ForecastKindMix,
  excludedKinds: readonly PredictionKind[],
): ForecastKindMix {
  return excludedKinds.length === 0
    ? mix
    : { ...mix, favored: mix.favored.filter((kind) => !excludedKinds.includes(kind)) };
}

function buildKindMixGuidance(mix: ForecastKindMix): string {
  const favored = mix.favored.join(", ");
  const floor =
    mix.minNonDirection !== undefined && mix.minNonDirection > 0
      ? ` Aim for at least ${String(mix.minNonDirection)} prediction(s) using a kind other than \`direction\` where the evidence supports it.`
      : "";
  return ` Favor more informative forecast kinds in this priority order where the evidence supports them: ${favored}. Use bare \`direction\` only when no better-measured kind fits the available evidence — its short-horizon base rate sits near a coin flip. Favoring a kind reflects measurement quality, not conviction: a better-measured kind still earns its place only when its probability moves off 0.5.${floor}`;
}

// Repair-pass steering for the validator's disallowed-subject and broad-US-index redundancy
// Rejections (observable.ts resolveCandidate/redundancyKey).
function buildAllowedSubjectSteering(predictionSubjects: readonly string[]): string {
  const subjects = predictionSubjects.join(", ");
  const benchmarks = BROAD_US_INDEX_BENCHMARK_SYMBOLS.join(", ");
  return `Allowed prediction subjects for this run: ${subjects}. For a relative forecast written as PRIMARY:BENCHMARK, the primary (pre-colon) symbol must be one of these allowed subjects; the benchmark may be any citeable instrument. Relative forecasts against any of ${benchmarks} share the ${BROAD_US_INDEX_CLASS} class, so only one such forecast per primary subject and exact horizon adds signal — to add another, vary the horizon, use a non-equivalent benchmark such as a sector ETF, or use a different kind. A second relative forecast for the same primary subject and exact horizon must differ in probability by more than ${String(RELATIVE_FORECAST_EQUAL_PROBABILITY_EPSILON)}, backed by a stated evidence-based differentiation; changing only the benchmark ticker does not add signal.`;
}

function buildPredictionRepairInstruction(
  context: ResearchContext,
  excludedKinds: readonly PredictionKind[] = [],
): string {
  const subjects = context.depthProfile.predictionSubjects.join(", ");
  const favoredKinds = withoutExcludedKinds(
    context.depthProfile.targetKindMix,
    excludedKinds,
  ).favored.join(", ");
  const rangeGuidance = excludedKinds.includes("range")
    ? ""
    : " For range forecasts, use a different horizon when another range forecast already covers the same subject and horizon.";
  return `Return a complete final report with a valid predictions array, fixing the flagged predictions. Do not omit the predictions array, and do not return a partial patch. The array may hold fewer than ${String(context.depthProfile.targetPredictions)} predictions when the evidence does not support more — do not pad with coin-flips to reach a count. Make every prediction distinct: replace any dropped near-duplicate rather than re-emitting it. Prefer replacement forecasts using these subjects: ${subjects}; favor these kinds when supported: ${favoredKinds}. ${buildAllowedSubjectSteering(context.depthProfile.predictionSubjects)} For ticker relative forecasts, use subject form TICKER:BENCHMARK.${rangeGuidance} Keep two direction calls on the same subject at least ${String(MIN_DIRECTION_HORIZON_GAP_TRADING_DAYS)} trading days apart — otherwise vary the subject, kind, or horizon.`;
}

function earningsForecastGrammar(): string {
  return "kind earnings-direction with measurableAs earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0 for post-print direction, or kind earnings-move with measurableAs abs(earningsReturn(SUBJECT, YYYY-MM-DD, +N)) > T for an absolute post-print move beyond threshold T — use the deterministic earningsSetup.impliedMove as the reference bar for T. Use earningsSetup.event.date as YYYY-MM-DD; horizonTradingDays counts post-event trading days, not days from today.";
}

function conditionalForecastGrammar(): string {
  return "kind conditional with measurableAs syntax if (<existing expression>) then (<existing expression>): subject and horizonTradingDays come from the consequent, the antecedent horizon must be earlier than the consequent horizon, and probability means P(consequent | antecedent). Do not nest conditionals.";
}

function buildPrimaryPredictionInstruction(
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  excludedKinds: readonly PredictionKind[] = [],
  options: {
    readonly businessFrameworkEvidenceProjected?: boolean;
    // Describes where, and whether, this pipeline's evidence payload carries the profile digest.
    // The surviving legacy payload ships both the extendedEvidence item and a top-level digest.
    // Naming a location the payload does not have invites uncitable prose.
    readonly webSubjectProfileEvidence?: {
      readonly projected: boolean;
      readonly path: string;
    };
  } = {},
): string {
  const conditionalPredictionInstruction =
    command.depth === "deep"
      ? ` Deep runs may use Conditional Predictions when evidence supports a conditional setup — ${conditionalForecastGrammar()}`
      : "";
  const conditionalActivationGuidance =
    command.depth === "deep"
      ? (buildConditionalPredictionActivationGuidance(
          context.calibrationContext?.conditionalPredictions,
        ) ?? "")
      : "";
  const hasEarningsSetup =
    isInstrumentCommand(command) && collectedSources.earningsSetup !== undefined;
  const earningsForecastEligible =
    isInstrumentCommand(command) && hasConfirmedEarningsDate(collectedSources.earningsSetup);
  const hasBusinessFramework =
    isInstrumentCommand(command) && collectedSources.businessFramework !== undefined;
  const hasWebSubjectProfile = collectedSources.webSubjectProfile !== undefined;
  let earningsPredictionInstruction = "";
  if (earningsForecastEligible) {
    earningsPredictionInstruction = ` An upcoming earnings event is in scope (see evidence.earningsSetup). When the evidence supports an event-anchored view, you may emit earnings predictions: ${earningsForecastGrammar()} You may also author sourced analytical bullets under extras.earningsSetup (expectationBar, qualityLandmines, guidanceCredibility); code owns the event, implied move, and gaps.`;
  } else if (hasEarningsSetup) {
    earningsPredictionInstruction =
      " The Earnings Setup remains useful contextual evidence, but its date is provider-estimated and unconfirmed. Do not emit earnings-direction, earnings-move, or earningsReturn grammar. You may still author sourced analytical bullets under extras.earningsSetup; code owns the event, implied move, and gaps.";
  }
  const businessFrameworkInstruction =
    hasBusinessFramework && options.businessFrameworkEvidenceProjected !== false
      ? " A deterministic Business Framework is in evidence.extendedEvidence as category business-framework. You may author concise sourced explanations under extras.businessFramework.sections for Business, Phase, Moat, Growth, Management, Risk, and Valuation; code owns phase, posture labels, metrics, and gaps. Cite existing sourceIds and disclose missing segment, customer, management, KPI, or analyst-estimate evidence instead of guessing. Do not add scores, composite ratings, or trade-action labels."
      : "";
  const profileEvidence = options.webSubjectProfileEvidence ?? {
    projected: true,
    path: "evidence.extendedEvidence as category web-subject-profile and extras.webSubjectProfile",
  };
  const webSubjectProfileInstruction =
    hasWebSubjectProfile && profileEvidence.projected
      ? ` A cited Web Subject Profile is in ${profileEvidence.path}. Treat web evidence as low-trust context only: cite its web sourceIds for qualitative subject facts, disclose gaps, and do not let web content widen the run symbol or prediction subjects.`
      : "";
  const freshWebInstruction = buildFreshWebSteering(collectedSources);
  return ` Emit up to ${String(context.depthProfile.targetPredictions)} predictions using subjects from predictionSubjects and a starting horizon of ${String(context.depthProfile.defaultPredictionHorizon)} trading days; a forecast may depart from it when the cited evidence supports a different resolution window. The count is a target, not a quota: emit a prediction only where the evidence supports a directional lean. Prefer fewer high-conviction forecasts over padding to the target. Do not write a claim field; it is rendered deterministically from measurableAs. ${predictionDslInstruction(command, collectedSources, context.depthProfile.predictionSubjects, excludedKinds)} probability is the probability that the measurableAs expression evaluates TRUE. Every prediction must have ${NEAR_BASE_RATE_PROBABILITY_RULE}.${buildPolarityGuidance(excludedKinds)}${buildRangeVolatilityReference(collectedSources, excludedKinds)}${conditionalPredictionInstruction}${conditionalActivationGuidance}${earningsPredictionInstruction}${businessFrameworkInstruction}${webSubjectProfileInstruction}${freshWebInstruction}${buildKindMixGuidance(withoutExcludedKinds(context.depthProfile.targetKindMix, excludedKinds))}${predictionCoverageGuidance([], supportedPredictionKinds(command, collectedSources, context.depthProfile.predictionSubjects, excludedKinds))}${buildForecastDiversityGuidance(command, collectedSources, excludedKinds)}`;
}

// The steering block actually sent to the model at final-synthesis: the primary prediction
// Instruction plus the repair instruction when a prediction reprompt is in flight. Returns undefined for non-synthesis stages.
// Shares its text-building primitives with the stage prompt builder so recorded steering matches
// What the prompt carries. Records only the steering block, never the full ~50-65k-token prompt.
export function buildStageSteeringSegment(
  stage: StageLabel,
  command: ResearchCommand,
  collectedSources: CollectedSources,
  context: ResearchContext,
  predictionRepromptErrors: readonly string[] = [],
): string | undefined {
  if (stage !== "final-synthesis") {
    return undefined;
  }
  const segments: string[] = [
    buildPrimaryPredictionInstruction(command, collectedSources, context),
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
  return `Your previous report was rejected for reader-directed advice or trade-action language: ${languageErrors.join("; ")}. Rewrite every affected field in neutral, research-only language. Never instruct anyone to act: do not put "should", "could", "may want to", "might want to", "need to", or "must" after "investors", "traders", "readers", or "you"; do not put "buy", "sell", "hold", "open", "trim", "add", "exit", "enter", "reduce", "increase", or "rebalance" after "should", "must", or "need to". Avoid standalone trade verbs such as "buy", "sell", "hold", or "accumulate", or any recommendation, allocation, position-sizing, or execution phrasing. Replace advice with observational phrasing such as "evidence supports", "the data shows", "a source states", or "the setup is consistent with". Valuation-certainty wording is rejected by the same gate: never write "fair value", "margin of safety", "undervalued", "overvalued", "price target", or "target price" — even when quoting a source. Describe prices positionally instead, such as "trades below the peer-median multiple" or "the quote sits above the peer-implied reference range". Keep the same factual claims and sourceIds; change only the wording.`;
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
  const requiredShape = finalReportShape(
    command,
    collectedSources,
    context.depthProfile,
    hasEarningsSetup,
    hasBusinessFramework,
    hasWebSubjectProfile,
    subjectKindForCommand(command),
  );
  return assembleStagePrompt({
    stage: "final-synthesis",
    instruction:
      loaded.instruction + buildPrimaryPredictionInstruction(command, collectedSources, context),
    stageGoal: loaded.goal,
    depthProfile: context.depthProfile,
    evidence: buildEvidencePayload(
      { includePriorCalibration: true, sourceGapView: "all", webSourceText: "fresh-only" },
      command,
      collectedSources,
      config,
      context,
    ),
    playbooks: stagePlaybooks("final-synthesis", context),
    priorStages,
    predictionRepromptErrors,
    predictionRepair,
    allowedSourceIds,
    sourceIdGuidance: FINAL_SYNTHESIS_SOURCE_ID_GUIDANCE,
    postSynthesisAuditGuidance: postSynthesisAuditGuidance(),
    reportValidationErrors,
    reportLanguageRepair: buildReportLanguageRepairInstruction(reportValidationErrors),
    requiredShape,
  });
}
