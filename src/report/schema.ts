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
import { readEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { resolveCoverageLevel } from "../sources/extended-evidence/equity-analysis-completeness";
import { retainedEvidenceSpanForEarningsDate } from "../sources/extended-evidence/earnings-date-confirmation";
import { violatesResearchOnly } from "../domain/research-language";
import { readObservableForecasts, type ObservableForecastIssue } from "../forecast/observable";
import { isRecord } from "../guards";

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

function extendedEvidenceLanguageText(report: ResearchReport): readonly {
  readonly title: string;
  readonly summary: string;
}[] {
  return (
    report.extendedEvidence?.items.map((item) => ({
      title: item.title,
      summary: item.summary,
    })) ?? []
  );
}

export function assertSafeReportLanguage(report: ResearchReport): void {
  const text = JSON.stringify({
    summary: report.summary,
    keyFindings: report.keyFindings,
    bullCase: report.bullCase,
    bearCase: report.bearCase,
    risks: report.risks,
    catalysts: report.catalysts,
    scenarios: report.scenarios,
    researchQualityDriver: report.researchQualityDriver,
    extendedEvidence: extendedEvidenceLanguageText(report),
    renderedExtras: researchOnlyExtraText(report.extras),
  });

  const violation = violatesResearchOnly(text);
  if (violation !== null) {
    throw new Error(`Report contains trade-action language: "${violation.match}"`);
  }
}

function researchOnlyExtraText(extras: ResearchReport["extras"]): Record<string, unknown> {
  if (extras === undefined) {
    return {};
  }
  return {
    historicalContext: historicalContextText(extras.historicalContext),
    spotlights: spotlightsText(extras.spotlights),
    catalystCalendar: catalystCalendarText(extras.catalystCalendar),
    earningsSetup: earningsSetupText(extras.earningsSetup),
    businessFramework: businessFrameworkText(extras.businessFramework),
    webSubjectProfile: webSubjectProfileText(extras.webSubjectProfile),
  };
}

function historicalContextText(extra: unknown): readonly string[] {
  if (!isRecord(extra)) {
    return [];
  }
  return [
    ...(typeof extra.summary === "string" ? [extra.summary] : []),
    ...(Array.isArray(extra.items)
      ? extra.items.flatMap((item) =>
          isRecord(item) && typeof item.text === "string" ? [item.text] : [],
        )
      : []),
    ...readStringArray(extra.gaps),
  ];
}

function spotlightsText(extra: unknown): readonly string[] {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return [];
  }
  return extra.items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    if (typeof item.rationale === "string") {
      return [item.rationale];
    }
    return typeof item.text === "string" ? [item.text] : [];
  });
}

function catalystCalendarText(extra: unknown): readonly string[] {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return [];
  }
  return extra.items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    return [
      typeof item.label === "string" ? item.label : undefined,
      typeof item.sourceStatus === "string" ? item.sourceStatus : undefined,
      typeof item.researchRelevance === "string" ? item.researchRelevance : undefined,
    ].filter((value): value is string => value !== undefined);
  });
}

function earningsSetupText(extra: unknown): readonly string[] {
  if (!isRecord(extra)) {
    return [];
  }
  const texts: string[] = [];
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const bullets = extra[key];
    if (Array.isArray(bullets)) {
      for (const bullet of bullets) {
        if (isRecord(bullet) && typeof bullet.text === "string") {
          texts.push(bullet.text);
        }
      }
    }
  }
  texts.push(...readStringArray(extra.gaps));
  return texts;
}

function businessFrameworkText(extra: unknown): readonly string[] {
  if (!isRecord(extra)) {
    return [];
  }
  return [
    ...readStringArray(extra.gaps),
    ...(Array.isArray(extra.sections)
      ? extra.sections.flatMap((section) => {
          if (!isRecord(section)) {
            return [];
          }
          return [
            typeof section.text === "string" ? section.text : undefined,
            ...readStringArray(section.gaps),
          ].filter((value): value is string => value !== undefined);
        })
      : []),
  ];
}

