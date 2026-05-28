import type {
  EvidenceQuality,
  KeyFinding,
  Prediction,
  ResearchReport,
  Scenario,
} from "../domain/types";
import { violatesResearchOnly } from "../domain/research-language";
import { readObservableForecasts } from "../forecast/observable";

export const RESEARCH_ONLY_NOTE =
  "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision.";

export interface PredictionValidationResult {
  readonly valid: readonly Prediction[];
  readonly errors: readonly string[];
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
  });

  if (violatesResearchOnly(text) !== null) {
    throw new Error("Report contains trade-action language");
  }
}

export function validatePredictions(
  candidates: readonly unknown[],
  knownSourceIds: ReadonlySet<string>,
): PredictionValidationResult {
  const result = readObservableForecasts(candidates, { knownSourceIds });
  return { valid: result.predictions, errors: result.promptErrors };
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
  assertSafeReportLanguage(report);

  return report;
}
