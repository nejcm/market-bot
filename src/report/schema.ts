import type { EvidenceQuality, KeyFinding, ResearchReport, Scenario } from "../domain/types";

export const RESEARCH_ONLY_NOTE =
  "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes.";

const TRADE_ACTION_PATTERN =
  /\b(buy|sell|hold|go long|go short|short this|accumulate|reduce exposure|increase exposure|rebalance|take profit|stop loss|position size|position sizing|execute|execution instruction|portfolio change|allocation change)\b/i;

function assertEvidenceQuality(value: string): asserts value is EvidenceQuality {
  if (value !== "high" && value !== "medium" && value !== "low") {
    throw new Error(`Invalid Evidence Quality: ${value}`);
  }
}

function validateSourceIds(sourceIds: readonly string[], knownSourceIds: ReadonlySet<string>): void {
  if (sourceIds.length === 0) {
    throw new Error("Major findings must reference source IDs");
  }

  for (const sourceId of sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new Error(`Unknown source ID: ${sourceId}`);
    }
  }
}

function validateFindings(findings: readonly KeyFinding[], knownSourceIds: ReadonlySet<string>): void {
  for (const finding of findings) {
    validateSourceIds(finding.sourceIds, knownSourceIds);
  }
}

function validateScenarios(scenarios: readonly Scenario[], knownSourceIds: ReadonlySet<string>): void {
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

  if (TRADE_ACTION_PATTERN.test(text)) {
    throw new Error("Report contains trade-action language");
  }
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
