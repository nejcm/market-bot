import {
  isReportIntegrity,
  SOURCE_KINDS,
  type EvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
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

function validateSourceIds(
  sourceIds: readonly string[],
  knownSourceIds: ReadonlySet<string>,
): void {
  if (sourceIds.length === 0) {
    throw new Error("Major findings must reference source IDs");
  }

  for (const sourceId of sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new Error(`Unknown source ID: ${sourceId}`);
    }
  }
}

// This raw-value reader is all-or-nothing and falls back to an empty array.
// The shared guards instead read record keys or filter mixed arrays.
function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function validateKnownSourceIds(
  section: string,
  sourceIds: readonly string[],
  knownSourceIds: ReadonlySet<string>,
  requireAny: boolean,
): void {
  if (requireAny && sourceIds.length === 0) {
    throw new Error(`${section} items must reference source IDs`);
  }
  for (const sourceId of sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new Error(`Unknown source ID: ${sourceId}`);
    }
  }
}

function validateFindings(
  findings: readonly KeyFinding[],
  knownSourceIds: ReadonlySet<string>,
): void {
  for (const finding of findings) {
    validateSourceIds(finding.sourceIds, knownSourceIds);
  }
}

function validateScenarios(
  scenarios: readonly Scenario[],
  knownSourceIds: ReadonlySet<string>,
): void {
  for (const scenario of scenarios) {
    validateSourceIds(scenario.sourceIds, knownSourceIds);
  }
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

function validateEarningsSetupExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (extra === undefined || !isRecord(extra)) {
    return;
  }
  // Validate source IDs on event.
  const event = isRecord(extra.event) ? extra.event : undefined;
  if (event !== undefined) {
    validateKnownSourceIds(
      "Earnings Setup event",
      readStringArray(event.sourceIds),
      knownSourceIds,
      false,
    );
  }
  // Validate source IDs on the deterministic implied move.
  const impliedMove = isRecord(extra.impliedMove) ? extra.impliedMove : undefined;
  if (impliedMove !== undefined) {
    validateKnownSourceIds(
      "Earnings Setup impliedMove",
      readStringArray(impliedMove.sourceIds),
      knownSourceIds,
      false,
    );
  }
  // Validate source IDs on model-authored bullet sections.
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const bullets = extra[key];
    if (!Array.isArray(bullets)) {
      continue;
    }
    for (const bullet of bullets) {
      if (isRecord(bullet)) {
        validateKnownSourceIds(
          `Earnings Setup ${key}`,
          readStringArray(bullet.sourceIds),
          knownSourceIds,
          typeof bullet.text === "string",
        );
      }
    }
  }
}

function validateBusinessFrameworkExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Business Framework",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
  );
  if (!Array.isArray(extra.sections)) {
    return;
  }
  for (const section of extra.sections) {
    if (!isRecord(section)) {
      continue;
    }
    validateKnownSourceIds(
      "Business Framework",
      readStringArray(section.sourceIds),
      knownSourceIds,
      typeof section.text === "string",
    );
  }
  if (isRecord(extra.reconciliation)) {
    validateKnownSourceIds(
      "Business Framework reconciliation",
      readStringArray(extra.reconciliation.profileSourceIds),
      knownSourceIds,
      false,
    );
  }
}

function validateWebSubjectProfileExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Web Subject Profile",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
  );
  if (isRecord(extra.subjectSummary)) {
    validateKnownSourceIds(
      "Web Subject Profile",
      readStringArray(extra.subjectSummary.sourceIds),
      knownSourceIds,
      typeof extra.subjectSummary.answer === "string" && extra.subjectSummary.answer !== "",
    );
  }
  if (isRecord(extra.questions)) {
    for (const question of Object.values(extra.questions)) {
      if (isRecord(question)) {
        validateKnownSourceIds(
          "Web Subject Profile",
          readStringArray(question.sourceIds),
          knownSourceIds,
          typeof question.answer === "string" && question.answer !== "",
        );
      }
    }
  }
  for (const key of ["recentMaterialEvents", "factLedger"] as const) {
    const facts = extra[key];
    if (!Array.isArray(facts)) {
      continue;
    }
    for (const fact of facts) {
      if (isRecord(fact)) {
        validateKnownSourceIds(
          "Web Subject Profile",
          readStringArray(fact.sourceIds),
          knownSourceIds,
          typeof fact.claim === "string" && fact.claim !== "",
        );
      }
    }
  }
}

function validateHistoricalContextExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (!isRecord(extra)) {
    return;
  }
  validateKnownSourceIds(
    "Historical Context",
    readStringArray(extra.sourceIds),
    knownSourceIds,
    false,
  );
  if (!Array.isArray(extra.items)) {
    return;
  }
  for (const item of extra.items) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      "Historical Context",
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.text === "string",
    );
  }
}

function validateSpotlightsExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return;
  }
  for (const item of extra.items) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      "Market Spotlights",
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.symbol === "string" &&
        (typeof item.rationale === "string" || typeof item.text === "string"),
    );
  }
}

function validateCatalystCalendarExtra(extra: unknown, knownSourceIds: ReadonlySet<string>): void {
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return;
  }
  for (const item of extra.items) {
    if (!isRecord(item)) {
      continue;
    }
    validateKnownSourceIds(
      "Catalyst Calendar",
      readStringArray(item.sourceIds),
      knownSourceIds,
      typeof item.label === "string",
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
): void {
  if (extras === undefined) {
    return;
  }
  validateHistoricalContextExtra(extras.historicalContext, knownSourceIds);
  validateSpotlightsExtra(extras.spotlights, knownSourceIds);
  validateCatalystCalendarExtra(extras.catalystCalendar, knownSourceIds);
  validateResearchSubjectExtra(extras.researchSubject);
  validateProxyResolutionExtra(extras.proxyResolution);
  validateEarningsSetupExtra(extras.earningsSetup, knownSourceIds);
  validateBusinessFrameworkExtra(extras.businessFramework, knownSourceIds);
  validateWebSubjectProfileExtra(extras.webSubjectProfile, knownSourceIds);
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
      dimension.status !== "not-applicable"
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
  }
  const completeOrNotApplicable = [
    completeness.dimensions.valuation,
    completeness.dimensions.expectations,
    completeness.dimensions.capitalOwnership,
    completeness.dimensions.operatingKpis,
  ].filter(
    (dimension) => dimension.status === "complete" || dimension.status === "not-applicable",
  ).length;
  let expectedCoverage: "comprehensive" | "substantial" | "limited" = "substantial";
  if (primaryStatus !== "complete" || completeOrNotApplicable <= 1) {
    expectedCoverage = "limited";
  } else if (completeOrNotApplicable === 4) {
    expectedCoverage = "comprehensive";
  }
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

  assertSourceKinds(report.sources);
  validateFindings(report.keyFindings, knownSourceIds);
  validateFindings(report.bullCase, knownSourceIds);
  validateFindings(report.bearCase, knownSourceIds);
  validateFindings(report.risks, knownSourceIds);
  validateFindings(report.catalysts, knownSourceIds);
  validateScenarios(report.scenarios, knownSourceIds);
  validateEquityAnalysisCompleteness(report, knownSourceIds);
  validateRenderedExtras(report.extras, knownSourceIds);
  assertSafeReportLanguage(report);

  return report;
}
