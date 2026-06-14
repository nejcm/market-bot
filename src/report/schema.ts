import type {
  EvidenceQuality,
  KeyFinding,
  Prediction,
  ResearchReport,
  Scenario,
} from "../domain/types";
import { violatesResearchOnly } from "../domain/research-language";
import { readObservableForecasts, type ObservableForecastIssue } from "../forecast/observable";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateRenderedExtras(
  extras: ResearchReport["extras"],
  knownSourceIds: ReadonlySet<string>,
): void {
  if (extras === undefined) {
    return;
  }
  validateHistoricalContextExtra(extras.historicalContext, knownSourceIds);
  validateSpotlightsExtra(extras.spotlights, knownSourceIds);
}

export function validatePredictions(
  candidates: readonly unknown[],
  knownSourceIds: ReadonlySet<string>,
): PredictionValidationResult {
  const result = readObservableForecasts(candidates, { knownSourceIds });
  return { valid: result.predictions, errors: result.promptErrors, issues: result.issues };
}

export function validateResearchReport(report: ResearchReport): ResearchReport {
  if (report.notFinancialAdvice !== true) {
    throw new Error("Report must set notFinancialAdvice to true");
  }

  assertEvidenceQuality(report.confidence);

  const knownSourceIds = new Set(report.sources.map((source) => source.id));

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
