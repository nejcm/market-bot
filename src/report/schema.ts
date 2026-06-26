import {
  SOURCE_KINDS,
  type EvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
import { violatesResearchOnly } from "../domain/research-language";
import { readObservableForecasts, type ObservableForecastIssue } from "../forecast/observable";
import { isRecord } from "../sources/guards";

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
    renderedExtras: researchOnlyExtraText(report.extras),
  });

  if (violatesResearchOnly(text) !== null) {
    throw new Error("Report contains trade-action language");
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

  assertEvidenceQuality(report.confidence);

  const knownSourceIds = new Set(report.sources.map((source) => source.id));

  assertSourceKinds(report.sources);
  validateFindings(report.keyFindings, knownSourceIds);
  validateFindings(report.bullCase, knownSourceIds);
  validateFindings(report.bearCase, knownSourceIds);
  validateFindings(report.risks, knownSourceIds);
  validateFindings(report.catalysts, knownSourceIds);
  validateScenarios(report.scenarios, knownSourceIds);
  validateRenderedExtras(report.extras, knownSourceIds);
  assertSafeReportLanguage(report);

  return report;
}
