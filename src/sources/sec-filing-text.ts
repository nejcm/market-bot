import { retainedEvidenceSpanForEarningsDate } from "./extended-evidence/earnings-date-confirmation";
import type { SecFiling } from "./sec-filing-selection";

const SEC_PACKET_MIN_CHARS = 50;
export const SEC_SECTION_MIN_ALPHA_CHARS = 40;
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

// A section the 5-way (or 4-way, for 10-Q) model expected but didn't emit: either the anchor
// Never matched ("absent" — e.g. Business in a 10-Q, which has no Item 1 Business) or it matched
// But the candidate slice fell under SEC_SECTION_MIN_SELECTED_ALPHA_CHARS ("too-short" — content
// Exists but was discarded, distinct from the section not being filed at all).
export interface SectionMiss {
  readonly label: string;
  readonly reason: "absent" | "too-short";
  readonly alphaCount?: number;
}

export function sectionMissDescription(miss: SectionMiss): string {
  return miss.reason === "absent"
    ? miss.label
    : `${miss.label} (found, ${String(miss.alphaCount)} alpha chars < ${String(SEC_SECTION_MIN_SELECTED_ALPHA_CHARS)})`;
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

export function truncateText(value: string, maxChars: number): string {
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

export function substantiveAlphaCount(value: string): number {
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
export function secFilingSectionPacket(
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
