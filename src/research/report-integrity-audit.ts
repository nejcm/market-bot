import {
  researchReportEvidenceQuality,
  type EvidenceQuality,
  type EvidenceQualityAssessment,
  type KeyFinding,
  type Prediction,
  type ReportIntegrityAdvisoryCode,
  type ReportIntegrity,
  type ResearchReport,
  type Scenario,
} from "../domain/types";
import { deriveResearchQualityDriver } from "./quality-driver";
import {
  hasAttachedFinancialUnit,
  hasNoSupportingSource,
  hasPostureLabel,
  isHistoricalForecastOutcome,
  isNumericClaim,
  isTechnicalClaim,
  shouldCarryPostureLabel,
} from "./post-synthesis-audit";

// Report Integrity Audit (ADR 0005): prunes uncited numeric/technical findings, scenarios,
// Predictions, and summary sentences, then grades; posture labels stay advisory.

interface ReportIntegrityPrunedItem {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface ReportIntegrityAdvisory {
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

// Bare calendar/fiscal years and forecast-horizon phrasing are not numeric claims for
// Pruning purposes: "revenue guidance for 2026" or "a 5-trading-day horizon"
// Carries no measurable figure that demands a citation on its own. A year-like
// Token attached to a price or percentage ("$2050", "2026%") stays numeric.
// This exemption is deliberately broader than the warn-only audit's horizon
// Pattern: pruning is destructive, so ambiguity favors keeping the claim.
// YEAR, month-day, horizon, and ISO-date matchers carry /g for replaceAll, not .test();
// The unit patterns omit /g because they are .test()ed.
const YEAR_TOKEN_PATTERN =
  /(?<![$\d.])\b(?:FY(?:\d{2}|(?:19|20)\d{2})|(?:19|20)\d{2})\b(?!\s*%|\.\d)/giu;
const MONTH_DAY_PATTERN =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([1-9]|[12]\d|3[01])(?:,\s*((?:19|20)\d{2}))?\b/gu;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const HORIZON_TOKEN_PATTERN = /(?<![$])\b\d+\s*(?:-| )?(?:trading|calendar)?\s*-?\s*days?\b/giu;
// Strip ISO dates before years; captures would displace replaceAll's offset for unit checks.
const ISO_CALENDAR_DATE_PATTERN = /(?<![\d.])\b\d{4}-\d{2}-\d{2}\b/gu;

function isUtcRoundTripIsoDate(isoDate: string): boolean {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === isoDate;
}

function isBlockingNumericOrTechnical(text: string): boolean {
  if (isTechnicalClaim(text)) {
    return true;
  }
  const stripped = text
    .replaceAll(ISO_CALENDAR_DATE_PATTERN, (span, offset: number) =>
      isUtcRoundTripIsoDate(span) && !hasAttachedFinancialUnit(text, offset, offset + span.length)
        ? " "
        : span,
    )
    .replaceAll(
      MONTH_DAY_PATTERN,
      (
        span,
        month: string,
        day: string,
        year: string | undefined,
        offset: number,
        input: string,
      ) => {
        const monthIndex = MONTHS.indexOf(month.toLowerCase());
        const date = new Date(Date.UTC(Number(year ?? "2000"), monthIndex, Number(day)));
        return date.getUTCMonth() === monthIndex &&
          date.getUTCDate() === Number(day) &&
          !hasAttachedFinancialUnit(input, offset, offset + span.length)
          ? " "
          : span;
      },
    )
    .replaceAll(YEAR_TOKEN_PATTERN, " ")
    .replaceAll(HORIZON_TOKEN_PATTERN, " ");
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

const SUMMARY_FALLBACK =
  "Summary withheld: every summary sentence carried an uncited numeric or technical claim. See the cited sections of this report.";

const NON_FINAL_ABBREVIATION = /^(?:e\.g|i\.e|vs|cf|Mr|Mrs|Ms|Dr|No|St)\.$/iu;
const FINAL_CAPABLE_ABBREVIATION = /^(?:(?:[A-Za-z]\.)+|Inc\.|Corp\.|Co\.|Ltd\.|Jr\.|Sr\.)$/u;

interface SummaryPiece {
  readonly text: string;
  readonly separator: string;
  readonly ambiguousEnd: boolean;
}

function trailingToken(text: string): string {
  return (/\S+$/u.exec(text)?.[0] ?? "").replace(/^[("'[]+/u, "");
}

// "U.S." or "Inc." ends a sentence only before a capitalized or camel-case word; "e.g." never does.
function sentenceEnd(text: string, rest: string): "hard" | "ambiguous" | undefined {
  if (!/[.!?]["'”’)\]]*$/u.test(text)) {
    return undefined;
  }
  const token = trailingToken(text).replace(/["'”’)\]]+$/u, "");
  if (NON_FINAL_ABBREVIATION.test(token)) {
    return undefined;
  }
  if (!FINAL_CAPABLE_ABBREVIATION.test(token)) {
    return "hard";
  }
  return /^(?:[A-Z\d"'(“‘]|[a-z]+[A-Z])/u.test(rest) ? "ambiguous" : undefined;
}

// Blank lines always separate.
function splitSummarySentences(summary: string): readonly SummaryPiece[] {
  const pieces: SummaryPiece[] = [];
  let start = 0;
  for (const match of summary.matchAll(/\s+/gu)) {
    const separator = match[0];
    const end = match.index + separator.length;
    const text = summary.slice(start, match.index);
    const kind = /\n\s*\n/u.test(separator) ? "hard" : sentenceEnd(text, summary.slice(end));
    if (kind !== undefined) {
      pieces.push({ text, separator, ambiguousEnd: kind === "ambiguous" });
      start = end;
    }
  }
  pieces.push({ text: summary.slice(start), separator: "", ambiguousEnd: false });
  return pieces;
}

// At least three words besides the trailing abbreviation run, so "Analyst J." is not one.
function readsAsSentence(text: string): boolean {
  const words = text.trim().split(/\s+/u);
  while (words.length > 0 && FINAL_CAPABLE_ABBREVIATION.test(trailingToken(words.at(-1) ?? ""))) {
    words.pop();
  }
  return words.filter((word) => /\p{L}/u.test(word)).length >= 3;
}

function lineBreakCount(separator: string): number {
  return separator.split("\n").length;
}

function partitionSummary(summary: string): {
  readonly summary: string;
  readonly pruned: readonly ReportIntegrityPrunedItem[];
} {
  const pieces = splitSummarySentences(summary);
  const blocking = pieces.map(
    ({ text }) => text.trim() !== "" && isBlockingViolation(text.trim(), []),
  );
  // Right to left so a chain of initials ("J. R. Smith ...") follows its pruned continuation.
  for (let index = pieces.length - 2; index >= 0; index -= 1) {
    const piece = pieces[index];
    if (
      piece?.ambiguousEnd === true &&
      blocking[index + 1] === true &&
      !readsAsSentence(piece.text)
    ) {
      blocking[index] = true;
    }
  }
  const pruned: ReportIntegrityPrunedItem[] = [];
  let kept = "";
  let separator = "";
  pieces.forEach((piece, index) => {
    if (blocking[index] === true) {
      pruned.push({
        location: `summary[${String(index)}]`,
        text: piece.text.trim(),
        sourceIds: [],
      });
      if (lineBreakCount(piece.separator) > lineBreakCount(separator)) {
        ({ separator } = piece);
      }
    } else {
      kept += `${kept === "" ? "" : separator}${piece.text}`;
      ({ separator } = piece);
    }
  });
  if (pruned.length === 0) {
    return { summary, pruned };
  }
  const trimmed = kept.trim();
  return { summary: trimmed === "" ? SUMMARY_FALLBACK : trimmed, pruned };
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
        shouldCarryPostureLabel(claim.text, claim.sourceIds) &&
        !hasPostureLabel(claim.text, claim.sourceIds),
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

export function auditReportIntegrity(
  report: ResearchReport,
  evidenceQualityAssessment?: EvidenceQualityAssessment,
): ReportIntegrityAuditResult {
  const keyFindings = partitionFindings("keyFindings", report.keyFindings);
  const bullCase = partitionFindings("bullCase", report.bullCase);
  const bearCase = partitionFindings("bearCase", report.bearCase);
  const risks = partitionFindings("risks", report.risks);
  const catalysts = partitionFindings("catalysts", report.catalysts);
  const scenarios = partitionScenarios(report.scenarios);
  const predictions = partitionPredictions(report.predictions);
  const summary = partitionSummary(report.summary);

  const pruned = [
    ...summary.pruned,
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

  const researchQualityDriver = deriveResearchQualityDriver(evidenceQualityAssessment, {
    reportIntegrity,
    researchQuality,
    pruned,
  });
  const prunedReport: ResearchReport = {
    ...report,
    summary: summary.summary,
    keyFindings: keyFindings.kept,
    bullCase: bullCase.kept,
    bearCase: bearCase.kept,
    risks: risks.kept,
    catalysts: catalysts.kept,
    scenarios: scenarios.kept,
    predictions: predictions.kept,
    reportIntegrity,
    researchQuality,
    ...(researchQualityDriver !== undefined ? { researchQualityDriver } : {}),
  };
  const advisories = postureAdvisories(prunedReport);

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
