// Dimensional ASC 280 segment facts and extension capex lines read from a 10-K/10-Q inline XBRL primary document.
export const SEGMENT_FACT_PREFIX = "segment|";
export const SEGMENT_UNIT_KEY = "segmentUnit";
export const GEOGRAPHY_FACT_PREFIX = "geography|";
export const GEOGRAPHY_UNIT_KEY = "geographyUnit";
export const GEOGRAPHY_TOTAL_MEMBER = "total";
export const EXTENSION_CAPEX_FACT_PREFIX = "extensionCapex|";
export const EXTENSION_CAPEX_CHECKED_KEY = "extensionCapexChecked";

export type SegmentMeasure = "revenue" | "operatingIncome";

// Standard members for non-reportable or unallocated amounts, which are not segments.
const NON_SEGMENT_MEMBERS = new Set([
  "us-gaap:AllOtherSegmentsMember",
  "us-gaap:CorporateNonSegmentMember",
  "us-gaap:MaterialReconcilingItemsMember",
]);

const SEGMENT_AXIS = "us-gaap:StatementBusinessSegmentsAxis";
const GEOGRAPHY_AXIS = "srt:StatementGeographicalAxis";
const ALLOWED_EXTRA_DIMENSIONS: Readonly<Record<string, string>> = {
  "srt:ConsolidationItemsAxis": "us-gaap:OperatingSegmentsMember",
};
// Ordered by preference; a filing that tags both keeps the first.
const CONCEPTS: readonly (readonly [string, SegmentMeasure])[] = [
  ["us-gaap:Revenues", "revenue"],
  ["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "revenue"],
  ["us-gaap:OperatingIncomeLoss", "operatingIncome"],
];
// Keyed by concept, so a total tagged with both keeps the one each region pairs with.
export const GEOGRAPHY_CONCEPTS = [
  "us-gaap:Revenues",
  "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
] as const;

interface SegmentContext {
  readonly member: string;
  readonly start: string;
  readonly end: string;
}

function attribute(attrs: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "u").exec(attrs)?.[1];
}

// `totalMember` keeps dimensionless contexts under that name, as the consolidated denominator.
function segmentContexts(
  html: string,
  periodEnd: string,
  axis: string,
  totalMember?: string,
): ReadonlyMap<string, SegmentContext> {
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
      if (dimension === axis) {
        member = value!.trim();
      } else if (ALLOWED_EXTRA_DIMENSIONS[dimension!] !== value!.trim()) {
        foreign = true;
      }
    }
    if (totalMember !== undefined && !body!.includes("<xbrli:segment>")) {
      contexts.set(id!, { member: totalMember, start, end });
    } else if (
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
  return dimensionalFactMetrics(
    html,
    segmentContexts(html, periodEnd, SEGMENT_AXIS),
    CONCEPTS,
    SEGMENT_FACT_PREFIX,
    SEGMENT_UNIT_KEY,
  );
}

// Flat `geography|<member>|<concept>|<start>|<end>` metrics plus `geography|total|...` consolidated revenue.
export function secGeographyFactMetrics(
  html: string,
  periodEnd: string | undefined,
): Record<string, number | string> {
  if (periodEnd === undefined || !html.includes(GEOGRAPHY_AXIS)) {
    return {};
  }
  const metrics = dimensionalFactMetrics(
    html,
    segmentContexts(html, periodEnd, GEOGRAPHY_AXIS, GEOGRAPHY_TOTAL_MEMBER),
    GEOGRAPHY_CONCEPTS.map((concept) => [concept, concept] as const),
    GEOGRAPHY_FACT_PREFIX,
    GEOGRAPHY_UNIT_KEY,
  );
  const hasRegion = Object.keys(metrics).some(
    (key) =>
      key.startsWith(GEOGRAPHY_FACT_PREFIX) &&
      !key.startsWith(`${GEOGRAPHY_FACT_PREFIX}${GEOGRAPHY_TOTAL_MEMBER}|`),
  );
  return hasRegion ? metrics : {};
}

function dimensionalFactMetrics(
  html: string,
  contexts: ReadonlyMap<string, SegmentContext>,
  concepts: readonly (readonly [string, string])[],
  prefix: string,
  unitKey: string,
): Record<string, number | string> {
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
    const rank = concepts.findIndex(([name]) => name === concept);
    const context = contexts.get(attribute(attrs, "contextRef") ?? "");
    const value = factValue(attrs, content);
    if (rank === -1 || context === undefined || value === undefined) {
      continue;
    }
    const unit = unitMeasures.get(attribute(attrs, "unitRef") ?? "") ?? "unknown";
    const key = `${prefix}${context.member}|${concepts[rank]![1]}|${context.start}|${context.end}`;
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
    [unitKey]: keptUnits.size === 1 ? [...keptUnits][0]! : "mixed",
  };
}

const STANDARD_TAXONOMIES = new Set(["us-gaap", "ifrs-full", "dei", "srt"]);
// Closed lists: a false positive only withholds capex, a miss publishes an understated one.
const PPE_ASSET_WORDS = new Set([
  "Hardware",
  "Equipment",
  "Machinery",
  "Property",
  "Plant",
  "Building",
  "Buildings",
  "Miners",
  "Servers",
]);
const NON_PPE_WORDS = new Set([
  "Prepayment",
  "Prepayments",
  "Deposit",
  "Deposits",
  "Right",
  "Intangible",
  "Intangibles",
  "Business",
  "Businesses",
  "Investment",
  "Investments",
  "Lease",
  "Leases",
  // Accounting Scope, not a missing PP&E line (AMD 2025 10-Q).
  "Discontinued",
]);

function isExtensionCapexConcept(concept: string): boolean {
  const [prefix, local = ""] = concept.split(":");
  const words = local.match(/[A-Z][a-z]*/gu) ?? [];
  return (
    !STANDARD_TAXONOMIES.has(prefix!) &&
    words[0] === "Payments" &&
    words.some((word) => PPE_ASSET_WORDS.has(word)) &&
    !words.some((word) => NON_PPE_WORDS.has(word))
  );
}

// Flat `extensionCapex|<concept>|<start>|<end>|<unit>` metrics for issuer-extension PP&E-like payments.
export function secExtensionCapexFactMetrics(
  html: string,
  periodEnd: string | undefined,
): Record<string, number | string> {
  if (periodEnd === undefined) {
    return {};
  }
  const contexts = segmentContexts(html, periodEnd, "", GEOGRAPHY_TOTAL_MEMBER);
  const unitMeasures = units(html);
  const metrics: Record<string, number | string> = { [EXTENSION_CAPEX_CHECKED_KEY]: "true" };
  for (const [, attrs, content] of html.matchAll(
    /<ix:nonFraction\b[^>]*\/>|<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gu,
  )) {
    const concept = attrs === undefined ? undefined : attribute(attrs, "name");
    const context = contexts.get(attribute(attrs ?? "", "contextRef") ?? "");
    const value = concept === undefined ? undefined : factValue(attrs!, content!);
    if (
      concept !== undefined &&
      context !== undefined &&
      value !== undefined &&
      value !== 0 &&
      isExtensionCapexConcept(concept)
    ) {
      const unit = unitMeasures.get(attribute(attrs!, "unitRef") ?? "") ?? "unknown";
      metrics[`${EXTENSION_CAPEX_FACT_PREFIX}${concept}|${context.start}|${context.end}|${unit}`] =
        Math.abs(value);
    }
  }
  return metrics;
}
