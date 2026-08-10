import { isInstrumentCommand, type InstrumentCommand } from "../cli/args";
import { DAY_MS } from "../config/shared";
import type {
  EvidenceRequestToolName,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { isRecord, readNumber, stringArrayValue } from "../guards";
import { isUsListing } from "./instrument-capability";
import {
  findSecTicker,
  secRequestInit,
  type SecCompanyFactsResult,
} from "./extended-evidence/sec-edgar";
import { filingBaseUrl, filingDocuments } from "./extended-evidence/sec-archive";
import { encodeQuery, readArray } from "./extended-evidence/utils";
import { SEC_FILING_TEXT_MAX_RESPONSE_BYTES } from "./source-request";
import { tradierRequestInit } from "./tradier";
import {
  aggregateModelInputSanitization,
  droppedModelInputItemEntry,
  sanitizeModelInputField,
  type ModelInputSanitizationAggregate,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";
import {
  isFetchJsonResult,
  isFetchTextResult,
  latestRawSnapshotFetchedAt,
  type CollectContext,
  type FetchJsonResult,
  type FetchTextResult,
  type RawSourceSnapshot,
} from "./types";
import { retainedEvidenceSpanForEarningsDate } from "./extended-evidence/earnings-date-confirmation";

export const EVIDENCE_REQUEST_TOOL_UNITS: Record<EvidenceRequestToolName, number> = {
  sec_latest_filing: 5,
  tradier_iv_term_structure: 5,
};

export interface EvidenceRequestToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
}

interface SecFiling {
  readonly form: "10-K" | "10-Q" | "8-K" | "6-K";
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber: string;
  readonly primaryDocument: string;
  // Current-report item codes (e.g. "2.02"). Absent when the submissions payload omits them,
  // Which is treated as unknown rather than empty.
  readonly items?: readonly string[];
}

interface TradierBucket {
  readonly targetDte: number;
  readonly expiration: string;
  readonly dte: number;
}

interface TradierBucketIv extends TradierBucket {
  readonly medianIv: number;
}

const TRADIER_TARGET_DTES = [7, 30, 60, 90] as const;
const SEC_FILING_SUMMARY_EXCERPT_CHARS = 1200;
const SEC_PACKET_MIN_CHARS = 50;
const SEC_SECTION_MIN_ALPHA_CHARS = 40;
// Floor for accepting an individually SELECTED section (business/risk factors/MD&A/segments/
// Notes), applied in `selectSection`. Deliberately much higher than SEC_SECTION_MIN_ALPHA_CHARS
// (the packet-level floor below): a 40-char floor lets a 63-char table-of-contents line
// ("ITEM 1. BUSINESS ... 5 ITEM 1A ...") pass as if it were the real section body once the
// Response-byte ceiling stops truncating filings before their TOC-vs-body ambiguity matters
// (see A2.5 in the run-quality remediation plan). This is not a content-quality check — it's a
// Proxy for "distance to the next ITEM header" (see boundedSection), which is short for a TOC
// Line only because TOC lines are dense with ITEM headers. It can still admit a slice that
// Bled forward into an unrelated section; that's a known limitation, not a guarantee.
const SEC_SECTION_MIN_SELECTED_ALPHA_CHARS = 300;
// An Item 2.02 cover sheet ("the press release is furnished as Exhibit 99.1") clears both
// SEC_PACKET_MIN_CHARS and SEC_SECTION_MIN_ALPHA_CHARS while containing no reported results, so
// Substantive-results detection needs its own floor: a results term plus this many numeric
// Magnitude tokens (a figure carrying a currency, scale, thousands-separator, percent, or
// Parenthesised-negative marker). Named counts like "Exhibit 99.1" or "Item 2.02" carry none.
const SEC_RESULTS_MIN_MAGNITUDE_TOKENS = 4;
const SEC_8K_PACKET_BUDGET = 3000;
const SEC_8K_LOOKBACK_DAYS = 120;
const SEC_8K_LIMIT = 2;
const SEC_6K_LIMIT = 2;

export function availableEvidenceRequestTools(
  ctx: CollectContext,
  identity?: InstrumentIdentity,
): readonly EvidenceRequestToolName[] {
  if (!isInstrumentCommand(ctx.command) || ctx.command.assetClass !== "equity") {
    return [];
  }
  if (!isUsListing(ctx.command.symbol, identity)) {
    return [];
  }
  // SEC latest filing is retrieved deterministically (see runEvidenceRequestLoop);
  // Only optional tools remain at model discretion.
  return ctx.tradierApiToken !== undefined ? ["tradier_iv_term_structure"] : [];
}

export async function executeEvidenceRequestTool(
  tool: EvidenceRequestToolName,
  ctx: CollectContext,
): Promise<EvidenceRequestToolOutput> {
  if (tool === "sec_latest_filing") {
    return collectSecFilingEvidence(ctx);
  }
  return collectTradierIvTermStructure(ctx);
}

function emptyOutput(
  gaps: readonly SourceGap[],
  rawSnapshots: readonly RawSourceSnapshot[] = [],
): EvidenceRequestToolOutput {
  return { rawSnapshots, sources: [], items: [], gaps };
}

function unsupportedInstrumentGap(source: string, provider: string, symbol: string): SourceGap {
  return sourceGap({
    source,
    message: `${provider} does not support ${symbol} (non-US listing)`,
    provider,
    capability: "evidence-request",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secPacketGap(symbol: string, form: SecFiling["form"]): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC ${form} section packet for ${symbol} is malformed or too short to extract`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

// A section the 5-way (or 4-way, for 10-Q) model expected but didn't emit: either the anchor
// Never matched ("absent" — e.g. Business in a 10-Q, which has no Item 1 Business) or it matched
// But the candidate slice fell under SEC_SECTION_MIN_SELECTED_ALPHA_CHARS ("too-short" — content
// Exists but was discarded, distinct from the section not being filed at all).
interface SectionMiss {
  readonly label: string;
  readonly reason: "absent" | "too-short";
  readonly alphaCount?: number;
}

function sectionMissDescription(miss: SectionMiss): string {
  return miss.reason === "absent"
    ? miss.label
    : `${miss.label} (found, ${String(miss.alphaCount)} alpha chars < ${String(SEC_SECTION_MIN_SELECTED_ALPHA_CHARS)})`;
}

// Distinguishes a partial extraction (packet built, some sections missing) from
// `secPacketGap`'s total failure (no sections extracted at all), so report.json:dataGaps can
// Tell the two apart (see A2.3 in the run-quality remediation plan). Cause is
// `provider-data-missing`, not `malformed-response`: an omitted section is usually the filing
// Legitimately not having that content (e.g. Business in a 10-Q), not a malformed document.
function secSectionOmissionGap(
  symbol: string,
  form: SecFiling["form"],
  misses: readonly SectionMiss[],
  extractedCount: number,
  totalCount: number,
  normalizedChars: number,
  responseBytes: number,
): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message:
      `SEC ${form} section packet for ${symbol} omitted ${misses.map((miss) => sectionMissDescription(miss)).join(", ")} ` +
      `(${String(extractedCount)} of ${String(totalCount)} sections extracted from ` +
      `${String(normalizedChars)} normalized chars; ${String(responseBytes)} response bytes)`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secSanitizationGap(symbol: string, droppedItemCount: number): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC filing sanitization dropped ${String(droppedItemCount)} item(s) for ${symbol}`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "validation-failed",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secTextRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined ? undefined : { headers: { "user-agent": userAgent } };
}

const FOREIGN_PRIVATE_ISSUER_FORMS = ["20-F", "40-F", "6-K"] as const;

function detectForeignPrivateIssuerForms(payload: unknown): readonly string[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }
  const forms = stringArrayValue(payload.filings.recent.form);
  return FOREIGN_PRIVATE_ISSUER_FORMS.filter((base) =>
    forms.some((form) => form === base || form.startsWith(`${base}/`)),
  );
}

function recentSecFilingRows(payload: unknown): readonly SecFiling[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }

  const { recent } = payload.filings;
  const { form: forms, filingDate: filingDates, accessionNumber: accessionNumbers } = recent;
  const primaryDocuments = recent.primaryDocument;
  if (
    !Array.isArray(forms) ||
    !Array.isArray(filingDates) ||
    !Array.isArray(accessionNumbers) ||
    !Array.isArray(primaryDocuments) ||
    forms.length !== filingDates.length ||
    forms.length !== accessionNumbers.length ||
    forms.length !== primaryDocuments.length
  ) {
    return [];
  }
  const reportDates =
    Array.isArray(recent.reportDate) && recent.reportDate.length === forms.length
      ? recent.reportDate
      : undefined;
  const itemCodes =
    Array.isArray(recent.items) && recent.items.length === forms.length ? recent.items : undefined;

  return forms.flatMap((f, index): SecFiling[] => {
    if (f !== "10-K" && f !== "10-Q" && f !== "8-K" && f !== "6-K") {
      return [];
    }
    const filingDate = filingDates[index];
    const accessionNumber = accessionNumbers[index];
    const primaryDocument = primaryDocuments[index];
    if (
      typeof filingDate !== "string" ||
      filingDate.trim() === "" ||
      typeof accessionNumber !== "string" ||
      accessionNumber.trim() === "" ||
      typeof primaryDocument !== "string" ||
      primaryDocument.trim() === ""
    ) {
      return [];
    }
    const reportDate = reportDates?.[index];
    const itemCode = itemCodes?.[index];
    const items =
      typeof itemCode === "string" && itemCode.trim() !== ""
        ? itemCode
            .split(",")
            .map((code) => code.trim())
            .filter((code) => code !== "")
        : [];
    return [
      {
        form: f,
        filingDate,
        ...(typeof reportDate === "string" && reportDate.trim() !== "" ? { reportDate } : {}),
        accessionNumber,
        primaryDocument,
        ...(items.length > 0 ? { items } : {}),
      },
    ];
  });
}

function selectLatestFilingByForm(
  payload: unknown,
  form: SecFiling["form"],
): SecFiling | undefined {
  return recentSecFilingRows(payload)
    .filter((filing) => filing.form === form)
    .toSorted((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
}

function filingBasisDate(filing: SecFiling): string {
  return filing.reportDate ?? filing.filingDate;
}

function selectCurrentQuarterlyFiling(payload: unknown, annual?: SecFiling): SecFiling | undefined {
  const latestQuarterly = selectLatestFilingByForm(payload, "10-Q");
  if (latestQuarterly === undefined || annual === undefined) {
    return latestQuarterly;
  }
  return filingBasisDate(latestQuarterly) > filingBasisDate(annual) ? latestQuarterly : undefined;
}

const EARNINGS_RELEASE_ITEM_CODE = "2.02";

function byFilingRecency(left: SecFiling, right: SecFiling): number {
  return (
    right.filingDate.localeCompare(left.filingDate) ||
    right.accessionNumber.localeCompare(left.accessionNumber)
  );
}

function selectRecentCurrentReports(
  payload: unknown,
  newestPeriodicFilingDate: string,
  fetchedAt: string,
): readonly SecFiling[] {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return [];
  }
  const recent = recentSecFilingRows(payload)
    .filter((filing) => filing.form === "8-K")
    .filter((filing) => {
      const filingDateMs = Date.parse(`${filing.filingDate}T00:00:00.000Z`);
      if (!Number.isFinite(filingDateMs)) {
        return false;
      }
      const ageDays = (fetchedAtMs - filingDateMs) / DAY_MS;
      return ageDays >= 0 && ageDays <= SEC_8K_LOOKBACK_DAYS;
    })
    .toSorted(byFilingRecency);

  // The earnings release is exempt from the periodic-filing floor. That floor exists so routine
  // 8-Ks predating the newest 10-K/10-Q are not re-read, but the Item 2.02 release normally lands
  // Days BEFORE the 10-Q and carries what the periodic filing does not (guidance, segment
  // Commentary, non-GAAP bridges). Filings without item codes are unknown, not empty, so the
  // Selection silently degrades to pure date ordering.
  const earningsRelease = recent.find(
    (filing) => filing.items?.includes(EARNINGS_RELEASE_ITEM_CODE) === true,
  );
  const dateSelected = recent.filter((filing) => filing.filingDate > newestPeriodicFilingDate);

  const selected: SecFiling[] = [];
  for (const filing of [
    ...(earningsRelease === undefined ? [] : [earningsRelease]),
    ...dateSelected,
  ]) {
    if (selected.length >= SEC_8K_LIMIT) {
      break;
    }
    if (!selected.some((chosen) => chosen.accessionNumber === filing.accessionNumber)) {
      selected.push(filing);
    }
  }
  return selected.toSorted(byFilingRecency);
}

function selectRecentEarningsSixKs(payload: unknown, fetchedAt: string): readonly SecFiling[] {
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return [];
  }
  return recentSecFilingRows(payload)
    .filter((filing) => filing.form === "6-K")
    .filter((filing) => {
      const filingDateMs = Date.parse(`${filing.filingDate}T00:00:00.000Z`);
      if (!Number.isFinite(filingDateMs)) {
        return false;
      }
      const ageDays = (fetchedAtMs - filingDateMs) / DAY_MS;
      return ageDays >= 0 && ageDays <= SEC_8K_LOOKBACK_DAYS;
    })
    .toSorted(
      (left, right) =>
        right.filingDate.localeCompare(left.filingDate) ||
        right.accessionNumber.localeCompare(left.accessionNumber),
    )
    .slice(0, SEC_6K_LIMIT);
}

function filingUrl(cik: string, filing: SecFiling): string {
  const primaryDocument = encodeURIComponent(filing.primaryDocument);
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${filing.accessionNumber.replaceAll("-", "")}/${primaryDocument}`;
}

function decodeCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1_114_111
    ? String.fromCodePoint(codePoint)
    : " ";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/&#(\d+);/gu, (_, code: string) => decodeCodePoint(code, 10))
    .replaceAll(/&#x([\da-f]+);/giu, (_, code: string) => decodeCodePoint(code, 16));
}

export function normalizeFilingText(payload: string): string {
  return decodeHtmlEntities(
    payload
      .replaceAll(/<ix:hidden[\s\S]*?<\/ix:hidden>/giu, " ")
      .replaceAll(/<ix:header[\s\S]*?<\/ix:header>/giu, " ")
      .replaceAll(/<script[\s\S]*?<\/script>/giu, " ")
      .replaceAll(/<style[\s\S]*?<\/style>/giu, " ")
      .replaceAll(/<[^>]+>/gu, " "),
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
}

const SEC_RESULTS_TERM_PATTERN =
  /revenue|net income|earnings per share|operating income|net loss/iu;
// Each alternative consumes a whole formatted figure so one figure counts once: the currency
// Form is tried first and swallows any trailing scale word, otherwise "$1.2 billion" would score
// Twice ("$1" plus "2 billion") and two real figures could clear the threshold.
const SEC_MAGNITUDE_TOKEN_PATTERN = new RegExp(
  String.raw`\$\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:thousand|million|billion|trillion)\b)?` +
    String.raw`|\d[\d,]*(?:\.\d+)?\s*(?:thousand|million|billion|trillion)\b` +
    String.raw`|\d{1,3}(?:,\d{3})+(?:\.\d+)?` +
    String.raw`|\(\d+\.\d+\)` +
    String.raw`|\d+(?:\.\d+)?\s?%`,
  "giu",
);

// Deterministic test for "this text reports results" rather than merely naming them. Both halves
// Are required: a cover sheet that says "results of operations ... furnished as Exhibit 99.1"
// Passes the term half and fails the magnitude half.
export function hasSubstantiveResultsContent(normalized: string): boolean {
  return (
    SEC_RESULTS_TERM_PATTERN.test(normalized) &&
    [...normalized.matchAll(SEC_MAGNITUDE_TOKEN_PATTERN)].length >= SEC_RESULTS_MIN_MAGNITUDE_TOKENS
  );
}

function secIdentity(match: { cik: string; ticker: string; name?: string }): InstrumentIdentity {
  return {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const trimmed = value.slice(0, maxChars).trimEnd();
  return `${trimmed}...`;
}

// Per-section char budgets for the bounded SEC section packet. The sum bounds
// The total text projected to the model for profile extraction.
const SEC_SECTION_BUDGETS = {
  business: 2000,
  riskFactors: 1500,
  mdna: 3000,
  segments: 1000,
  notes: 500,
} as const;

// Extracts a bounded slice of `text` starting at `start`, stopping at the next
// ITEM header (to avoid bleeding into the following section) or `maxChars`.
function boundedSection(text: string, start: number, maxChars: number): string {
  const afterStart = text.slice(start);
  const nextItem = /ITEM\s+\d+[A-Z]?\b[.\u2010-\u2015:-]/iu.exec(afterStart.slice(1));
  const endOffset = nextItem !== null ? 1 + nextItem.index : afterStart.length;
  return truncateText(afterStart.slice(0, Math.min(endOffset, maxChars)), maxChars);
}

function substantiveAlphaCount(value: string): number {
  return [...value.matchAll(/\p{L}/gu)].length;
}

// Generates a regex source that matches `literal` (a run of A-Z letters) with optional
// Whitespace tolerated between every character, so drop-cap typography (common in SEC HTML,
// E.g. "ITEM 1. B USINESS" or "RIS K FACTORS") still matches the anchor. `\s*` between
// Characters matches zero-width by default, so this is a strict superset of matching the
// Literal with no whitespace at all \u2014 a normal, non-drop-cap filing anchors identically to
// Before. False positives stay nil because callers always anchor this on a preceding
// `ITEM\s+<n>` header first (see secFilingSectionPacket).
function whitespaceTolerantLiteral(literal: string): string {
  return [...literal].join(String.raw`\s*`);
}

// Shorthand for whitespaceTolerantLiteral, used to build every multi-word section anchor below.
const tw = whitespaceTolerantLiteral;

function selectSection(text: string, pattern: RegExp, maxChars: number): SectionMiss | string {
  const candidates = [...text.matchAll(pattern)].map((match) => {
    const section = boundedSection(text, match.index ?? 0, maxChars);
    return { section, alphaCount: substantiveAlphaCount(section) };
  });
  const [accepted] = candidates
    .filter((candidate) => candidate.alphaCount >= SEC_SECTION_MIN_SELECTED_ALPHA_CHARS)
    .toSorted((a, b) => b.section.length - a.section.length);
  if (accepted !== undefined) {
    return accepted.section;
  }
  const [bestCandidate] = candidates.toSorted((a, b) => b.alphaCount - a.alphaCount);
  return bestCandidate === undefined
    ? { label: "", reason: "absent" }
    : { label: "", reason: "too-short", alphaCount: bestCandidate.alphaCount };
}

interface SecFilingSectionResult {
  readonly packet: string | undefined;
  // Sections the 5-way (10-K) or 4-way (10-Q, which has no Item 1 Business) model expected but
  // Did not find, and why. Empty for 8-K/6-K packets, which have no per-section model.
  readonly misses: readonly SectionMiss[];
  readonly sectionCount: number;
}

// Builds a deterministic bounded section packet from a normalized SEC HTML filing.
function secFilingSectionPacket(
  normalized: string,
  form: SecFiling["form"],
  earningsEventDate?: string,
): SecFilingSectionResult {
  if (normalized.length < SEC_PACKET_MIN_CHARS) {
    return { packet: undefined, misses: [], sectionCount: 0 };
  }
  if (form === "8-K" || form === "6-K") {
    const firstItem = /ITEM\s+\d+\.\d{2}/iu.exec(normalized);
    const base = truncateText(normalized.slice(firstItem?.index ?? 0), SEC_8K_PACKET_BUDGET);
    const earningsSpan =
      earningsEventDate === undefined
        ? undefined
        : retainedEvidenceSpanForEarningsDate(normalized, earningsEventDate);
    const packet =
      earningsSpan === undefined
        ? base
        : truncateText(`${earningsSpan}\n\n${base}`, SEC_8K_PACKET_BUDGET);
    return { packet, misses: [], sectionCount: 0 };
  }
  const mdnaPattern =
    form === "10-K"
      ? new RegExp(`ITEM\\s+7\\b[.\\u2010-\\u2015:-]?\\s*${tw("MANAGEMENT")}`, "giu")
      : new RegExp(`ITEM\\s+2\\b[.\\u2010-\\u2015:-]?\\s*${tw("MANAGEMENT")}`, "giu");
  const segmentsPattern = new RegExp(
    `${tw("SEGMENT")}\\s+(${tw("INFORMATION")}|${tw("REPORTING")}|${tw("DATA")}|${tw("RESULTS")}|${tw("REVENUE")})` +
      `|${tw("GEOGRAPH")}(${tw("IC")}|${tw("IES")}|${tw("Y")})\\s+(${tw("REVENUE")}|${tw("SALES")}|${tw("DISCLOSURE")}|${tw("INFORMATION")}|${tw("DATA")}|${tw("BREAKDOWN")})`,
    "giu",
  );
  const notesPattern = new RegExp(
    // "S?\\s+" (not "\\s*S?\\s+") so the optional S can't overlap the required whitespace run
    // That follows it. "(CONDENSED\\s+)?" covers the Reg S-X interim wording ("NOTES TO
    // CONDENSED CONSOLIDATED FINANCIAL STATEMENTS") every quarterly filer uses.
    `${tw("NOTE")}S?\\s+${tw("TO")}\\s+(${tw("CONDENSED")}\\s+)?(${tw("CONSOLIDATED")}\\s+)?${tw("FINANCIAL")}\\s+${tw("STATEMENTS")}`,
    "giu",
  );
  // Item 1 in a 10-Q is Financial Statements, not Business \u2014 a 10-Q has no Business section to
  // Find, so it is excluded from the expected set entirely rather than reported omitted.
  const sections: readonly {
    readonly label: string;
    readonly pattern: RegExp;
    readonly maxChars: number;
  }[] = [
    ...(form === "10-K"
      ? [
          {
            label: "Business",
            pattern: new RegExp(`ITEM\\s+1\\b[.\\u2010-\\u2015:-]?\\s*${tw("BUSINESS")}`, "giu"),
            maxChars: SEC_SECTION_BUDGETS.business,
          },
        ]
      : []),
    {
      label: "Risk Factors",
      pattern: new RegExp(
        `ITEM\\s+1A\\b[.\\u2010-\\u2015:-]?\\s*${tw("RISK")}\\s+${tw("FACTORS")}`,
        "giu",
      ),
      maxChars: SEC_SECTION_BUDGETS.riskFactors,
    },
    { label: "MD&A", pattern: mdnaPattern, maxChars: SEC_SECTION_BUDGETS.mdna },
    { label: "Segments", pattern: segmentsPattern, maxChars: SEC_SECTION_BUDGETS.segments },
    { label: "Notes", pattern: notesPattern, maxChars: SEC_SECTION_BUDGETS.notes },
  ];
  const parts: string[] = [];
  const misses: SectionMiss[] = [];
  for (const section of sections) {
    const selected = selectSection(normalized, section.pattern, section.maxChars);
    if (typeof selected !== "string") {
      misses.push({ ...selected, label: section.label });
      continue;
    }
    parts.push(`[${section.label}] ${selected}`);
  }
  return {
    packet: parts.length === 0 ? undefined : parts.join("\n\n"),
    misses: parts.length === 0 ? [] : misses,
    sectionCount: sections.length,
  };
}

type SecFilingSourceItem =
  | {
      readonly kind: "built";
      readonly source: Source;
      readonly item: ExtendedEvidenceItem;
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
      // Populated only for the 10-K/10-Q section model (empty for 8-K/6-K, which has none).
      readonly misses: readonly SectionMiss[];
      readonly sectionCount: number;
      readonly normalizedChars: number;
      readonly responseBytes: number;
    }
  | {
      readonly kind: "dropped";
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
    }
  | { readonly kind: "missing" };

function secFilingKey(filing: SecFiling): string {
  if (filing.form === "10-K") {
    return "10k";
  }
  if (filing.form === "10-Q") {
    return "10q";
  }
  if (filing.form === "6-K") {
    return `6k-${filing.accessionNumber}`;
  }
  return `8k-${filing.accessionNumber}`;
}

// Builds a filing evidence item from submissions metadata alone (form, filingDate,
// AccessionNumber, primaryDocument), with no dependency on the filing-text body.
// Used whenever filing-text ingestion fails, is dropped by sanitization, or yields
// Too little substantive content to extract a section packet — the filing-basis
// Date must never be blocked by a filing-text failure (see A1 in the run-quality
// Remediation plan).
function buildSecFilingMetadataOnlyItem(
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  fetchedAt: string,
  rawRef?: string,
  earningsRelease?: EarningsReleaseProvenance,
): {
  readonly source: Source;
  readonly item: ExtendedEvidenceItem;
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
} {
  const formKey = secFilingKey(filing);
  const sanitizedName =
    match.name === undefined
      ? undefined
      : sanitizeModelInputField(match.name, {
          provider: "sec-edgar",
          ingress: "sec-tickers",
          profile: "short-metadata",
          fieldRole: "title",
        });
  const identity = secIdentity({
    cik: match.cik,
    ticker: match.ticker,
    ...(sanitizedName?.text !== undefined ? { name: sanitizedName.text } : {}),
  });
  const title = `${command.symbol} SEC ${filing.form}`;
  const periodLabel = filing.form === "8-K" || filing.form === "6-K" ? "event date" : "period";
  const summary = `${filing.form} filed ${filing.filingDate}${
    filing.reportDate !== undefined ? ` for ${periodLabel} ${filing.reportDate}` : ""
  } (filing text unavailable).`;
  const source: Source = {
    id: `extended-sec-edgar-${command.symbol.toLowerCase()}-${formKey}`,
    title,
    url,
    fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "sec-edgar",
    ...(rawRef !== undefined ? { rawRef } : {}),
    summary,
    identity,
  };
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title,
    summary,
    sourceIds: [source.id],
    observedAt: fetchedAt,
    metrics: {
      form: filing.form,
      filingDate: filing.filingDate,
      ...(filing.reportDate !== undefined ? { reportDate: filing.reportDate } : {}),
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument,
      ...(filing.items === undefined ? {} : { items: filing.items.join(",") }),
      ...(earningsRelease === undefined ? {} : earningsRelease),
      cik: match.cik,
    },
    identity,
  };
  return {
    source,
    item,
    sanitizationEntries: sanitizedName === undefined ? [] : [sanitizedName.entry],
  };
}

// Which document the packet text came from, and what the exhibit lookup found. Persisted so a
// Later reader (and the live invariants) can tell a legitimate cover-document preference from an
// Exhibit-resolution regression — the two are indistinguishable from URL and text alone.
interface EarningsReleaseProvenance {
  readonly earningsReleaseDocument: "exhibit" | "primary" | "none";
  readonly earningsReleaseExhibit: "substantive" | "not-substantive" | "unresolved";
}

function buildSecFilingSourceItem(
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  filingText: FetchTextResult,
  earningsEventDate?: string,
  earningsRelease?: EarningsReleaseProvenance,
): SecFilingSourceItem {
  const formKey = secFilingKey(filing);
  const normalized = normalizeFilingText(filingText.payload);
  const { packet, misses, sectionCount } = secFilingSectionPacket(
    normalized,
    filing.form,
    earningsEventDate,
  );
  if (packet === undefined) {
    return { kind: "missing" };
  }
  const sanitizedPacket = sanitizeModelInputField(packet, {
    provider: "sec-edgar",
    ingress: "sec-filing-text",
    profile: "sec-filing",
    fieldRole: "prose",
  });
  if (
    sanitizedPacket.text === undefined ||
    substantiveAlphaCount(sanitizedPacket.text) < SEC_SECTION_MIN_ALPHA_CHARS
  ) {
    return {
      kind: "dropped",
      sanitizationEntries: [
        sanitizedPacket.entry,
        droppedModelInputItemEntry({
          provider: "sec-edgar",
          ingress: "sec-filing-text",
          profile: "sec-filing",
          fieldRole: "prose",
        }),
      ],
    };
  }
  const sanitizedName =
    match.name === undefined
      ? undefined
      : sanitizeModelInputField(match.name, {
          provider: "sec-edgar",
          ingress: "sec-tickers",
          profile: "short-metadata",
          fieldRole: "title",
        });
  const identity = secIdentity({
    cik: match.cik,
    ticker: match.ticker,
    ...(sanitizedName?.text !== undefined ? { name: sanitizedName.text } : {}),
  });
  const summaryExcerpt = truncateText(sanitizedPacket.text, SEC_FILING_SUMMARY_EXCERPT_CHARS);
  const title = `${command.symbol} SEC ${filing.form}`;
  const summary =
    filing.form === "8-K" || filing.form === "6-K"
      ? `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for event date ${filing.reportDate}` : ""} (material current report).`
      : `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for period ${filing.reportDate}` : ""}.`;
  const source: Source = {
    id: `extended-sec-edgar-${command.symbol.toLowerCase()}-${formKey}`,
    title,
    url,
    fetchedAt: filingText.rawSnapshot.fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "sec-edgar",
    rawRef: filingText.rawSnapshot.id,
    summary,
    snippet: sanitizedPacket.text,
    identity,
  };
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title,
    summary: `${source.summary} Filing excerpt: ${summaryExcerpt}`,
    sourceIds: [source.id],
    observedAt: source.fetchedAt,
    metrics: {
      form: filing.form,
      filingDate: filing.filingDate,
      ...(filing.reportDate !== undefined ? { reportDate: filing.reportDate } : {}),
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument,
      ...(filing.items === undefined ? {} : { items: filing.items.join(",") }),
      ...(earningsRelease === undefined ? {} : earningsRelease),
      cik: match.cik,
    },
    identity,
  };
  return {
    kind: "built",
    source,
    item,
    sanitizationEntries: [
      sanitizedPacket.entry,
      ...(sanitizedName === undefined ? [] : [sanitizedName.entry]),
    ],
    misses,
    sectionCount,
    normalizedChars: normalized.length,
    // Only allocate the whole-document byte count when a gap will actually report it — a
    // Healthy filing (the overwhelming majority) never pays for this encode.
    responseBytes:
      misses.length === 0 ? 0 : new TextEncoder().encode(filingText.payload).byteLength,
  };
}

async function fetchFilingText(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<{ result: FetchTextResult | SourceGap; url: string }> {
  const url = filingUrl(cik, filing);
  const result = await ctx.request.text({
    url,
    adapter: "sec-filing-text",
    // SEC filing text is the one adapter whose payload legitimately exceeds the global
    // Response-byte default (see SEC_FILING_TEXT_MAX_RESPONSE_BYTES and the A2 remediation
    // Plan) — sec.gov gzips, so content-length reports the compressed size while
    // `response.body` yields decompressed bytes several times larger.
    maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
    init: secTextRequestInit(ctx.secUserAgent),
  });
  return { result, url };
}

function secEarningsExhibitGap(
  symbol: string,
  filing: SecFiling,
  exhibitState: string,
  primaryState: string,
): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC Item 2.02 8-K ${filing.accessionNumber} for ${symbol} yielded no substantive earnings-release content (${exhibitState}; ${primaryState})`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

