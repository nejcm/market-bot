// Dimensional ASC 280 segment facts read from a 10-K/10-Q inline XBRL primary document.
export const SEGMENT_FACT_PREFIX = "segment|";
export const SEGMENT_UNIT_KEY = "segmentUnit";

export type SegmentMeasure = "revenue" | "operatingIncome";

// Standard members for non-reportable or unallocated amounts, which are not segments.
const NON_SEGMENT_MEMBERS = new Set([
  "us-gaap:AllOtherSegmentsMember",
  "us-gaap:CorporateNonSegmentMember",
  "us-gaap:MaterialReconcilingItemsMember",
]);

const SEGMENT_AXIS = "us-gaap:StatementBusinessSegmentsAxis";
const ALLOWED_EXTRA_DIMENSIONS: Readonly<Record<string, string>> = {
  "srt:ConsolidationItemsAxis": "us-gaap:OperatingSegmentsMember",
};
// Ordered by preference; a filing that tags both keeps the first.
const CONCEPTS: readonly (readonly [string, SegmentMeasure])[] = [
  ["us-gaap:Revenues", "revenue"],
  ["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "revenue"],
  ["us-gaap:OperatingIncomeLoss", "operatingIncome"],
];

interface SegmentContext {
  readonly member: string;
  readonly start: string;
  readonly end: string;
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attrs)?.[1];
}

function segmentContexts(html: string, periodEnd: string): ReadonlyMap<string, SegmentContext> {
  const contexts = new Map<string, SegmentContext>();
  for (const [, id, body] of html.matchAll(
    /<xbrli:context id="([^"]+)">([\s\S]*?)<\/xbrli:context>/gu,
  )) {
    const start = /<xbrli:startDate>([^<]+)</u.exec(body!)?.[1]?.trim();
    const end = /<xbrli:endDate>([^<]+)</u.exec(body!)?.[1]?.trim();
    // Periods after the report date are not this filing's; earlier ones are its comparatives.
    if (start === undefined || end === undefined || end > periodEnd) {
      continue;
    }
    let member: string | undefined;
    let foreign = false;
    for (const [, dimension, value] of body!.matchAll(
      /<xbrldi:explicitMember dimension="([^"]+)">([^<]+)</gu,
    )) {
      if (dimension === SEGMENT_AXIS) {
        member = value!.trim();
      } else if (ALLOWED_EXTRA_DIMENSIONS[dimension!] !== value!.trim()) {
        foreign = true;
      }
    }
    if (
      member !== undefined &&
      !NON_SEGMENT_MEMBERS.has(member) &&
      !foreign &&
      !body!.includes("typedMember")
    ) {
      contexts.set(id!, { member, start, end });
    }
  }
  return contexts;
}

function units(html: string): ReadonlyMap<string, string> {
  return new Map(
    [
      ...html.matchAll(
        /<xbrli:unit id="([^"]+)">\s*<xbrli:measure>([^<]+)<\/xbrli:measure>\s*<\/xbrli:unit>/gu,
      ),
    ].map(([, id, measure]) => [id!, measure!.trim()]),
  );
}

const ZERO_FORMATS = new Set(["ixt:fixed-zero", "ixt:zerodash", "ixt:numdash"]);
const DOT_DECIMAL_FORMATS = new Set(["", "ixt:num-dot-decimal", "ixt:numdotdecimal"]);
const COMMA_DECIMAL_FORMATS = new Set([
  "ixt:num-comma-decimal",
  "ixt:numcommadecimal",
  "ixt:numdotcomma",
]);

// Unknown display formats are skipped rather than guessed.
function factValue(attrs: string, content: string): number | undefined {
  const format = (attribute(attrs, "format") ?? "").replace(/^ixt\d*:/u, "ixt:");
  const text = content.replaceAll(/<[^>]*>/gu, "").trim();
  if (ZERO_FORMATS.has(format)) {
    return 0;
  }
  const digits = DOT_DECIMAL_FORMATS.has(format)
    ? text.replaceAll(/[,\s]/gu, "")
    : COMMA_DECIMAL_FORMATS.has(format)
      ? text.replaceAll(/[.\s\u00A0]/gu, "").replace(",", ".")
      : undefined;
  if (digits === undefined || !/^\d+(\.\d+)?$/u.test(digits)) {
    return undefined;
  }
  const value = Number(digits) * 10 ** Number(attribute(attrs, "scale") ?? "0");
  return attribute(attrs, "sign") === "-" ? -value : value;
}

// Flat `segment|<member>|<measure>|<start>|<end>` metrics for periods ending on or before `periodEnd`;
// A key tagged with conflicting values is dropped rather than guessed.
export function secSegmentFactMetrics(
  html: string,
  periodEnd: string | undefined,
): Record<string, number | string> {
  if (periodEnd === undefined || !html.includes(SEGMENT_AXIS)) {
    return {};
  }
  const contexts = segmentContexts(html, periodEnd);
  const unitMeasures = units(html);
  const values = new Map<
    string,
    { value: number; rank: number; unit: string; concept: string } | "conflict"
  >();
  // Self-closing (nil) facts match the first alternative, so they never borrow the next fact's text.
  for (const [, attrs, content] of html.matchAll(
    /<ix:nonFraction\b[^>]*\/>|<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gu,
  )) {
    if (attrs === undefined || content === undefined || /xsi:nil="true"/u.test(attrs)) {
      continue;
    }
    const concept = attribute(attrs, "name");
    const rank = CONCEPTS.findIndex(([name]) => name === concept);
    const context = contexts.get(attribute(attrs, "contextRef") ?? "");
    const value = factValue(attrs, content);
    if (rank === -1 || context === undefined || value === undefined) {
      continue;
    }
    const unit = unitMeasures.get(attribute(attrs, "unitRef") ?? "") ?? "unknown";
    const key = `${SEGMENT_FACT_PREFIX}${context.member}|${CONCEPTS[rank]![1]}|${context.start}|${context.end}`;
    const prior = values.get(key);
    if (prior === undefined || (prior !== "conflict" && rank < prior.rank)) {
      values.set(key, { value, rank, unit, concept: concept! });
    } else if (
      prior !== "conflict" &&
      prior.rank === rank &&
      (prior.value !== value || prior.unit !== unit)
    ) {
      values.set(key, "conflict");
    }
  }
  const kept = [...values].flatMap(([key, entry]) =>
    entry === "conflict" ? [] : [[key, entry] as const],
  );
  if (kept.length === 0) {
    return {};
  }
  const keptUnits = new Set(kept.map(([, entry]) => entry.unit));
  return {
    ...Object.fromEntries(
      kept.flatMap(([key, entry]) => [
        [key, entry.value],
        [`${key}|concept`, entry.concept],
      ]),
    ),
    [SEGMENT_UNIT_KEY]: keptUnits.size === 1 ? [...keptUnits][0]! : "mixed",
  };
}