function webSubjectProfileFactTexts(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((fact) =>
        isRecord(fact) && typeof fact.claim === "string" ? [fact.claim] : [],
      )
    : [];
}

function webSubjectProfileText(extra: unknown): readonly string[] {
  if (!isRecord(extra)) {
    return [];
  }
  const questionTexts = isRecord(extra.questions)
    ? Object.values(extra.questions).flatMap((question) =>
        isRecord(question) && typeof question.answer === "string" ? [question.answer] : [],
      )
    : [];
  return [
    ...(isRecord(extra.subjectSummary) && typeof extra.subjectSummary.answer === "string"
      ? [extra.subjectSummary.answer]
      : []),
    ...questionTexts,
    ...webSubjectProfileFactTexts(extra.recentMaterialEvents),
    ...webSubjectProfileFactTexts(extra.factLedger),
    ...readStringArray(extra.openGaps),
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

const COMPLETENESS_DIMENSION_KEYS = [
  "primaryFinancials",
  "valuation",
  "expectations",
  "capitalOwnership",
  "operatingKpis",
] as const;

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.includes("T") && Number.isFinite(Date.parse(value));
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
  if (completeness.version !== 1 || !isIsoTimestamp(completeness.asOf)) {
    throw new Error("Equity analysis completeness requires version 1 and an ISO asOf timestamp");
  }
  const primaryStatus = completeness.dimensions.primaryFinancials.status;
  if (primaryStatus !== "complete" && primaryStatus !== "partial" && primaryStatus !== "blocked") {
    throw new Error("Primary financial completeness status is invalid");
  }
  if (completeness.financialCoreStatus !== primaryStatus) {
    throw new Error("Financial core status must equal the primaryFinancials status");
  }
  for (const key of COMPLETENESS_DIMENSION_KEYS) {
    const dimension = completeness.dimensions[key];
    if (
      dimension.status !== "complete" &&
      dimension.status !== "partial" &&
      dimension.status !== "blocked" &&
      dimension.status !== "not-applicable" &&
      dimension.status !== "not-assessed"
    ) {
      throw new Error(`Equity analysis completeness ${key} status is invalid`);
    }
    if (!isIsoTimestamp(dimension.asOf)) {
      throw new Error(`Equity analysis completeness ${key} asOf must be an ISO timestamp`);
    }
    if (dimension.reasonCodes.some((code) => code.trim() === "")) {
      throw new Error(`Equity analysis completeness ${key} reason codes must be non-empty`);
    }
    validateKnownSourceIds(
      `equityAnalysisCompleteness.${key}`,
      dimension.sourceIds,
      knownSourceIds,
      false,
      errors,
    );
    if (
      dimension.status === "not-applicable" &&
      (dimension.sourceIds.length === 0 ||
        dimension.reasonCodes.length === 0 ||
        dimension.reasonCodes.some((code) => /credential|entitlement/iu.test(code)))
    ) {
      throw new Error(
        `Equity analysis completeness ${key} not-applicable status requires affirmative evidence`,
      );
    }
    if (dimension.status === "not-assessed" && dimension.reasonCodes.length === 0) {
      throw new Error(
        `Equity analysis completeness ${key} not-assessed status requires a reason code`,
      );
    }
  }
  const dimensions = [
    completeness.dimensions.valuation,
    completeness.dimensions.expectations,
    completeness.dimensions.capitalOwnership,
    completeness.dimensions.operatingKpis,
  ];
  const expectedCoverage = resolveCoverageLevel(dimensions, primaryStatus);
  if (completeness.coverageLevel !== expectedCoverage) {
    throw new Error("Equity analysis completeness coverageLevel conflicts with dimension statuses");
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
  // Report Integrity / Research Quality are optional at tolerant read
  // Boundaries (historical reports predate them) but must be valid when set.
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