interface EarningsExhibitResolution {
  readonly text?: FetchTextResult;
  readonly url?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

// The results of an Item 2.02 current report live in its EX-99 press release, not the cover
// Document. Walks the bounded EX-99 candidates sequentially, matching the SEC archive rate-limit
// Discipline the untagged-exhibit path already follows.
async function resolveEarningsReleaseExhibit(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<EarningsExhibitResolution> {
  const baseUrl = filingBaseUrl(String(Number(cik)), filing.accessionNumber);
  const init = secTextRequestInit(ctx.secUserAgent);
  const index = await ctx.request.text({
    url: `${baseUrl}/${filing.accessionNumber}-index.html`,
    adapter: "sec-filing-index",
    init,
  });
  if (!isFetchTextResult(index)) {
    return { rawSnapshots: [], gaps: [index] };
  }
  const documents = filingDocuments(index.payload, baseUrl, filing.primaryDocument);
  if (documents.length === 0) {
    return { rawSnapshots: [index.rawSnapshot], gaps: [] };
  }
  const rawSnapshots = [index.rawSnapshot];
  let firstFetchGap: SourceGap | undefined = undefined;
  let attemptedCandidateCount = 0;
  let firstResolved: { readonly text: FetchTextResult; readonly url: string } | undefined =
    undefined;
  let selected: { readonly text: FetchTextResult; readonly url: string } | undefined = undefined;
  for (const document of documents) {
    attemptedCandidateCount += 1;
    // eslint-disable-next-line no-await-in-loop
    const exhibit = await ctx.request.text({
      url: document.url,
      adapter: "sec-earnings-release-exhibit",
      maxResponseBytes: SEC_FILING_TEXT_MAX_RESPONSE_BYTES,
      init,
    });
    if (!isFetchTextResult(exhibit)) {
      firstFetchGap ??= exhibit;
      continue;
    }
    rawSnapshots.push(exhibit.rawSnapshot);
    firstResolved ??= { text: exhibit, url: document.url };
    if (hasSubstantiveResultsContent(normalizeFilingText(exhibit.payload))) {
      selected = { text: exhibit, url: document.url };
      break;
    }
  }
  const gaps =
    firstFetchGap === undefined
      ? []
      : [
          {
            ...firstFetchGap,
            message: `${firstFetchGap.message} (${String(attemptedCandidateCount)} EX-99 candidates attempted)`,
          },
        ];
  return {
    ...(selected ?? firstResolved),
    rawSnapshots,
    gaps,
  };
}

function isEarningsRelease(filing: SecFiling): boolean {
  return filing.form === "8-K" && filing.items?.includes(EARNINGS_RELEASE_ITEM_CODE) === true;
}

function earningsReleaseProvenance(
  exhibit: EarningsExhibitResolution | undefined,
  document: EarningsReleaseProvenance["earningsReleaseDocument"],
  exhibitSubstantive: boolean,
): EarningsReleaseProvenance | undefined {
  if (exhibit === undefined) {
    return undefined;
  }
  let resolved: EarningsReleaseProvenance["earningsReleaseExhibit"] = "unresolved";
  if (exhibit.text !== undefined) {
    resolved = exhibitSubstantive ? "substantive" : "not-substantive";
  }
  return { earningsReleaseDocument: document, earningsReleaseExhibit: resolved };
}

async function collectSecFiling(
  ctx: CollectContext,
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  submissionsRawSnapshot?: RawSourceSnapshot,
): Promise<{
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
  readonly droppedItemCount: number;
}> {
  const { result, url } = await fetchFilingText(ctx, filing, match.cik);
  const primary = isFetchTextResult(result) ? result : undefined;
  const primaryFetchGaps: readonly SourceGap[] = isFetchTextResult(result) ? [] : [result];
  // A failed primary fetch does not rule out the exhibit: index and EX-99 are separate documents,
  // And for an Item 2.02 the exhibit is where the results actually are.
  const exhibit = isEarningsRelease(filing)
    ? await resolveEarningsReleaseExhibit(ctx, filing, match.cik)
    : undefined;
  const exhibitSubstantive =
    exhibit?.text !== undefined &&
    hasSubstantiveResultsContent(normalizeFilingText(exhibit.text.payload));
  const primarySubstantive =
    primary !== undefined && hasSubstantiveResultsContent(normalizeFilingText(primary.payload));
  // The exhibit wins unless it is a non-results document (a conference-call notice, say) and the
  // Cover document does report results.
  const useExhibit =
    exhibit?.text !== undefined &&
    (exhibitSubstantive || !primarySubstantive || primary === undefined);
  const selected = useExhibit ? exhibit.text : primary;
  const selectedUrl = useExhibit ? (exhibit.url ?? url) : url;
  const rawSnapshots = [
    ...(primary === undefined ? [] : [primary.rawSnapshot]),
    ...(exhibit?.rawSnapshots ?? []),
  ];
  const exhibitGaps: readonly SourceGap[] =
    exhibit === undefined
      ? []
      : [
          ...exhibit.gaps,
          ...(exhibitSubstantive || primarySubstantive
            ? []
            : [
                secEarningsExhibitGap(
                  command.symbol,
                  filing,
                  exhibit.text === undefined
                    ? "no EX-99 exhibit resolved"
                    : "the resolved EX-99 exhibit reports no results",
                  primary === undefined
                    ? "no primary document text"
                    : "the primary document reports no results",
                ),
              ]),
        ];
  if (selected === undefined) {
    // No filing text at all. The fetch produced no raw snapshot (e.g. the byte-limit guard throws
    // Before any snapshot is captured), so the honest replayable provenance for this metadata-only
    // Item is the sec-submissions snapshot the form/filingDate/accessionNumber/primaryDocument were
    // Themselves read from (ADR 0004: evidence must remain replayable through raw snapshots).
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      url,
      submissionsRawSnapshot?.fetchedAt ?? ctx.fetchedAt,
      submissionsRawSnapshot?.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps],
      sanitizationEntries: metadataOnly.sanitizationEntries,
      droppedItemCount: 0,
    };
  }
  const built = buildSecFilingSourceItem(
    command,
    match,
    filing,
    selectedUrl,
    selected,
    ctx.earningsEventDate,
    earningsReleaseProvenance(exhibit, useExhibit ? "exhibit" : "primary", exhibitSubstantive),
  );
  if (built.kind === "missing") {
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      selectedUrl,
      selected.rawSnapshot.fetchedAt,
      selected.rawSnapshot.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps, secPacketGap(command.symbol, filing.form)],
      sanitizationEntries: metadataOnly.sanitizationEntries,
      droppedItemCount: 0,
    };
  }
  if (built.kind === "dropped") {
    const metadataOnly = buildSecFilingMetadataOnlyItem(
      command,
      match,
      filing,
      selectedUrl,
      selected.rawSnapshot.fetchedAt,
      selected.rawSnapshot.id,
      earningsReleaseProvenance(exhibit, "none", exhibitSubstantive),
    );
    return {
      rawSnapshots,
      sources: [metadataOnly.source],
      items: [metadataOnly.item],
      gaps: [...primaryFetchGaps, ...exhibitGaps],
      sanitizationEntries: [...built.sanitizationEntries, ...metadataOnly.sanitizationEntries],
      droppedItemCount: 1,
    };
  }
  const omissionGaps =
    built.misses.length === 0
      ? []
      : [
          secSectionOmissionGap(
            command.symbol,
            filing.form,
            built.misses,
            built.sectionCount - built.misses.length,
            built.sectionCount,
            built.normalizedChars,
            built.responseBytes,
          ),
        ];
  return {
    rawSnapshots,
    sources: [built.source],
    items: [built.item],
    gaps: [...primaryFetchGaps, ...exhibitGaps, ...omissionGaps],
    sanitizationEntries: built.sanitizationEntries,
    droppedItemCount: 0,
  };
}

