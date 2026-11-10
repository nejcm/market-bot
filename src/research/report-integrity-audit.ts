import { type EvidenceQuality, type EvidenceQualityAssessment } from "../domain/evidence";
import type { PostSynthesisAuditWarning } from "../domain/run-trace";
import {
  researchReportEvidenceQuality,
  type DroppedFigureQuote,
  type FigureQuote,
  type RenderedMetric,
  type ReportIntegrity,
  type ResearchReport,
  type WebFigureFailure,
} from "../domain/report";
import { deriveResearchQualityDriver } from "./quality-driver";
import { isRecord } from "../guards";
import { readFigureQuotes } from "../report/figure-quotes";
import {
  failedFigureQuotes,
  readClaimProvenance,
  typedReading,
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
import { isGapShapedClaimForAuditWarning } from "./gap-shaped-claims";

// ADR 0004: one claim walk; prune-severity rules drop and grade, warn-severity rules only reach the trace.
// ADR 0006: also prune claims whose web-sourced figures fail quote verification, and drop failing quotes.

interface ReportIntegrityPrunedItem {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly webFigure?: WebFigureFailure;
}

interface ReportIntegrityDroppedQuote extends DroppedFigureQuote {
  readonly location: string;
}

export interface ReportIntegrityAuditResult {
  readonly report: ResearchReport;
  readonly reportIntegrity: ReportIntegrity;
  readonly researchQuality: ReportIntegrity;
  readonly prunedItemCount: number;
  readonly pruned: readonly ReportIntegrityPrunedItem[];
  readonly droppedFigureQuotes: readonly ReportIntegrityDroppedQuote[];
}

// Bare calendar/fiscal years and forecast-horizon phrasing are not numeric claims for
// Pruning purposes: "revenue guidance for 2026" or "a 5-trading-day horizon"
// Carries no measurable figure that demands a citation on its own. A year-like
// Token attached to a price or percentage ("$2050", "2026%") stays numeric.
// This exemption is deliberately broader than the warn rule's horizon
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

interface ClaimContext {
  readonly usablePeerSourceIds: ReadonlySet<string> | undefined;
  readonly peerMedianLabels: PeerMedianLabels | undefined;
  readonly runCurrencies: readonly string[];
}

interface Claim {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

type ClaimRule =
  | {
      readonly severity: "prune";
      readonly matches: (claim: Claim, context: ClaimContext) => boolean;
    }
  | {
      readonly severity: "warn";
      readonly code: PostSynthesisAuditWarning["code"];
      readonly message: string;
      readonly matches: (claim: Claim, context: ClaimContext) => boolean;
    };

const CLAIM_RULES: readonly ClaimRule[] = [
  {
    severity: "prune",
    matches: ({ text, sourceIds }, { runCurrencies }) =>
      hasNoSupportingSource(sourceIds) &&
      !isHistoricalForecastOutcome(text) &&
      isBlockingNumericOrTechnical(text, runCurrencies),
  },
  {
    severity: "prune",
    matches: ({ text, sourceIds }, context) =>
      isUncitedPeerMedianClaim(
        text,
        sourceIds,
        context.usablePeerSourceIds,
        context.peerMedianLabels,
      ),
  },
  {
    severity: "warn",
    code: "peer-median-uncited",
    message: "peer-median claim cites no usable peer source",
    matches: ({ text, sourceIds }, context) =>
      isUncitedPeerMedianClaim(
        text,
        sourceIds,
        context.usablePeerSourceIds,
        context.peerMedianLabels,
      ),
  },
  {
    severity: "warn",
    code: "gap-shaped-claim-cited",
    message: "gap-shaped claim carries source citations; review citation grounding",
    matches: ({ text, sourceIds }) => isGapShapedClaimForAuditWarning(text) && sourceIds.length > 0,
  },
  {
    severity: "warn",
    code: "unsupported-numeric-claim",
    message: "numeric or technical claim has no non-history supporting source citation",
    matches: ({ text, sourceIds }, { runCurrencies }) =>
      (isNumericClaim(text, runCurrencies) || isTechnicalClaim(text)) &&
      !isHistoricalForecastOutcome(text) &&
      hasNoSupportingSource(sourceIds),
  },
  {
    severity: "warn",
    code: "weak-evidence-posture-missing",
    message: "weak or unsupported claim is missing an evidence posture label",
    matches: ({ text, sourceIds }) =>
      shouldCarryPostureLabel(text, sourceIds) && !hasPostureLabel(text, sourceIds),
  },
];

function isPruned(claim: Claim, context: ClaimContext): boolean {
  return CLAIM_RULES.some((rule) => rule.severity === "prune" && rule.matches(claim, context));
}

function claimWarnings(claim: Claim, context: ClaimContext): readonly PostSynthesisAuditWarning[] {
  return CLAIM_RULES.flatMap((rule) =>
    rule.severity === "warn" && rule.matches(claim, context)
      ? [
          {
            code: rule.code,
            location: claim.location,
            message: rule.message,
            sourceIds: claim.sourceIds,
          },
        ]
      : [],
  );
}

interface Partition<T> {
  readonly kept: readonly T[];
  readonly pruned: readonly ReportIntegrityPrunedItem[];
  readonly dropped: readonly ReportIntegrityDroppedQuote[];
  readonly warnings: readonly PostSynthesisAuditWarning[];
}

function withoutQuotes<T extends { readonly figureQuotes?: readonly FigureQuote[] }>(
  item: T,
  dropped: readonly DroppedFigureQuote[],
): T {
  return item.figureQuotes === undefined || dropped.length === 0
    ? item
    : {
        ...item,
        figureQuotes: item.figureQuotes.filter(
          (quote) =>
            !dropped.some(
              (row) =>
                row.sourceId === quote.sourceId &&
                row.quote === quote.quote &&
                row.unitQuote === quote.unitQuote,
            ),
        ),
      };
}

function typedClaim<
  T extends {
    readonly sourceIds: readonly string[];
    readonly renderedMetrics?: readonly RenderedMetric[];
  },
>(item: T, fields: readonly (keyof T & string)[]) {
  const readings = fields.map((key) => typedReading(item, key));
  return {
    ...item,
    text: readings.map(({ text }) => text).join(": "),
    ambiguousSpans: readings.flatMap(({ ambiguousSpans }) => ambiguousSpans),
  };
}

interface ClaimItem {
  readonly sourceIds: readonly string[];
  readonly figureQuotes?: readonly FigureQuote[];
  readonly metricSourceIds?: readonly string[];
  readonly renderedMetrics?: readonly RenderedMetric[];
}

interface ClaimSection<T extends ClaimItem> {
  readonly claims: readonly (Claim & { readonly item: T })[];
  readonly fields: readonly (keyof T & string)[];
}

function claimSection<T extends ClaimItem>(
  section: string,
  items: readonly T[],
  // Joined with ": " into the claim text every rule reads.
  fields: readonly [keyof T & string, ...(keyof T & string)[]],
): ClaimSection<T> {
  return {
    fields,
    claims: items.map((item, index) => ({
      item,
      location: `${section}[${String(index)}]`,
      text: fields.map((key) => String(item[key])).join(": "),
      sourceIds: item.sourceIds,
    })),
  };
}

function reportSections(report: ResearchReport) {
  return {
    keyFindings: claimSection("keyFindings", report.keyFindings, ["text"]),
    bullCase: claimSection("bullCase", report.bullCase, ["text"]),
    bearCase: claimSection("bearCase", report.bearCase, ["text"]),
    risks: claimSection("risks", report.risks, ["text"]),
    catalysts: claimSection("catalysts", report.catalysts, ["text"]),
    // A scenario's name can carry the numeric claim ("20% Downside") while the description stays qualitative.
    scenarios: claimSection("scenarios", report.scenarios, ["name", "description"]),
    predictions: claimSection("predictions", report.predictions, ["claim"]),
  };
}

export function claimsForReport(report: ResearchReport): readonly {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}[] {
  return Object.values(reportSections(report)).flatMap(({ claims }) =>
    claims.map(({ location, text, sourceIds }) => ({ location, text, sourceIds })),
  );
}

function walkSection<T extends ClaimItem>(
  { claims, fields }: ClaimSection<T>,
  context: ClaimContext,
  webTexts: WebSourceTexts | undefined,
): Partition<T> {
  const kept: T[] = [];
  const pruned: ReportIntegrityPrunedItem[] = [];
  const dropped: ReportIntegrityDroppedQuote[] = [];
  const warnings: PostSynthesisAuditWarning[] = [];
  for (const claim of claims) {
    const { item, location, text, sourceIds } = claim;
    warnings.push(...claimWarnings(claim, context));
    if (isPruned(claim, context)) {
      pruned.push({ location, text, sourceIds });
      continue;
    }
    const webFigure =
      webTexts === undefined ? undefined : unverifiedWebFigure(typedClaim(item, fields), webTexts);
    if (webFigure !== undefined) {
      pruned.push({ location, text, sourceIds, webFigure });
      continue;
    }
    const failedQuotes = webTexts === undefined ? [] : failedFigureQuotes(item, webTexts);
    dropped.push(...failedQuotes.map((quote) => ({ location, ...quote })));
    kept.push(withoutQuotes(item, failedQuotes));
  }
  return { kept, pruned, dropped, warnings };
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
      readonly failedQuotes: readonly DroppedFigureQuote[];
    }
  | undefined {
  if (!isRecord(row) || typeof row.text !== "string") {
    return undefined;
  }
  const sourceIds = stringArray(row.sourceIds);
  const claim = { text: row.text, sourceIds, ...readClaimProvenance(row) };
  const webFigure = unverifiedWebFigure(typedClaim(claim, ["text"]), webTexts);
  return {
    text: row.text,
    sourceIds,
    failedQuotes: failedFigureQuotes(claim, webTexts),
    ...(webFigure === undefined ? {} : { webFigure }),
  };
}

// Model-authored Earnings Setup bullets drop whole; a Business Framework section keeps its code-owned fields.
function partitionExtras(
  extras: ResearchReport["extras"],
  context: ClaimContext,
  webTexts: WebSourceTexts | undefined,
): {
  readonly extras: ResearchReport["extras"];
  readonly pruned: readonly ReportIntegrityPrunedItem[];
  readonly dropped: readonly ReportIntegrityDroppedQuote[];
  readonly warnings: readonly PostSynthesisAuditWarning[];
} {
  if (extras === undefined) {
    return { extras, pruned: [], dropped: [], warnings: [] };
  }
  const pruned: ReportIntegrityPrunedItem[] = [];
  const dropped: ReportIntegrityDroppedQuote[] = [];
  const warnings: PostSynthesisAuditWarning[] = [];
  // Undefined when the row is pruned; otherwise the row without its failing quotes.
  const screened = (location: string, row: unknown): unknown => {
    if (!isRecord(row) || typeof row.text !== "string") {
      return row;
    }
    warnings.push(
      ...claimWarnings(
        { location, text: row.text, sourceIds: stringArray(row.sourceIds) },
        context,
      ),
    );
    const checked = webTexts === undefined ? undefined : extraRowWebFigure(row, webTexts);
    if (checked === undefined) {
      return row;
    }
    const { failedQuotes, ...item } = checked;
    if (item.webFigure !== undefined) {
      pruned.push({ location, ...item });
      return undefined;
    }
    if (failedQuotes.length === 0) {
      return row;
    }
    dropped.push(...failedQuotes.map((quote) => ({ location, ...quote })));
    return withoutQuotes(
      { ...row, figureQuotes: readFigureQuotes(row.figureQuotes) ?? [] },
      failedQuotes,
    );
  };
  const setup = extras.earningsSetup;
  const earningsSetup = isRecord(setup)
    ? Object.fromEntries(
        Object.entries(setup).map(([key, value]) =>
          (EARNINGS_SETUP_BULLET_KEYS as readonly string[]).includes(key) && Array.isArray(value)
            ? [
                key,
                value.flatMap((bullet, index) => {
                  const kept = screened(`extras.earningsSetup.${key}[${String(index)}]`, bullet);
                  return kept === undefined ? [] : [kept];
                }),
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
          sections: framework.sections.map((section: unknown, index) => {
            const kept = screened(`extras.businessFramework.sections[${String(index)}]`, section);
            return kept === undefined && isRecord(section)
              ? Object.fromEntries(
                  Object.entries(section).filter(
                    ([key]) => !["text", "figureQuotes", "renderedMetrics"].includes(key),
                  ),
                )
              : kept;
          }),
        }
      : framework;
  if (pruned.length === 0 && dropped.length === 0) {
    return { extras, pruned, dropped, warnings };
  }
  return {
    warnings,
    dropped,
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
  context: ClaimContext,
): {
  readonly summary: string;
  readonly pruned: readonly ReportIntegrityPrunedItem[];
  readonly warnings: readonly PostSynthesisAuditWarning[];
} {
  // Summaries carry no citations, so the posture rule would flag every sentence.
  const warnings = summarySentenceTexts(summary)
    .flatMap((text, index) =>
      text === ""
        ? []
        : claimWarnings({ location: `summary[${String(index)}]`, text, sourceIds: [] }, context),
    )
    .filter(({ code }) => code !== "weak-evidence-posture-missing");
  const { kept, pruned } = pruneSentences(summary, (sentence) =>
    isPruned({ location: "summary", text: sentence, sourceIds: [] }, context),
  );
  if (pruned.length === 0) {
    return { summary, pruned: [], warnings };
  }
  return {
    warnings,
    summary: kept === "" ? SUMMARY_FALLBACK : kept,
    pruned: pruned.map(({ index, text }) => ({
      location: `summary[${String(index)}]`,
      text,
      sourceIds: [],
    })),
  };
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
): ReportIntegrityAuditResult & { readonly warnings: readonly PostSynthesisAuditWarning[] } {
  const context: ClaimContext = { usablePeerSourceIds, peerMedianLabels, runCurrencies };
  const sections = reportSections(report);
  const keyFindings = walkSection(sections.keyFindings, context, webTexts);
  const bullCase = walkSection(sections.bullCase, context, webTexts);
  const bearCase = walkSection(sections.bearCase, context, webTexts);
  const risks = walkSection(sections.risks, context, webTexts);
  const catalysts = walkSection(sections.catalysts, context, webTexts);
  const scenarios = walkSection(sections.scenarios, context, webTexts);
  // Predictions carry no Verified Web Figure check.
  const predictions = walkSection(sections.predictions, context, undefined);
  const extras = partitionExtras(report.extras, context, webTexts);
  const summary = partitionSummary(report.summary, context);
  const walked = [keyFindings, bullCase, bearCase, risks, catalysts, scenarios, predictions];

  const pruned = [
    ...summary.pruned,
    ...walked.flatMap((section) => section.pruned),
    ...extras.pruned,
  ];
  const droppedFigureQuotes = [...walked.flatMap((section) => section.dropped), ...extras.dropped];
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

  return {
    report: prunedReport,
    reportIntegrity,
    researchQuality,
    prunedItemCount: pruned.length,
    pruned,
    droppedFigureQuotes,
    warnings: [
      ...summary.warnings,
      ...walked.flatMap((section) => section.warnings),
      ...extras.warnings,
    ],
  };
}
