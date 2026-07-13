import type {
  SourceGap,
  SourceGapCapability,
  SourceGapCause,
  SourceGapEvidenceQualityImpact,
} from "./types";

export type SourceGapAnalyticsClass =
  | "missingCredential"
  | "fetchFailed"
  | "unsupportedCoverage"
  | "other";
type FetchFailureSourceGapCause = Extract<SourceGapCause, "fetch-failed" | "circuit-open">;

// Exhaustive membership tables keyed by every union member.
// The `satisfies Record<Union, true>` constraint fails typecheck if a member is missing.
// Runtime guards below therefore cannot silently drift behind the type.
const SOURCE_GAP_CAUSE_TABLE = {
  "missing-credential": true,
  "fetch-failed": true,
  "circuit-open": true,
  "stale-fallback": true,
  "unsupported-coverage": true,
  "repeat-fallback": true,
  "malformed-response": true,
  "validation-failed": true,
  "provider-data-missing": true,
} satisfies Record<SourceGapCause, true>;

const SOURCE_GAP_CAPABILITY_TABLE = {
  "market-data": true,
  news: true,
  discussion: true,
  "extended-evidence": true,
  "market-context": true,
  "evidence-request": true,
  "web-gather": true,
  mcp: true,
  cache: true,
} satisfies Record<SourceGapCapability, true>;

const SOURCE_GAP_EVIDENCE_QUALITY_IMPACT_TABLE = {
  "core-cap": true,
  "extended-evidence-cap": true,
  "no-cap": true,
} satisfies Record<SourceGapEvidenceQualityImpact, true>;

const SOURCE_GAP_CAUSES: ReadonlySet<string> = new Set(Object.keys(SOURCE_GAP_CAUSE_TABLE));
const SOURCE_GAP_CAPABILITIES: ReadonlySet<string> = new Set(
  Object.keys(SOURCE_GAP_CAPABILITY_TABLE),
);
const SOURCE_GAP_EVIDENCE_QUALITY_IMPACTS: ReadonlySet<string> = new Set(
  Object.keys(SOURCE_GAP_EVIDENCE_QUALITY_IMPACT_TABLE),
);

export function isSourceGapCause(value: unknown): value is SourceGapCause {
  return typeof value === "string" && SOURCE_GAP_CAUSES.has(value);
}

export function isSourceGapCapability(value: unknown): value is SourceGapCapability {
  return typeof value === "string" && SOURCE_GAP_CAPABILITIES.has(value);
}

export function isSourceGapEvidenceQualityImpact(
  value: unknown,
): value is SourceGapEvidenceQualityImpact {
  return typeof value === "string" && SOURCE_GAP_EVIDENCE_QUALITY_IMPACTS.has(value);
}

export interface SourceGapInput {
  readonly source: string;
  readonly message: string;
  readonly provider?: string;
  readonly capability?: SourceGapCapability;
  readonly cause?: SourceGapCause;
  readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
}

export function sourceGap(input: SourceGapInput): SourceGap {
  return {
    source: input.source,
    message: input.message,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.capability !== undefined ? { capability: input.capability } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
    ...(input.evidenceQualityImpact !== undefined
      ? { evidenceQualityImpact: input.evidenceQualityImpact }
      : {}),
  };
}

export function sourceGapReportText(gap: SourceGap): string {
  return `${gap.source}: ${gap.message.replaceAll(/\s+/gu, " ").trim()}`;
}

function normalizeGapText(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().toLowerCase();
}

export function sourceGapReportTextKey(gap: SourceGap): string {
  return normalizeGapText(sourceGapReportText(gap));
}

export function dedupeSourceGaps(gaps: readonly SourceGap[]): readonly SourceGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = sourceGapReportTextKey(gap);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function sourceGapStatusCode(message: string): string | undefined {
  return message.match(/status\s+(\d{3})/iu)?.[1];
}

export function sourceGapWithContext(
  gap: SourceGap,
  context: {
    readonly provider?: string;
    readonly capability?: SourceGapCapability;
    readonly cause?: SourceGapCause;
    readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
  },
): SourceGap {
  const provider = context.provider ?? gap.provider;
  const capability = context.capability ?? gap.capability;
  const cause = context.cause ?? gap.cause;
  const evidenceQualityImpact = context.evidenceQualityImpact ?? gap.evidenceQualityImpact;

  return sourceGap({
    source: gap.source,
    message: gap.message,
    ...(provider !== undefined ? { provider } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
  });
}

export function fetchFailureSourceGap(
  source: string,
  message: string,
  cause: FetchFailureSourceGapCause = "fetch-failed",
): SourceGap {
  return sourceGap({
    source,
    message,
    cause,
    evidenceQualityImpact: "core-cap",
  });
}

// Matches unmapped SEC filing messages produced by the alpha-search SEC discovery path.
// Each such gap has source "sec-alpha-search" and a message of the form
// "SEC filing <FORM> <YYYY-MM-DD> did not map to a ticker".
const UNMAPPED_SEC_FILING_RE =
  /^SEC filing (?<form>[A-Z0-9/-]+) (?<date>\d{4}-\d{2}-\d{2}) did not map to a ticker$/u;

// Returns true for unmapped-SEC-filing source gaps.
export function isUnmappedSecFilingGap(gap: SourceGap): boolean {
  return gap.source === "sec-alpha-search" && UNMAPPED_SEC_FILING_RE.test(gap.message);
}

// Compacts unmapped-SEC-filing source gaps by deduplicating and appending
// "(N filings)" to the surviving entry's message when count > 1.
// Non-SEC gaps and unique unmapped-SEC gaps pass through unchanged.
// Apply before writing the normalized source-gaps.json sidecar so the persisted
// Content matches the compacted representation shown in rendered reports.
export function compactUnmappedSecFilingGaps(gaps: readonly SourceGap[]): readonly SourceGap[] {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    if (isUnmappedSecFilingGap(gap)) {
      counts.set(gap.message, (counts.get(gap.message) ?? 0) + 1);
    }
  }
  return dedupeSourceGaps(gaps).map((gap) => {
    if (!isUnmappedSecFilingGap(gap)) {
      return gap;
    }
    const count = counts.get(gap.message);
    if (count === undefined || count <= 1) {
      return gap;
    }
    return { ...gap, message: `${gap.message} (${String(count)} filings)` };
  });
}

