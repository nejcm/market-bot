import {
  researchReportEvidenceQuality,
  type EvidenceQuality,
  type KeyFinding,
  type Prediction,
  type ReportIntegrity,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
import {
  hasNoSupportingSource,
  hasPostureLabel,
  isHistoricalForecastOutcome,
  isNumericClaim,
  isTechnicalClaim,
  shouldCarryPostureLabel,
} from "./post-synthesis-audit";

// Deterministic Report Integrity Audit (ADR 0011). Distinct from the warn-only
// Post-Synthesis Audit: this pass prunes blocking violations — numeric or
// Technical findings, scenarios, and predictions without an eligible supporting
// Source (structural eligibility only; no semantic-entailment claims) — before
// Forecast disagreement, then grades the outcome. Summary sentences (no
// Citation field exists) and missing evidence-posture labels stay advisory
// Telemetry and are never pruned.

export interface ReportIntegrityPrunedItem {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export type ReportIntegrityAdvisoryCode =
  | "uncited-numeric-summary-sentence"
  | "weak-evidence-posture-missing";

export interface ReportIntegrityAdvisory {
  readonly code: ReportIntegrityAdvisoryCode;
  readonly location: string;
}

export interface ReportIntegrityAuditResult {
  readonly report: ResearchReport;
  readonly reportIntegrity: ReportIntegrity;
  readonly researchQuality: ReportIntegrity;
  readonly prunedItemCount: number;
  readonly advisoryWarningCount: number;
  readonly pruned: readonly ReportIntegrityPrunedItem[];
  readonly advisories: readonly ReportIntegrityAdvisory[];
}

// Bare calendar years and forecast-horizon phrasing are not numeric claims for
// Pruning purposes: "revenue guidance for 2026" or "a 5-trading-day horizon"
// Carries no measurable figure that demands a citation on its own. A year-like
// Token attached to a price or percentage ("$2050", "2026%") stays numeric.
// This exemption is deliberately broader than the warn-only audit's horizon
// Pattern: pruning is destructive, so ambiguity favors keeping the claim.
// Both patterns carry /g for replaceAll and must not be reused with .test().
const YEAR_TOKEN_PATTERN = /(?<![$\d.])\b(?:19|20)\d{2}\b(?!\s*%|\.\d)/gu;
const HORIZON_TOKEN_PATTERN = /(?<![$])\b\d+\s*(?:-| )?(?:trading|calendar)?\s*-?\s*days?\b/giu;

function isBlockingNumericOrTechnical(text: string): boolean {
  if (isTechnicalClaim(text)) {
    return true;
  }
  const stripped = text.replaceAll(YEAR_TOKEN_PATTERN, " ").replaceAll(HORIZON_TOKEN_PATTERN, " ");
  return isNumericClaim(stripped);
}

function isBlockingViolation(text: string, sourceIds: readonly string[]): boolean {
  return (
    hasNoSupportingSource(sourceIds) &&
    !isHistoricalForecastOutcome(text) &&
    isBlockingNumericOrTechnical(text)
  );
}

interface Partition<T> {
  readonly kept: readonly T[];
  readonly pruned: readonly ReportIntegrityPrunedItem[];
}

// Pruned locations use pre-prune indices (matching the warn-only audit's
// Location space); posture advisories below index the pruned report.
function partitionItems<T>(
  section: string,
  items: readonly T[],
  textOf: (item: T) => string,
  sourceIdsOf: (item: T) => readonly string[],
): Partition<T> {
  const kept: T[] = [];
  const pruned: ReportIntegrityPrunedItem[] = [];
  items.forEach((item, index) => {
    if (isBlockingViolation(textOf(item), sourceIdsOf(item))) {
      pruned.push({
        location: `${section}[${String(index)}]`,
        text: textOf(item),
        sourceIds: sourceIdsOf(item),
      });
    } else {
      kept.push(item);
    }
  });
  return { kept, pruned };
}

function partitionFindings(
  section: string,
  findings: readonly KeyFinding[],
): Partition<KeyFinding> {
  return partitionItems(
    section,
    findings,
    (finding) => finding.text,
    (finding) => finding.sourceIds,
  );
}

function partitionScenarios(scenarios: readonly Scenario[]): Partition<Scenario> {
  return partitionItems(
    "scenarios",
    scenarios,
    // A scenario's name can carry the numeric or technical claim ("20%
    // Downside") while the description stays qualitative, so both fields feed
    // The blocking check.
    (scenario) => `${scenario.name}: ${scenario.description}`,
    (scenario) => scenario.sourceIds,
  );
}

function partitionPredictions(predictions: readonly Prediction[]): Partition<Prediction> {
  return partitionItems(
    "predictions",
    predictions,
    (prediction) => prediction.claim,
    (prediction) => prediction.sourceIds,
  );
}

function summaryAdvisories(summary: string): readonly ReportIntegrityAdvisory[] {
  return summary
    .split(/(?<=[.!?])\s+/u)
    .map((sentence, index) => ({ sentence: sentence.trim(), index }))
    .filter(
      ({ sentence }) =>
        sentence !== "" &&
        isBlockingNumericOrTechnical(sentence) &&
        !isHistoricalForecastOutcome(sentence),
    )
    .map(({ index }) => ({
      code: "uncited-numeric-summary-sentence" as const,
      location: `summary[${String(index)}]`,
    }));
}

function postureAdvisories(report: ResearchReport): readonly ReportIntegrityAdvisory[] {
  const claims = [
    ...report.keyFindings.map((finding, index) => ({
      location: `keyFindings[${String(index)}]`,
      text: finding.text,
      sourceIds: finding.sourceIds,
    })),
    ...report.bullCase.map((finding, index) => ({
      location: `bullCase[${String(index)}]`,
      text: finding.text,
      sourceIds: finding.sourceIds,
    })),
    ...report.bearCase.map((finding, index) => ({
      location: `bearCase[${String(index)}]`,
      text: finding.text,
      sourceIds: finding.sourceIds,
    })),
    ...report.risks.map((finding, index) => ({
      location: `risks[${String(index)}]`,
      text: finding.text,
      sourceIds: finding.sourceIds,
    })),
    ...report.catalysts.map((finding, index) => ({
      location: `catalysts[${String(index)}]`,
      text: finding.text,
      sourceIds: finding.sourceIds,
    })),
    ...report.scenarios.map((scenario, index) => ({
      location: `scenarios[${String(index)}]`,
      text: scenario.description,
      sourceIds: scenario.sourceIds,
    })),
  ];
  return claims
    .filter(
      (claim) =>
        shouldCarryPostureLabel(claim.text, claim.sourceIds) && !hasPostureLabel(claim.text),
    )
    .map((claim) => ({
      code: "weak-evidence-posture-missing" as const,
      location: claim.location,
    }));
}

const QUALITY_RANK: Readonly<Record<ReportIntegrity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function worseQuality(
  a: EvidenceQuality | ReportIntegrity,
  b: EvidenceQuality | ReportIntegrity,
): ReportIntegrity {
  return QUALITY_RANK[a] <= QUALITY_RANK[b] ? a : b;
}

// Sections a report cannot analytically stand without. bullCase, bearCase,
// Catalysts, and predictions may be legitimately empty (e.g. market overviews
// Without catalysts, prediction shortfalls), so they never force `low`.
const REQUIRED_SECTIONS = ["keyFindings", "risks", "scenarios"] as const;

export function auditReportIntegrity(report: ResearchReport): ReportIntegrityAuditResult {
  const keyFindings = partitionFindings("keyFindings", report.keyFindings);
  const bullCase = partitionFindings("bullCase", report.bullCase);
  const bearCase = partitionFindings("bearCase", report.bearCase);
  const risks = partitionFindings("risks", report.risks);
  const catalysts = partitionFindings("catalysts", report.catalysts);
  const scenarios = partitionScenarios(report.scenarios);
  const predictions = partitionPredictions(report.predictions);

  const pruned = [
    ...keyFindings.pruned,
    ...bullCase.pruned,
    ...bearCase.pruned,
    ...risks.pruned,
    ...catalysts.pruned,
    ...scenarios.pruned,
    ...predictions.pruned,
  ];

  const sectionState: Readonly<
    Record<(typeof REQUIRED_SECTIONS)[number], { before: number; after: number }>
  > = {
    keyFindings: { before: report.keyFindings.length, after: keyFindings.kept.length },
    risks: { before: report.risks.length, after: risks.kept.length },
    scenarios: { before: report.scenarios.length, after: scenarios.kept.length },
  };
  // Low measures pruning damage only: a required section that was already
  // Empty before the audit is a synthesis shortfall, not an integrity
  // Violation (the same report grades high when nothing is pruned), so it
  // Must not drag an unrelated pruning down to low.
  const emptiedRequiredSection = REQUIRED_SECTIONS.some(
    (section) => sectionState[section].before > 0 && sectionState[section].after === 0,
  );
  let reportIntegrity: ReportIntegrity = "medium";
  if (pruned.length === 0) {
    reportIntegrity = "high";
  } else if (emptiedRequiredSection) {
    reportIntegrity = "low";
  }
  const researchQuality = worseQuality(researchReportEvidenceQuality(report), reportIntegrity);

  const prunedReport: ResearchReport = {
    ...report,
    keyFindings: keyFindings.kept,
    bullCase: bullCase.kept,
    bearCase: bearCase.kept,
    risks: risks.kept,
    catalysts: catalysts.kept,
    scenarios: scenarios.kept,
    predictions: predictions.kept,
    reportIntegrity,
    researchQuality,
  };
  const advisories = [...summaryAdvisories(report.summary), ...postureAdvisories(prunedReport)];

  return {
    report: prunedReport,
    reportIntegrity,
    researchQuality,
    prunedItemCount: pruned.length,
    advisoryWarningCount: advisories.length,
    pruned,
    advisories,
  };
}
