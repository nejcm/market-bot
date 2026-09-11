import {
  isEarningsEventDateStatus,
  isReportIntegrity,
  SOURCE_KINDS,
  type EvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
import {
  assertEquityAnalysisCompleteness,
  EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS,
} from "../domain/equity-analysis-completeness";
import { readEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { retainedEvidenceSpanForEarningsDate } from "../sources/extended-evidence/earnings-date-confirmation";
import { violatesResearchOnly } from "../domain/research-language";
import { readObservableForecasts, type ObservableForecastIssue } from "../forecast/observable";
import { isRecord } from "../guards";
import { validatePredictionShortfall } from "./prediction-shortfall";

export const RESEARCH_ONLY_NOTE =
  "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision.";

export interface PredictionValidationResult {
  readonly valid: readonly Prediction[];
  readonly errors: readonly string[];
  readonly issues: readonly ObservableForecastIssue[];
}

function assertEvidenceQuality(value: string): asserts value is EvidenceQuality {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw new Error(`Invalid Evidence Quality: ${value}`);
  }
}

const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);

function assertSourceKinds(sources: ResearchReport["sources"]): void {
  for (const source of sources) {
    if (!SOURCE_KIND_SET.has(source.kind)) {
      throw new Error(`Invalid Source kind: ${source.kind}`);
    }
  }
}

const MAX_SOURCE_ID_VALIDATION_ERRORS = 12;

function collectSourceIdErrors(
  path: string,
  sourceIds: readonly string[],
  knownSourceIds: ReadonlySet<string>,
  requireAny: boolean,
  errors: string[],
): void {
  if (requireAny && sourceIds.length === 0) {
    errors.push(`${path} must reference at least one source ID`);
  }

  for (const sourceId of sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      errors.push(`${path} cites unknown source ID: ${sourceId}`);
    }
  }
}

function assertNoSourceIdErrors(errors: readonly string[]): void {
  if (errors.length === 0) {
    return;
  }
  const visibleErrors = errors.slice(0, MAX_SOURCE_ID_VALIDATION_ERRORS);
  const hiddenCount = errors.length - visibleErrors.length;
  throw new Error(
    [...visibleErrors, ...(hiddenCount > 0 ? [`(+${hiddenCount} more)`] : [])].join("; "),
  );
}

// This raw-value reader is all-or-nothing and falls back to an empty array.
// The shared guards instead read record keys or filter mixed arrays.
function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function validateKnownSourceIds(
  path: string,
  sourceIds: readonly string[],
  knownSourceIds: ReadonlySet<string>,
  requireAny: boolean,
  errors: string[],
): void {
  collectSourceIdErrors(path, sourceIds, knownSourceIds, requireAny, errors);
}

function validateFindings(
  section: string,
  findings: readonly KeyFinding[],
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  for (const [index, finding] of findings.entries()) {
    collectSourceIdErrors(`${section}[${index}]`, finding.sourceIds, knownSourceIds, true, errors);
  }
}

function validateScenarios(
  scenarios: readonly Scenario[],
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  for (const [index, scenario] of scenarios.entries()) {
    collectSourceIdErrors(`scenarios[${index}]`, scenario.sourceIds, knownSourceIds, true, errors);
  }
}

/*
 * Research-only validation covers model-authored report prose only (ADR 0001,
 * 2026-08-26 amendment). Collector-derived and deterministic assembly text is out of
 * scope: the boundary governs what market-bot asserts, not what its sources say, and a
 * violation the model never wrote is unfixable by a repair reprompt. Deliberately not
 * scanned, with the producer that proves each classification:
 *   extendedEvidence         collector-derived filing/news text
 *   researchQualityDriver    deterministic (research/quality-driver.ts)
 *   extras.historicalContext code-built in research/report-assembly.ts:historicalContextExtra;
 *                            items[].text quotes a prior run summary already gated on its own run
 *   extras.catalystCalendar  research/report-assembly.ts:catalystCalendarExtra; catalyst labels
 *                            duplicate report.catalysts (scanned below), macro labels are
 *                            collector titles, prediction labels are code templates
 *   extras.*.gaps            Source Gap strings emitted by code, never by the model
 * One model-authored surface stays unscanned, unchanged by this scoping: report.dataGaps,
 * which merges model payload.dataGaps with deterministic text (report-assembly.ts:761).
 * Predictions need no scan -- claim is rendered from the parsed expression
 * (observable-candidates.ts:172) and measurableAs is DSL, not prose.
 */
