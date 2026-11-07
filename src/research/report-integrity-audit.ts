import { type EvidenceQuality, type EvidenceQualityAssessment } from "../domain/evidence";
import { type Prediction } from "../domain/prediction";
import {
  researchReportEvidenceQuality,
  type KeyFinding,
  type ReportIntegrityAdvisoryCode,
  type ReportIntegrity,
  type ResearchReport,
  type Scenario,
  type WebFigureFailure,
} from "../domain/report";
import { deriveResearchQualityDriver } from "./quality-driver";
import { isRecord } from "../guards";
import {
  readFigureQuotes,
  unverifiedWebFigure,
  webFigureGapText,
  type WebSourceTexts,
} from "./web-figure-verification";
import {
  hasAttachedFinancialUnit,
  hasNoSupportingSource,
  hasPostureLabel,
  isHistoricalForecastOutcome,
  isNumericClaim,
  isTechnicalClaim,
  isUncitedPeerMedianClaim,
  type PeerMedianLabels,
  shouldCarryPostureLabel,
} from "./post-synthesis-audit";

// ADR 0004: prune unsupported numeric/technical and uncited peer-median claims and grade; posture labels stay advisory.
// ADR 0006: also prune claims whose web-sourced figures fail quote verification.

interface ReportIntegrityPrunedItem {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly webFigure?: WebFigureFailure;
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

function isBlockingNumericOrTechnical(text: string, runCurrencies: readonly string[]): boolean {
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
  return isNumericClaim(stripped, runCurrencies);
}

function isBlockingViolation(
  text: string,
  sourceIds: readonly string[],
  runCurrencies: readonly string[],
): boolean {
  return (
    hasNoSupportingSource(sourceIds) &&
    !isHistoricalForecastOutcome(text) &&
    isBlockingNumericOrTechnical(text, runCurrencies)
  );
}

interface Partition<T> {
  readonly kept: readonly T[];
  readonly pruned: readonly ReportIntegrityPrunedItem[];
}

// Pruned locations use pre-prune indices (matching the warn-only audit's
// Location space); posture advisories below index the pruned report.
function partitionItems<T extends { readonly sourceIds: readonly string[] }>(
  section: string,
  items: readonly T[],
  textOf: (item: T) => string,
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
  webTexts?: WebSourceTexts,
): Partition<T> {
  const kept: T[] = [];
  const pruned: ReportIntegrityPrunedItem[] = [];
  items.forEach((item, index) => {
    const text = textOf(item);
    const { sourceIds } = item;
    const location = `${section}[${String(index)}]`;
    if (
      isBlockingViolation(text, sourceIds, runCurrencies) ||
      isUncitedPeerMedianClaim(text, sourceIds, usablePeerSourceIds, peerMedianLabels)
    ) {
      pruned.push({ location, text, sourceIds });
      return;
    }
    const webFigure =
      webTexts === undefined ? undefined : unverifiedWebFigure({ ...item, text }, webTexts);
    if (webFigure === undefined) {
      kept.push(item);
    } else {
      pruned.push({ location, text, sourceIds, webFigure });
    }
  });
  return { kept, pruned };
}

function partitionFindings(
  section: string,
  findings: readonly KeyFinding[],
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
  webTexts: WebSourceTexts | undefined,
): Partition<KeyFinding> {
  return partitionItems(
    section,
    findings,
    (finding) => finding.text,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
    webTexts,
  );
}

function partitionScenarios(
  scenarios: readonly Scenario[],
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
  webTexts: WebSourceTexts | undefined,
): Partition<Scenario> {
  return partitionItems(
    "scenarios",
    scenarios,
    // A scenario's name can carry the numeric or technical claim ("20%
    // Downside") while the description stays qualitative, so both fields feed
    // The blocking check.
    (scenario) => `${scenario.name}: ${scenario.description}`,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
    webTexts,
  );
}

function partitionPredictions(
  predictions: readonly Prediction[],
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
): Partition<Prediction> {
  return partitionItems(
    "predictions",
    predictions,
    (prediction) => prediction.claim,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
  );
}

const EARNINGS_SETUP_BULLET_KEYS = [
  "expectationBar",
  "qualityLandmines",
  "guidanceCredibility",
] as const;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function extraRowWebFigure(
  row: unknown,
  webTexts: WebSourceTexts,
):
  | {
      readonly text: string;
      readonly sourceIds: readonly string[];
      readonly webFigure?: WebFigureFailure;
    }
  | undefined {
  if (!isRecord(row) || typeof row.text !== "string") {
    return undefined;
  }
  const sourceIds = stringArray(row.sourceIds);
  const figureQuotes = readFigureQuotes(row.figureQuotes);
  const webFigure = unverifiedWebFigure(
    { text: row.text, sourceIds, ...(figureQuotes === undefined ? {} : { figureQuotes }) },
    webTexts,
  );
  return { text: row.text, sourceIds, ...(webFigure === undefined ? {} : { webFigure }) };
}

// Model-authored Earnings Setup bullets drop whole; a Business Framework section keeps its code-owned fields.
function partitionExtras(
  extras: ResearchReport["extras"],
  webTexts: WebSourceTexts | undefined,
): {
  readonly extras: ResearchReport["extras"];
  readonly pruned: readonly ReportIntegrityPrunedItem[];
} {
  if (extras === undefined || webTexts === undefined) {
    return { extras, pruned: [] };
  }
  const pruned: ReportIntegrityPrunedItem[] = [];
  const failed = (location: string, row: unknown): boolean => {
    const checked = extraRowWebFigure(row, webTexts);
    if (checked?.webFigure === undefined) {
      return false;
    }
    pruned.push({ location, ...checked });
    return true;
  };
  const setup = extras.earningsSetup;
  const earningsSetup = isRecord(setup)
    ? Object.fromEntries(
        Object.entries(setup).map(([key, value]) =>
          (EARNINGS_SETUP_BULLET_KEYS as readonly string[]).includes(key) && Array.isArray(value)
            ? [
                key,
                value.filter(
                  (bullet, index) =>
                    !failed(`extras.earningsSetup.${key}[${String(index)}]`, bullet),
                ),
              ]
            : [key, value],
        ),
      )
    : setup;
  const framework = extras.businessFramework;
  const businessFramework =
    isRecord(framework) && Array.isArray(framework.sections)
      ? {
          ...framework,
          sections: framework.sections.map((section: unknown, index) =>
            isRecord(section) &&
            failed(`extras.businessFramework.sections[${String(index)}]`, section)
              ? Object.fromEntries(
                  Object.entries(section).filter(
                    ([key]) => key !== "text" && key !== "figureQuotes",
                  ),
                )
              : section,
          ),
        }
      : framework;
  if (pruned.length === 0) {
    return { extras, pruned };
  }
  return {
    extras: {
      ...extras,
      ...(earningsSetup === undefined ? {} : { earningsSetup }),
      ...(businessFramework === undefined ? {} : { businessFramework }),
    },
    pruned,
  };
}

const SUMMARY_FALLBACK =
  "Summary withheld: every summary sentence carried an uncited numeric, technical, or peer-median claim. See the cited sections of this report.";

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
export function summarySentenceTexts(summary: string): readonly string[] {
  return splitSummarySentences(summary).map(({ text }) => text.trim());
}

function splitSummarySentences(summary: string): readonly SummaryPiece[] {
  const pieces: SummaryPiece[] = [];
  let start = 0;
  for (const match of summary.matchAll(/\s+/gu)) {
    const [separator] = match;
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

// Drops blocked sentences, keeping the surviving text's original separators.
export function pruneSentences(
  text: string,
  isBlocked: (sentence: string) => boolean,
): { readonly kept: string; readonly pruned: readonly { index: number; text: string }[] } {
  const pieces = splitSummarySentences(text);
  const blocking = pieces.map(({ text: piece }) => piece.trim() !== "" && isBlocked(piece.trim()));
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
  const pruned: { index: number; text: string }[] = [];
  let kept = "";
  let separator = "";
  pieces.forEach((piece, index) => {
    if (blocking[index] === true) {
      pruned.push({ index, text: piece.text.trim() });
      if (lineBreakCount(piece.separator) > lineBreakCount(separator)) {
        ({ separator } = piece);
      }
    } else {
      kept += `${kept === "" ? "" : separator}${piece.text}`;
      ({ separator } = piece);
    }
  });
  return { kept: pruned.length === 0 ? text : kept.trim(), pruned };
}

function partitionSummary(
  summary: string,
  usablePeerSourceIds: ReadonlySet<string> | undefined,
  peerMedianLabels: PeerMedianLabels | undefined,
  runCurrencies: readonly string[],
): {
  readonly summary: string;
  readonly pruned: readonly ReportIntegrityPrunedItem[];
} {
  const { kept, pruned } = pruneSentences(
    summary,
    (sentence) =>
      isBlockingViolation(sentence, [], runCurrencies) ||
      isUncitedPeerMedianClaim(sentence, [], usablePeerSourceIds, peerMedianLabels),
  );
  if (pruned.length === 0) {
    return { summary, pruned: [] };
  }
  return {
    summary: kept === "" ? SUMMARY_FALLBACK : kept,
    pruned: pruned.map(({ index, text }) => ({
      location: `summary[${String(index)}]`,
      text,
      sourceIds: [],
    })),
  };
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
  usablePeerSourceIds?: ReadonlySet<string>,
  peerMedianLabels?: PeerMedianLabels,
  webTexts?: WebSourceTexts,
  runCurrencies: readonly string[] = [],
): ReportIntegrityAuditResult {
  const findings = (section: string, items: readonly KeyFinding[]) =>
    partitionFindings(
      section,
      items,
      usablePeerSourceIds,
      peerMedianLabels,
      runCurrencies,
      webTexts,
    );
  const keyFindings = findings("keyFindings", report.keyFindings);
  const bullCase = findings("bullCase", report.bullCase);
  const bearCase = findings("bearCase", report.bearCase);
  const risks = findings("risks", report.risks);
  const catalysts = findings("catalysts", report.catalysts);
  const scenarios = partitionScenarios(
    report.scenarios,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
    webTexts,
  );
  const predictions = partitionPredictions(
    report.predictions,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
  );
  const extras = partitionExtras(report.extras, webTexts);
  const summary = partitionSummary(
    report.summary,
    usablePeerSourceIds,
    peerMedianLabels,
    runCurrencies,
  );

  const pruned = [
    ...summary.pruned,
    ...keyFindings.pruned,
    ...bullCase.pruned,
    ...bearCase.pruned,
    ...risks.pruned,
    ...catalysts.pruned,
    ...scenarios.pruned,
    ...predictions.pruned,
    ...extras.pruned,
  ];
  const webFigureGaps = pruned.flatMap((item) =>
    item.webFigure === undefined ? [] : [webFigureGapText(item.location, item.webFigure)],
  );

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
    ...(extras.extras === undefined ? {} : { extras: extras.extras }),
    ...(webFigureGaps.length === 0 ? {} : { dataGaps: [...report.dataGaps, ...webFigureGaps] }),
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