export async function collectSecFilingEvidence(
  ctx: CollectContext,
  companyFacts?: SecCompanyFactsResult,
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return emptyOutput([
      sourceGap({
        source: "sec-edgar",
        message: "SEC filing requests require ticker runs",
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return emptyOutput([unsupportedInstrumentGap("sec-edgar", "SEC EDGAR", command.symbol)]);
  }
  const prefetchedMatch =
    companyFacts?.cik === undefined
      ? undefined
      : {
          cik: companyFacts.cik,
          ticker: companyFacts.symbol,
          ...(companyFacts.identity?.displayName !== undefined
            ? { name: companyFacts.identity.displayName }
            : {}),
        };
  const prefetchedSubmissions = companyFacts?.submissionsPayload;
  let match = prefetchedMatch;
  let submissionsPayload = prefetchedSubmissions;
  let sharedRawSnapshots: readonly RawSourceSnapshot[] = [];
  if (match === undefined || submissionsPayload === undefined) {
    const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
    const tickers = await ctx.request.json({
      url: tickersUrl,
      adapter: "sec-tickers",
      init: secRequestInit(ctx.secUserAgent),
    });
    if (!isFetchJsonResult(tickers)) {
      return emptyOutput([tickers]);
    }
    match = findSecTicker(tickers.payload, command.symbol);
    if (match === undefined) {
      return emptyOutput(
        [
          sourceGap({
            source: "sec-edgar",
            message: `No SEC CIK match for ${command.symbol}`,
            provider: "sec-edgar",
            capability: "evidence-request",
            cause: "unsupported-coverage",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
        [tickers.rawSnapshot],
      );
    }
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
    const submissions = await ctx.request.json({
      url: submissionsUrl,
      adapter: "sec-submissions",
      init: secRequestInit(ctx.secUserAgent),
    });
    if (!isFetchJsonResult(submissions)) {
      return emptyOutput([submissions], [tickers.rawSnapshot]);
    }
    submissionsPayload = submissions.payload;
    sharedRawSnapshots = [tickers.rawSnapshot, submissions.rawSnapshot];
  }
  const submissionsRawSnapshot =
    sharedRawSnapshots.find((snapshot) => snapshot.adapter === "sec-submissions") ??
    companyFacts?.rawSnapshots.find((snapshot) => snapshot.adapter === "sec-submissions");

  const tenK = selectLatestFilingByForm(submissionsPayload, "10-K");
  const tenQ = selectCurrentQuarterlyFiling(submissionsPayload, tenK);
  const fpiForms = detectForeignPrivateIssuerForms(submissionsPayload);
  const sixKs =
    tenK === undefined && tenQ === undefined
      ? selectRecentEarningsSixKs(submissionsPayload, ctx.fetchedAt)
      : [];

  if (tenK === undefined && tenQ === undefined && sixKs.length === 0) {
    return emptyOutput(
      [
        sourceGap({
          source: "sec-edgar",
          message:
            fpiForms.length > 0
              ? `${command.symbol} files as a foreign private issuer (${fpiForms.join(", ")}); no eligible recent 6-K filing was available and annual-report section parsing remains unsupported`
              : `No SEC 10-K or 10-Q filing found for ${command.symbol}`,
          provider: "sec-edgar",
          capability: "evidence-request",
          cause: fpiForms.length > 0 ? "unsupported-coverage" : "provider-data-missing",
          evidenceQualityImpact: "core-cap",
        }),
      ],
      sharedRawSnapshots,
    );
  }

  const sources: Source[] = [];
  const items: ExtendedEvidenceItem[] = [];
  const gaps: SourceGap[] =
    tenK === undefined && tenQ === undefined
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `${command.symbol} files as a foreign private issuer (${fpiForms.join(", ")}); recent 6-K text is attempted, while annual-report section parsing remains unsupported`,
            provider: "sec-edgar",
            capability: "evidence-request",
            cause: "unsupported-coverage",
            evidenceQualityImpact: "core-cap",
          }),
        ]
      : [];
  const rawSnapshots: RawSourceSnapshot[] = [...sharedRawSnapshots];
  const sanitizationEntries: ModelInputSanitizationAggregateEntry[] = [];
  let droppedItemCount = 0;

  const [newestPeriodicFilingDate] = [tenK?.filingDate, tenQ?.filingDate]
    .filter((date): date is string => date !== undefined)
    .toSorted((left, right) => right.localeCompare(left));
  const eightKs =
    newestPeriodicFilingDate === undefined
      ? []
      : selectRecentCurrentReports(submissionsPayload, newestPeriodicFilingDate, ctx.fetchedAt);

  const filingResults = await Promise.all(
    [tenK, tenQ, ...eightKs, ...sixKs].flatMap((filing) =>
      filing === undefined
        ? []
        : [collectSecFiling(ctx, command, match, filing, submissionsRawSnapshot)],
    ),
  );
  for (const result of filingResults) {
    rawSnapshots.push(...result.rawSnapshots);
    sources.push(...result.sources);
    items.push(...result.items);
    gaps.push(...result.gaps);
    sanitizationEntries.push(...result.sanitizationEntries);
    droppedItemCount += result.droppedItemCount;
  }
  // When the latest 10-K is present but metadata lists no 10-Q after it, quarterly coverage is not-applicable (not a missing gap): the issuer has not filed an interim report since its annual.
  // A missing annual 10-K is an explicit core-cap gap even when a 10-Q exists.
  if (tenK === undefined && tenQ !== undefined) {
    gaps.push(
      sourceGap({
        source: "sec-edgar",
        message: `No SEC 10-K filing found for ${command.symbol}; only quarterly 10-Q available`,
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "provider-data-missing",
        evidenceQualityImpact: "core-cap",
      }),
    );
  }
  if (droppedItemCount > 0) {
    gaps.push(secSanitizationGap(command.symbol, droppedItemCount));
  }

  return {
    rawSnapshots,
    sources,
    items,
    gaps,
    modelInputSanitization: aggregateModelInputSanitization(sanitizationEntries),
  };
}

function readTradierExpirations(payload: unknown): readonly string[] {
  const expirations = isRecord(payload) ? payload.expirations : undefined;
  return readArray(expirations, "date")
    .filter((date): date is string => typeof date === "string")
    .toSorted();
}

function dteFrom(fetchedAt: string, expiration: string): number | undefined {
  const diff = new Date(`${expiration}T00:00:00.000Z`).getTime() - new Date(fetchedAt).getTime();
  if (!Number.isFinite(diff)) {
    return undefined;
  }
  return Math.max(0, Math.round(diff / DAY_MS));
}

function nearestExpirationBuckets(payload: unknown, fetchedAt: string): readonly TradierBucket[] {
  const expirations = readTradierExpirations(payload);
  const used = new Set<string>();
  return TRADIER_TARGET_DTES.flatMap((targetDte) => {
    const candidates = expirations
      .map((expiration) => {
        const dte = dteFrom(fetchedAt, expiration);
        return dte === undefined ? undefined : { expiration, dte };
      })
      .filter(
        (candidate): candidate is { expiration: string; dte: number } => candidate !== undefined,
      )
      .filter((candidate) => !used.has(candidate.expiration))
      .toSorted((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
    const [selected] = candidates;
    if (selected === undefined) {
      return [];
    }
    used.add(selected.expiration);
    return [{ targetDte, expiration: selected.expiration, dte: selected.dte }];
  });
}

function readTradierIvValues(payload: unknown): readonly number[] {
  const options =
    isRecord(payload) && isRecord(payload.options) ? readArray(payload.options, "option") : [];
  return options
    .filter((option) => isRecord(option))
    .map((option) => {
      const greeks = isRecord(option.greeks) ? option.greeks : undefined;
      return greeks !== undefined
        ? (readNumber(greeks, "mid_iv") ?? readNumber(greeks, "iv"))
        : undefined;
    })
    .filter((value): value is number => value !== undefined)
    .toSorted((a, b) => a - b);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[mid - 1] as number) + (values[mid] as number)) / 2
    : (values[mid] as number);
}

function tradierChainUrl(symbol: string, expiration: string): string {
  return `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol,
    expiration,
    greeks: "true",
  })}`;
}

async function collectTradierIvTermStructure(
  ctx: CollectContext,
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return emptyOutput([
      sourceGap({
        source: "tradier-options",
        message: "Tradier IV requests require ticker runs",
        provider: "tradier",
        capability: "evidence-request",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return emptyOutput([unsupportedInstrumentGap("tradier-options", "Tradier", command.symbol)]);
  }
  if (ctx.tradierApiToken === undefined) {
    return emptyOutput([
      sourceGap({
        source: "tradier-options",
        message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
        provider: "tradier",
        capability: "evidence-request",
        cause: "missing-credential",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }

  const init = tradierRequestInit(ctx.tradierApiToken);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: command.symbol,
    includeAllRoots: "true",
  })}`;
  const expirations = await ctx.request.json({
    url: expirationsUrl,
    adapter: "tradier-expirations",
    init,
  });
  if (!isFetchJsonResult(expirations)) {
    return emptyOutput([expirations]);
  }

  const buckets = nearestExpirationBuckets(expirations.payload, expirations.rawSnapshot.fetchedAt);
  if (buckets.length === 0) {
    return emptyOutput(
      [
        sourceGap({
          source: "tradier-options",
          message: "No Tradier option expirations found",
          provider: "tradier",
          capability: "evidence-request",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
      [expirations.rawSnapshot],
    );
  }

  const chainResults = await Promise.all(
    buckets.map(async (bucket) => {
      const url = tradierChainUrl(command.symbol, bucket.expiration);
      return {
        bucket,
        url,
        result: await ctx.request.json({
          url,
          adapter: "tradier-options",
          init,
        }),
      };
    }),
  );
  return tradierTermStructureOutput(command, expirationsUrl, expirations, chainResults);
}

function tradierTermStructureOutput(
  command: InstrumentCommand,
  expirationsUrl: string,
  expirations: FetchJsonResult,
  chainResults: readonly {
    readonly bucket: TradierBucket;
    readonly url: string;
    readonly result: FetchJsonResult | SourceGap;
  }[],
): EvidenceRequestToolOutput {
  const rawSnapshots = [
    expirations.rawSnapshot,
    ...chainResults.flatMap((entry) =>
      isFetchJsonResult(entry.result) ? [entry.result.rawSnapshot] : [],
    ),
  ];
  const gaps: SourceGap[] = chainResults.flatMap((entry) => {
    if (!isFetchJsonResult(entry.result)) {
      return [entry.result];
    }
    return median(readTradierIvValues(entry.result.payload)) === undefined
      ? [
          sourceGap({
            source: "tradier-options",
            message: `No Tradier IV values found for expiration ${entry.bucket.expiration}`,
            provider: "tradier",
            capability: "evidence-request",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];
  });
  const bucketIvs: readonly TradierBucketIv[] = chainResults.flatMap((entry) => {
    if (!isFetchJsonResult(entry.result)) {
      return [];
    }
    const medianIv = median(readTradierIvValues(entry.result.payload));
    return medianIv === undefined ? [] : [{ ...entry.bucket, medianIv }];
  });

  if (bucketIvs.length === 0) {
    return { rawSnapshots, sources: [], items: [], gaps };
  }
  const outputFetchedAt = latestRawSnapshotFetchedAt(
    chainResults.flatMap((entry) =>
      isFetchJsonResult(entry.result) ? [entry.result.rawSnapshot] : [],
    ),
    expirations.rawSnapshot.fetchedAt,
  );

  const metrics: Record<string, number | string> = {};
  for (const bucket of bucketIvs) {
    metrics[`medianIv${String(bucket.targetDte)}Dte`] = bucket.medianIv;
    metrics[`expiration${String(bucket.targetDte)}Dte`] = bucket.expiration;
    metrics[`actualDte${String(bucket.targetDte)}Dte`] = bucket.dte;
  }
  const byTarget = new Map(bucketIvs.map((bucket) => [bucket.targetDte, bucket.medianIv]));
  const iv7 = byTarget.get(7);
  const iv30 = byTarget.get(30);
  const iv60 = byTarget.get(60);
  const iv90 = byTarget.get(90);
  if (iv7 !== undefined && iv30 !== undefined) {
    metrics.iv30Minus7 = iv30 - iv7;
  }
  if (iv30 !== undefined && iv60 !== undefined) {
    metrics.iv60Minus30 = iv60 - iv30;
  }
  if (iv30 !== undefined && iv90 !== undefined) {
    metrics.iv90Minus30 = iv90 - iv30;
  }

  const summary = [
    "Tradier IV term structure:",
    bucketIvs
      .map(
        (bucket) =>
          `${String(bucket.targetDte)}D ${bucket.medianIv.toFixed(3)} (${bucket.expiration})`,
      )
      .join(", "),
    iv7 !== undefined && iv30 !== undefined ? `30D-7D slope ${(iv30 - iv7).toFixed(3)}.` : "",
    iv30 !== undefined && iv90 !== undefined ? `90D-30D slope ${(iv90 - iv30).toFixed(3)}.` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  const rawRef = rawSnapshots.at(-1)?.id;
  const source: Source = {
    id: `extended-tradier-iv-term-${command.symbol.toLowerCase()}`,
    title: `${command.symbol} IV term structure`,
    url: expirationsUrl,
    fetchedAt: outputFetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "tradier",
    ...(rawRef !== undefined ? { rawRef } : {}),
    summary,
  };
  const item: ExtendedEvidenceItem = {
    category: "options-iv",
    title: `${command.symbol} IV term structure`,
    summary,
    sourceIds: [source.id],
    observedAt: outputFetchedAt,
    metrics,
  };

  return { rawSnapshots, sources: [source], items: [item], gaps };
}