/** Thrown by {@link assertSafeReportLanguage} so callers can tell a research-only rejection apart
 *  from every other report validation error without matching on message text. `path` names the
 *  model-authored field the wording was found in; it is undefined when no single field reproduces
 *  the match, because the scan runs over the newline-joined text and a match can straddle two
 *  fields. Undefined means "not attributable", never "not from the report". */
export class ReportLanguageViolationError extends Error {
  readonly match: string;
  readonly path: string | undefined;

  constructor(match: string, path: string | undefined) {
    super(`Report contains trade-action language: "${match}"`);
    this.name = "ReportLanguageViolationError";
    this.match = match;
    this.path = path;
  }
}

export function assertSafeReportLanguage(report: ResearchReport): void {
  const segments = modelAuthoredReportSegments(report);
  /*
   * Joined with newlines rather than JSON.stringify: the sentence-initial pattern needs
   * `^` or one of `.!?;:\n` before the verb, and a JSON blob puts a quote there instead,
   * so a field opening with "Buy the dip ..." went undetected. JSON.stringify also escapes
   * real newlines to a literal backslash-n, which defeats that branch a second time. The
   * delimiter matters, so keep this a newline join.
   */
  const violation = violatesResearchOnly(segments.map((segment) => segment.text).join("\n"));
  if (violation !== null) {
    throw new ReportLanguageViolationError(
      violation.match,
      attributeLanguageViolation(segments, violation.match),
    );
  }
}

interface ModelAuthoredSegment {
  readonly path: string;
  readonly text: string;
}

/*
 * The sentence-initial pattern matches the boundary character before the verb, so a match taken
 * from the joined text can open with the delimiter the previous field contributed: two adjacent
 * fields "Revenue grew." and "Buy the dip" yield ".\nBuy" joined but "Buy" when the second field
 * is scanned alone. Stripping that consumed prefix from both sides is what lets the two line up.
 * Only leading boundary punctuation and bullet whitespace come off, which no pattern can match
 * beyond its first character, so a phrase that genuinely spans two fields ("... you" + "should
 * ...") still lines up with nothing and stays unattributed.
 */
function withoutConsumedBoundary(match: string): string {
  return match.replace(/^[\s.!?;:*•-]+/u, "").toLowerCase();
}

/*
 * Attribution is a read-only hint derived after the fact; the joined scan above stays the
 * authority on whether the report is rejected, so nothing here can widen or narrow the gate.
 * Prefer a field whose own scan reproduces the same match, then a field that merely contains the
 * wording -- a sanctioned disclaimer stripped mid-field can hide a match from the per-field scan.
 * When neither holds, the match straddles a field boundary, and undefined says so rather than
 * naming an arbitrary field.
 */
function attributeLanguageViolation(
  segments: readonly ModelAuthoredSegment[],
  match: string,
): string | undefined {
  const wanted = withoutConsumedBoundary(match);
  const rescanned = segments.find((segment) => {
    const found = violatesResearchOnly(segment.text);
    return found !== null && withoutConsumedBoundary(found.match) === wanted;
  });
  if (rescanned !== undefined) {
    return rescanned.path;
  }
  return segments.find((segment) => segment.text.toLowerCase().includes(wanted))?.path;
}

function modelAuthoredReportSegments(report: ResearchReport): readonly ModelAuthoredSegment[] {
  return [
    { path: "summary", text: report.summary },
    ...(
      [
        ["keyFindings", report.keyFindings],
        ["bullCase", report.bullCase],
        ["bearCase", report.bearCase],
        ["risks", report.risks],
        ["catalysts", report.catalysts],
      ] as const
    ).flatMap(([section, findings]) =>
      findings.map((finding, index) => ({
        path: `${section}[${String(index)}]`,
        text: finding.text,
      })),
    ),
    ...report.scenarios.flatMap((scenario, index) => [
      { path: `scenarios[${String(index)}].name`, text: scenario.name },
      { path: `scenarios[${String(index)}].description`, text: scenario.description },
    ]),
    ...modelAuthoredExtraSegments(report.extras),
  ];
}

