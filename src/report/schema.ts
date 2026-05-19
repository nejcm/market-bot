import type {
  EvidenceQuality,
  KeyFinding,
  Prediction,
  ResearchReport,
  Scenario,
} from "../domain/types";
import { parseMeasurableAs } from "../scoring/dsl";

export const RESEARCH_ONLY_NOTE =
  "Research-only note: This report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes. Predictions are probabilistic statements about future observable market quantities, not trade recommendations. Acting on them is the reader's decision.";

const TRADE_ACTION_PATTERN =
  /\b(buy|sell|hold|go long|go short|short this|accumulate|reduce exposure|increase exposure|rebalance|take profit|stop loss|position size|position sizing|execute|execution instruction|portfolio change|allocation change)\b/iu;

const READER_ACTION_PATTERN = /\b(consider|watch for|should|could be a|expect to)\b/iu;

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

  if (TRADE_ACTION_PATTERN.test(text)) {
    throw new Error("Report contains trade-action language");
  }
}

// oxlint-disable-next-line max-lines-per-function
export function validatePredictions(
  candidates: readonly unknown[],
  knownSourceIds: ReadonlySet<string>,
): PredictionValidationResult {
  const valid: Prediction[] = [];
  const errors: string[] = [];

  for (const item of candidates) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push("Prediction must be an object");
      continue;
    }

    const p = item as Record<string, unknown>;
    const id = typeof p["id"] === "string" ? p["id"] : undefined;
    const claim = typeof p["claim"] === "string" ? p["claim"] : undefined;
    const { kind } = p;
    const subject = typeof p["subject"] === "string" ? p["subject"] : undefined;
    const measurableAs = typeof p["measurableAs"] === "string" ? p["measurableAs"] : undefined;
    const horizonTradingDays =
      typeof p["horizonTradingDays"] === "number" ? p["horizonTradingDays"] : undefined;
    const probability = typeof p["probability"] === "number" ? p["probability"] : undefined;
    const sourceIds = Array.isArray(p["sourceIds"])
      ? (p["sourceIds"] as unknown[]).filter((s): s is string => typeof s === "string")
      : [];

    if (id === undefined) {
      errors.push("Prediction missing id");
      continue;
    }
    if (claim === undefined) {
      errors.push(`Prediction ${id}: missing claim`);
      continue;
    }
    if (kind !== "direction" && kind !== "relative" && kind !== "volatility" && kind !== "range") {
      errors.push(`Prediction ${id}: invalid kind "${String(kind)}"`);
      continue;
    }
    if (subject === undefined) {
      errors.push(`Prediction ${id}: missing subject`);
      continue;
    }
    if (kind === "relative" && !/^[^:\s]+:[^:\s]+$/u.test(subject)) {
      errors.push(`Prediction ${id}: relative subject must be "A:B" form, got "${subject}"`);
      continue;
    }
    if (measurableAs === undefined) {
      errors.push(`Prediction ${id}: missing measurableAs`);
      continue;
    }
    if (horizonTradingDays === undefined || horizonTradingDays < 1 || horizonTradingDays > 20) {
      errors.push(`Prediction ${id}: horizonTradingDays must be 1–20`);
      continue;
    }
    if (probability === undefined || probability < 0 || probability > 1) {
      errors.push(`Prediction ${id}: probability must be 0–1`);
      continue;
    }
    if (TRADE_ACTION_PATTERN.test(claim)) {
      errors.push(`Prediction ${id}: claim contains trade-action language`);
      continue;
    }
    if (READER_ACTION_PATTERN.test(claim)) {
      errors.push(`Prediction ${id}: claim contains reader-directed language`);
      continue;
    }

    try {
      parseMeasurableAs(measurableAs);
    } catch {
      errors.push(`Prediction ${id}: unparseable measurableAs: "${measurableAs}"`);
      continue;
    }

    let badSource = false;
    for (const sid of sourceIds) {
      if (!knownSourceIds.has(sid)) {
        errors.push(`Prediction ${id}: unknown sourceId "${sid}"`);
        badSource = true;
      }
    }
    if (badSource) {
      continue;
    }

    valid.push({
      id,
      claim,
      kind,
      subject,
      measurableAs,
      horizonTradingDays,
      probability,
      sourceIds,
    });
  }

  return { valid, errors };
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