// SEC company-fact gaps list their missing fact names inline, e.g.
// "Missing SEC company facts: grossProfit, capex". A run that computes fundamentals
// Across more than one fact set can emit several such gaps whose fact lists overlap or
// Nest (e.g. "grossProfit" alongside "grossProfit, capex"), which double-counts the same
// Missing fact in rendered reports and gap totals. Consolidate them into a single gap
// Listing the first-seen union of fact names.
const SEC_COMPANY_FACTS_PREFIX = "Missing SEC company facts: ";

// Parses the ordered fact list from a sec-edgar company-facts gap. Returns undefined
// For any other gap (non-SEC source, different message, or an empty fact list).
function secCompanyFactNames(gap: SourceGap): readonly string[] | undefined {
  if (gap.source !== "sec-edgar") {
    return undefined;
  }
  const normalized = gap.message.replaceAll(/\s+/gu, " ").trim();
  if (!normalized.startsWith(SEC_COMPANY_FACTS_PREFIX)) {
    return undefined;
  }
  const facts = normalized
    .slice(SEC_COMPANY_FACTS_PREFIX.length)
    .split(",")
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0);
  return facts.length > 0 ? facts : undefined;
}

// Groups company-fact gaps only when their non-message context matches, so gaps with a
// Different provider/capability/cause/impact are never merged into one another.
function secCompanyFactsGroupKey(gap: SourceGap): string {
  return JSON.stringify([
    gap.provider ?? null,
    gap.capability ?? null,
    gap.cause ?? null,
    gap.evidenceQualityImpact ?? null,
  ]);
}

// Collapses overlapping sec-edgar "Missing SEC company facts:" gaps into one gap per
// Context group, listing the first-seen union of missing fact names. The surviving gap
// Keeps the position and context of the first gap in its group; later group members are
// Dropped. Non-SEC gaps, gaps with a different message, and groups with a single gap pass
// Through unchanged. Apply before rendering/counting gaps.
export function consolidateSecCompanyFactGaps(gaps: readonly SourceGap[]): readonly SourceGap[] {
  const groups = new Map<string, { firstIndex: number; facts: string[]; count: number }>();
  gaps.forEach((gap, index) => {
    const facts = secCompanyFactNames(gap);
    if (facts === undefined) {
      return;
    }
    const key = secCompanyFactsGroupKey(gap);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { firstIndex: index, facts: [...facts], count: 1 });
      return;
    }
    group.count += 1;
    for (const fact of facts) {
      if (!group.facts.includes(fact)) {
        group.facts.push(fact);
      }
    }
  });

  return gaps.flatMap((gap, index) => {
    const facts = secCompanyFactNames(gap);
    if (facts === undefined) {
      return [gap];
    }
    const group = groups.get(secCompanyFactsGroupKey(gap));
    if (group === undefined || group.count <= 1) {
      return [gap];
    }
    if (index !== group.firstIndex) {
      return [];
    }
    return [{ ...gap, message: `${SEC_COMPANY_FACTS_PREFIX}${group.facts.join(", ")}` }];
  });
}

export function sourceGapAnalyticsClass(gap: SourceGap): SourceGapAnalyticsClass {
  const { cause } = gap;
  switch (cause) {
    case "missing-credential": {
      return "missingCredential";
    }
    case "fetch-failed":
    case "circuit-open": {
      return "fetchFailed";
    }
    case "unsupported-coverage": {
      return "unsupportedCoverage";
    }
    case "stale-fallback":
    case "repeat-fallback":
    case "malformed-response":
    case "validation-failed":
    case "provider-data-missing":
    case undefined: {
      return "other";
    }
    default: {
      return assertNever(cause);
    }
  }
}

export function isRepeatFallbackGap(gap: SourceGap): boolean {
  return gap.cause === "repeat-fallback";
}

export function isCoreEvidenceQualityGap(gap: SourceGap): boolean {
  // Legacy untyped gaps are core evidence gaps until their producers opt into a narrower impact.
  return gap.evidenceQualityImpact === "core-cap" || gap.evidenceQualityImpact === undefined;
}

export function isExtendedEvidenceQualityGap(gap: SourceGap): boolean {
  return gap.evidenceQualityImpact === "extended-evidence-cap";
}

export function extendedEvidenceGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    capability: gap.capability ?? "extended-evidence",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

export function marketContextGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    capability: "market-context",
    evidenceQualityImpact: "no-cap",
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source gap cause: ${String(value)}`);
}