function modelAuthoredExtraSegments(
  extras: ResearchReport["extras"],
): readonly ModelAuthoredSegment[] {
  if (extras === undefined) {
    return [];
  }
  return [
    ...spotlightsSegments(extras.spotlights),
    ...earningsSetupSegments(extras.earningsSetup),
    ...businessFrameworkSegments(extras.businessFramework),
    ...webSubjectProfileSegments(extras.webSubjectProfile),
  ];
}

/*
 * Both the selection rationale and each item rationale are model-authored: they are read
 * out of parsed model output in research/spotlights.ts and merged in report-assembly.ts.
 */
function spotlightsSegments(extra: unknown): readonly ModelAuthoredSegment[] {
  if (!isRecord(extra)) {
    return [];
  }
  const selectionRationale =
    typeof extra.rationale === "string"
      ? [{ path: "extras.spotlights.rationale", text: extra.rationale }]
      : [];
  if (!Array.isArray(extra.items)) {
    return selectionRationale;
  }
  return [
    ...selectionRationale,
    ...extra.items.flatMap((item, index) => {
      if (!isRecord(item)) {
        return [];
      }
      if (typeof item.rationale === "string") {
        return [
          {
            path: `extras.spotlights.items[${String(index)}].rationale`,
            text: item.rationale,
          },
        ];
      }
      return typeof item.text === "string"
        ? [{ path: `extras.spotlights.items[${String(index)}].text`, text: item.text }]
        : [];
    }),
  ];
}

function earningsSetupSegments(extra: unknown): readonly ModelAuthoredSegment[] {
  if (!isRecord(extra)) {
    return [];
  }
  const segments: ModelAuthoredSegment[] = [];
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const bullets = extra[key];
    if (Array.isArray(bullets)) {
      for (const [index, bullet] of bullets.entries()) {
        if (isRecord(bullet) && typeof bullet.text === "string") {
          segments.push({
            path: `extras.earningsSetup.${key}[${String(index)}].text`,
            text: bullet.text,
          });
        }
      }
    }
  }
  return segments;
}

function businessFrameworkSegments(extra: unknown): readonly ModelAuthoredSegment[] {
  if (!isRecord(extra)) {
    return [];
  }
  return Array.isArray(extra.sections)
    ? extra.sections.flatMap((section, index) =>
        isRecord(section) && typeof section.text === "string"
          ? [
              {
                path: `extras.businessFramework.sections[${String(index)}].text`,
                text: section.text,
              },
            ]
          : [],
      )
    : [];
}

function webSubjectProfileFactSegments(
  path: string,
  value: unknown,
): readonly ModelAuthoredSegment[] {
  return Array.isArray(value)
    ? value.flatMap((fact, index) =>
        isRecord(fact) && typeof fact.claim === "string"
          ? [{ path: `${path}[${String(index)}].claim`, text: fact.claim }]
          : [],
      )
    : [];
}

function webSubjectProfileSegments(extra: unknown): readonly ModelAuthoredSegment[] {
  if (!isRecord(extra)) {
    return [];
  }
  const questionSegments = isRecord(extra.questions)
    ? Object.entries(extra.questions).flatMap(([key, question]) =>
        isRecord(question) && typeof question.answer === "string"
          ? [
              {
                path: `extras.webSubjectProfile.questions.${key}.answer`,
                text: question.answer,
              },
            ]
          : [],
      )
    : [];
  return [
    ...(isRecord(extra.subjectSummary) && typeof extra.subjectSummary.answer === "string"
      ? [
          {
            path: "extras.webSubjectProfile.subjectSummary.answer",
            text: extra.subjectSummary.answer,
          },
        ]
      : []),
    ...questionSegments,
    ...webSubjectProfileFactSegments(
      "extras.webSubjectProfile.recentMaterialEvents",
      extra.recentMaterialEvents,
    ),
    ...webSubjectProfileFactSegments("extras.webSubjectProfile.factLedger", extra.factLedger),
    ...readStringArray(extra.openGaps).map((text, index) => ({
      path: `extras.webSubjectProfile.openGaps[${String(index)}]`,
      text,
    })),
  ];
}

function validateEarningsSetupExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (extra === undefined || !isRecord(extra)) {
    return;
  }
  // Validate source IDs on event.
  const event = isRecord(extra.event) ? extra.event : undefined;
  if (event !== undefined) {
    if (event.eventDateStatus !== undefined && !isEarningsEventDateStatus(event.eventDateStatus)) {
      throw new Error("Earnings Setup eventDateStatus is invalid");
    }
    validateKnownSourceIds(
      "Earnings Setup event.sourceIds",
      readStringArray(event.sourceIds),
      knownSourceIds,
      false,
      errors,
    );
    const confirmation = isRecord(event.dateConfirmation) ? event.dateConfirmation : undefined;
    if (event.eventDateStatus === "provider-estimated" && confirmation !== undefined) {
      throw new Error("Provider-estimated Earnings Setup cannot carry date confirmation");
    }
    if (
      event.eventDateStatus === "issuer-confirmed" ||
      event.eventDateStatus === "exchange-confirmed"
    ) {
      const sourceId = confirmation?.sourceId;
      const sourceType = confirmation?.sourceType;
      const evidenceSpan = confirmation?.evidenceSpan;
      const sourceUrl = confirmation?.sourceUrl;
      const confirmedAt = confirmation?.confirmedAt;
      const identity = isRecord(confirmation?.issuerIdentity)
        ? confirmation.issuerIdentity
        : undefined;
      if (
        typeof sourceId !== "string" ||
        !knownSourceIds.has(sourceId) ||
        !readStringArray(event.sourceIds).includes(sourceId) ||
        (event.eventDateStatus === "issuer-confirmed"
          ? sourceType !== "issuer-ir-event" &&
            sourceType !== "issuer-press-release" &&
            sourceType !== "sec-8-k" &&
            sourceType !== "sec-6-k"
          : sourceType !== "official-exchange") ||
        typeof evidenceSpan !== "string" ||
        typeof event.date !== "string" ||
        retainedEvidenceSpanForEarningsDate(evidenceSpan, event.date) === undefined ||
        typeof sourceUrl !== "string" ||
        sourceUrl.trim() === "" ||
        typeof confirmedAt !== "string" ||
        confirmedAt.trim() === "" ||
        identity?.symbol !== event.symbol
      ) {
        throw new Error("Confirmed Earnings Setup requires complete official evidence");
      }
    }
  }
  // Validate source IDs on the deterministic implied move.
  const impliedMove = isRecord(extra.impliedMove) ? extra.impliedMove : undefined;
  if (impliedMove !== undefined) {
    validateKnownSourceIds(
      "Earnings Setup impliedMove.sourceIds",
      readStringArray(impliedMove.sourceIds),
      knownSourceIds,
      false,
      errors,
    );
  }
  // Validate source IDs on model-authored bullet sections.
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const bullets = extra[key];
    if (!Array.isArray(bullets)) {
      continue;
    }
    for (const [index, bullet] of bullets.entries()) {
      if (isRecord(bullet)) {
        validateKnownSourceIds(
          `Earnings Setup ${key}[${index}]`,
          readStringArray(bullet.sourceIds),
          knownSourceIds,
          typeof bullet.text === "string",
          errors,
        );
      }
    }
  }
}

function validateEarningsForecastCertainty(report: ResearchReport): void {
  const earningsPredictions = report.predictions.filter(
    (prediction) => prediction.kind === "earnings-direction" || prediction.kind === "earnings-move",
  );
  for (const prediction of earningsPredictions) {
    if (
      prediction.eventDateStatus !== undefined &&
      !isEarningsEventDateStatus(prediction.eventDateStatus)
    ) {
      throw new Error(`Prediction ${prediction.id} has invalid eventDateStatus`);
    }
  }

  const rawTelemetry = report.extras?.earningsForecasts;
  const telemetry = readEarningsForecastTelemetry(report);
  if (rawTelemetry !== undefined && telemetry === undefined) {
    throw new Error("Earnings forecast telemetry is invalid");
  }
  if (telemetry === undefined) {
    return;
  }
  if (telemetry.eligiblePredictionCount !== earningsPredictions.length) {
    throw new Error("Earnings forecast telemetry eligible count conflicts with report predictions");
  }
  const confirmedStatus =
    telemetry.eventDateStatus === "issuer-confirmed" ||
    telemetry.eventDateStatus === "exchange-confirmed";
  if (telemetry.policy === "confirmed-only") {
    if (telemetry.grammarEligible !== confirmedStatus) {
      throw new Error("Earnings forecast telemetry eligibility conflicts with event-date status");
    }
    if (!confirmedStatus && earningsPredictions.length > 0) {
      throw new Error("Unconfirmed earnings dates cannot anchor earnings predictions");
    }
  }
  if (telemetry.eventDateStatus === "not-present") {
    return;
  }
  for (const prediction of earningsPredictions) {
    if (prediction.eventDateStatus !== telemetry.eventDateStatus) {
      throw new Error(`Prediction ${prediction.id} eventDateStatus conflicts with telemetry`);
    }
  }
}

function validateBusinessFrameworkExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Business Framework sourceIds",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
    errors,
  );
  if (!Array.isArray(extra.sections)) {
    return;
  }
  for (const [index, section] of extra.sections.entries()) {
    if (!isRecord(section)) {
      continue;
    }
    const sectionName = typeof section.name === "string" ? ` (${section.name})` : "";
    validateKnownSourceIds(
      `Business Framework sections[${index}]${sectionName}`,
      readStringArray(section.sourceIds),
      knownSourceIds,
      typeof section.text === "string",
      errors,
    );
  }
  if (isRecord(extra.reconciliation)) {
    validateKnownSourceIds(
      "Business Framework reconciliation.profileSourceIds",
      readStringArray(extra.reconciliation.profileSourceIds),
      knownSourceIds,
      false,
      errors,
    );
  }
}

function validateWebSubjectProfileExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Web Subject Profile sourceIds",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
    errors,
  );
  if (isRecord(extra.subjectSummary)) {
    validateKnownSourceIds(
      "Web Subject Profile subjectSummary",
      readStringArray(extra.subjectSummary.sourceIds),
      knownSourceIds,
      typeof extra.subjectSummary.answer === "string" && extra.subjectSummary.answer !== "",
      errors,
    );
  }
  if (isRecord(extra.questions)) {
    for (const [key, question] of Object.entries(extra.questions)) {
      if (isRecord(question)) {
        validateKnownSourceIds(
          `Web Subject Profile questions.${key}`,
          readStringArray(question.sourceIds),
          knownSourceIds,
          typeof question.answer === "string" && question.answer !== "",
          errors,
        );
      }
    }
  }
  for (const key of ["recentMaterialEvents", "factLedger"] as const) {
    const facts = extra[key];
    if (!Array.isArray(facts)) {
      continue;
    }
    for (const [index, fact] of facts.entries()) {
      if (isRecord(fact)) {
        validateKnownSourceIds(
          `Web Subject Profile ${key}[${index}]`,
          readStringArray(fact.sourceIds),
          knownSourceIds,
          typeof fact.claim === "string" && fact.claim !== "",
          errors,
        );
      }
    }
  }
}

function validateHistoricalContextExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Historical Context sourceIds",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
    errors,
  );
  if (!Array.isArray(extra.items)) {
    return;
  }
  for (const [index, item] of extra.items.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      `Historical Context items[${index}]`,
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.text === "string",
      errors,
    );
  }
}

function validateSpotlightsExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return;
  }
  for (const [index, item] of extra.items.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      `Market Spotlights items[${index}]`,
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.symbol === "string" &&
        (typeof item.rationale === "string" || typeof item.text === "string"),
      errors,
    );
  }
}

function validateCatalystCalendarExtra(
  extra: unknown,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return;
  }
  for (const [index, item] of extra.items.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      `Catalyst Calendar items[${index}]`,
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.label === "string",
      errors,
    );
  }
}

function validateResearchSubjectExtra(extra: unknown): void {
  if (extra === undefined) {
    return;
  }
  if (!isRecord(extra)) {
    throw new Error("Research subject extra must be an object");
  }
  if (extra.input !== undefined && typeof extra.input !== "string") {
    throw new Error("Research subject input must be a string");
  }
  if (extra.subjectKey !== undefined && typeof extra.subjectKey !== "string") {
    throw new Error("Research subject key must be a string");
  }
}

function validateProxyResolutionExtra(extra: unknown): void {
  if (extra === undefined) {
    return;
  }
  if (!isRecord(extra)) {
    throw new Error("Research proxy resolution extra must be an object");
  }
  if (
    extra.predictionProxySymbol !== undefined &&
    typeof extra.predictionProxySymbol !== "string"
  ) {
    throw new Error("Research prediction proxy symbol must be a string");
  }
}

function validateRenderedExtras(
  extras: ResearchReport["extras"],
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (extras === undefined) {
    return;
  }
  validateHistoricalContextExtra(extras.historicalContext, knownSourceIds, errors);
  validateSpotlightsExtra(extras.spotlights, knownSourceIds, errors);
  validateCatalystCalendarExtra(extras.catalystCalendar, knownSourceIds, errors);
  validateResearchSubjectExtra(extras.researchSubject);
  validateProxyResolutionExtra(extras.proxyResolution);
  validateEarningsSetupExtra(extras.earningsSetup, knownSourceIds, errors);
  validateBusinessFrameworkExtra(extras.businessFramework, knownSourceIds, errors);
  validateWebSubjectProfileExtra(extras.webSubjectProfile, knownSourceIds, errors);
}

function validateEquityAnalysisCompleteness(
  report: ResearchReport,
  knownSourceIds: ReadonlySet<string>,
  errors: string[],
): void {
  const completeness = report.equityAnalysisCompleteness;
  if (completeness === undefined) {
    return;
  }
  if (report.jobType !== "equity" || report.assetClass !== "equity") {
    throw new Error("Equity analysis completeness is allowed only on equity reports");
  }
  assertEquityAnalysisCompleteness(completeness);
  for (const key of EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS) {
    const dimension = completeness.dimensions[key];
    validateKnownSourceIds(
      `equityAnalysisCompleteness.${key}`,
      dimension.sourceIds,
      knownSourceIds,
      false,
      errors,
    );
  }
}

export function validatePredictions(
  candidates: readonly unknown[],
  knownSourceIds: ReadonlySet<string>,
  allowedSubjects?: ReadonlySet<string>,
): PredictionValidationResult {
  const result = readObservableForecasts(candidates, {
    knownSourceIds,
    requireSourceIds: true,
    ...(allowedSubjects !== undefined ? { allowedSubjects } : {}),
  });
  const errors = result.issues
    .filter((issue) => issue.code !== "redundant-prediction")
    .map((issue) => issue.message);
  return { valid: result.predictions, errors, issues: result.issues };
}

export function validateResearchReport(report: ResearchReport): ResearchReport {
  if (report.notFinancialAdvice !== true) {
    throw new Error("Report must set notFinancialAdvice to true");
  }

  const evidenceQuality = report.evidenceQuality ?? report.confidence;
  if (evidenceQuality === undefined) {
    throw new Error("Research report must include evidenceQuality or legacy confidence");
  }
  if (
    report.evidenceQuality !== undefined &&
    report.confidence !== undefined &&
    report.evidenceQuality !== report.confidence
  ) {
    throw new Error("Research report evidenceQuality conflicts with legacy confidence");
  }
  assertEvidenceQuality(evidenceQuality);
  /*
   * Report Integrity / Research Quality are optional at tolerant read
   * boundaries (historical reports predate them) but must be valid when set.
   */
  for (const [field, value] of [
    ["reportIntegrity", report.reportIntegrity],
    ["researchQuality", report.researchQuality],
  ] as const) {
    if (value !== undefined && !isReportIntegrity(value)) {
      throw new Error(`Research report ${field} must be high, medium, or low`);
    }
  }
  if (report.researchQualityDriver !== undefined && report.researchQualityDriver.trim() === "") {
    throw new Error("Research report researchQualityDriver must be non-empty when set");
  }
  if (report.predictionShortfall !== undefined) {
    validatePredictionShortfall(report.predictionShortfall);
  }

  const knownSourceIds = new Set(report.sources.map((source) => source.id));
  const sourceIdErrors: string[] = [];

  assertSourceKinds(report.sources);
  validateFindings("keyFindings", report.keyFindings, knownSourceIds, sourceIdErrors);
  validateFindings("bullCase", report.bullCase, knownSourceIds, sourceIdErrors);
  validateFindings("bearCase", report.bearCase, knownSourceIds, sourceIdErrors);
  validateFindings("risks", report.risks, knownSourceIds, sourceIdErrors);
  validateFindings("catalysts", report.catalysts, knownSourceIds, sourceIdErrors);
  validateScenarios(report.scenarios, knownSourceIds, sourceIdErrors);
  validateEquityAnalysisCompleteness(report, knownSourceIds, sourceIdErrors);
  validateRenderedExtras(report.extras, knownSourceIds, sourceIdErrors);
  assertNoSourceIdErrors(sourceIdErrors);
  validateEarningsForecastCertainty(report);
  assertSafeReportLanguage(report);

  return report;
}
