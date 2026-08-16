import type { ResearchCommand } from "../cli/args";
import type { Source, WebGatherAcceptancePolicy, WebSearchType } from "../domain/types";
import {
  MAX_WEB_GATHER_SEARCH_RESULTS,
  REUSED_PROFILE_DEFAULT_SEARCH_RESULTS,
} from "../sources/web-gather-tools";
import type { WebGatherSubject } from "../sources/web-gather-emit";
import { isCompanyProfileSecSource } from "./web-subject-profile";
import type { WebGatherContext } from "../research/research-context-types";

// Section markers emitted by `secFilingSectionPacket` (see evidence-request-tools.ts). Detecting coverage from the packet's own markers avoids hard-coding a separate question-key map and stays honest about partial packets.
const SEC_FILING_SECTION_MARKERS = [
  "Business",
  "Risk Factors",
  "MD&A",
  "Segments",
  "Notes",
] as const;
// Keyword signals tying a background web_search query to a durable-profile area the SEC packet already covers. Deliberately conservative: only queries matching these topics are eligible for rejection, so genuinely uncovered background research is never blocked.
const SEC_COVERED_TOPIC_PATTERNS: Readonly<
  Record<(typeof SEC_FILING_SECTION_MARKERS)[number], RegExp>
> = {
  Business:
    /business model|business overview|what (it|the company) does|core business|products? and services|how it makes money/iu,
  "Risk Factors": /risk factors|key risks|business risks/iu,
  "MD&A": /md&a|management discussion|results of operations/iu,
  Segments: /segments?|segment revenue|geographic (revenue|breakdown|mix)|geography/iu,
  Notes: /notes to (the )?financial statements|financial statement notes/iu,
};
// Rationale/query language that signals a background search is not merely duplicating filed facts (recency, corroboration, or an explicit gap the filing does not cover).
const SEC_COVERAGE_ESCAPE_RE =
  /recent|latest|current|update|corroborat|verify|confirm|\bgap\b|not covered|uncovered|missing/iu;
const REUSED_PROFILE_TOPIC_PATTERNS: Readonly<Record<string, RegExp>> = {
  whatItDoes:
    /what (it|the company) does|business model|business overview|protocol overview|network overview|products? and services/iu,
  howItMakesMoney: /how it makes money|revenue model|revenue streams?|monetization/iu,
  customers: /customers?|customer base|end markets?/iu,
  geography: /geograph|regional mix|countries|international exposure/iu,
  purchaseRecurrence:
    /purchase recurrence|repeat purchases?|recurring purchases?|replacement cycle/iu,
  pricingPower: /pricing power|price increases?|pricing strategy/iu,
  recessionCyclicality: /recession|cyclicality|economic cycle|downturn/iu,
  managementTrackRecord: /management track record|leadership track record|executive team/iu,
  capitalAllocation: /capital allocation|buybacks?|dividends?|acquisitions?/iu,
  companyKpis: /company kpis?|key performance indicators?|operating metrics?/iu,
  riskFactors: /risk factors?|key risks?|business risks?/iu,
  valueAccrual: /value accrual|token value|value capture/iu,
  supplyIssuance: /token supply|issuance|emissions?|inflation schedule/iu,
  usageAdoption: /usage|adoption|active (users|addresses)|network activity/iu,
  governanceBuilders: /governance|developers?|builders?|contributors?/iu,
  competitionMoat: /competition|competitors?|moat|competitive advantage/iu,
  keyRisks: /key risks?|protocol risks?|network risks?/iu,
  whatItIs: /what it is|theme overview|definition|industry overview/iu,
  whyNow: /why now|theme drivers?|current tailwinds?/iu,
  beneficiaries: /beneficiar|companies? exposed|industry winners?/iu,
  headwinds: /headwinds?|barriers?|constraints?/iu,
  keyDebates: /key debates?|controvers|open questions?/iu,
  howItPlaysOut: /how it plays out|adoption path|scenario|outlook/iu,
};
export const COMMON_COMPANY_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "class",
  "ordinary",
  "shares",
]);
export const THEME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

// Derives which durable business-profile sections a company's SEC 10-K/10-Q packet already covers, from the section markers `secFilingSectionPacket` embeds in the packet snippet. Company subjects only; crypto/theme subjects and companies without a gathered packet return undefined, identical to today's behavior (no coverage signal, no rejections).
export function secFilingCoverageFromSources(
  subject: WebGatherSubject,
  extendedSources: readonly Source[],
): WebGatherContext["secFilingCoverage"] {
  if (subject.subjectKind !== "company") {
    return undefined;
  }
  const secSources = extendedSources.filter((source) => isCompanyProfileSecSource(source));
  if (secSources.length === 0) {
    return undefined;
  }
  const sections = new Set<string>();
  for (const source of secSources) {
    const snippet = source.snippet ?? "";
    for (const marker of SEC_FILING_SECTION_MARKERS) {
      if (snippet.includes(`[${marker}]`)) {
        sections.add(marker);
      }
    }
  }
  return { present: true, sections: [...sections].toSorted() };
}

// Rejects a background web_search that targets a durable-profile topic the SEC filing packet already covers and whose rationale gives no recency, corroboration, or explicit gap justification. Returns undefined (accept) for every other case, including when no coverage was derived, non-background searches, and off-topic background searches.
export function secCoverageRejectionReason(
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
  rationale: string,
  coverage: WebGatherContext["secFilingCoverage"],
): string | undefined {
  if (
    parsedArgs.searchType !== "background" ||
    coverage === undefined ||
    !coverage.present ||
    coverage.sections.length === 0
  ) {
    return undefined;
  }
  const targetsCoveredTopic = coverage.sections.some((section) =>
    SEC_COVERED_TOPIC_PATTERNS[section as keyof typeof SEC_COVERED_TOPIC_PATTERNS]?.test(
      parsedArgs.query,
    ),
  );
  if (!targetsCoveredTopic || SEC_COVERAGE_ESCAPE_RE.test(rationale)) {
    return undefined;
  }
  return "web_search duplicates SEC filing coverage (sec-covered-durable-profile); add a recency, corroboration, or explicit gap rationale for background queries";
}

export function reusedProfileCoverageRejectionReason(
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
  rationale: string,
  coverage: WebGatherContext["reusedProfileCoverage"],
): string | undefined {
  if (
    parsedArgs.searchType !== "background" ||
    coverage === undefined ||
    !coverage.present ||
    coverage.topics.length === 0 ||
    SEC_COVERAGE_ESCAPE_RE.test(rationale)
  ) {
    return undefined;
  }
  const targetsCoveredTopic = coverage.topics.some((topic) =>
    REUSED_PROFILE_TOPIC_PATTERNS[topic]?.test(parsedArgs.query),
  );
  return targetsCoveredTopic
    ? "web_search duplicates reused profile coverage (profile-covered-durable-topic); add a recency, corroboration, or explicit gap rationale for background queries"
    : undefined;
}

// Sets effective per-query ingestion when the model leaves numResults to the default. Thematic list screens widen one search surface because a later provider call can fail and leave the run with only one result page. Reused profiles stay narrow for the remaining recency/corroboration/gap-fill searches.
export function withDefaultSearchNumResults(
  parsedArgs: {
    readonly query: string;
    readonly searchType: WebSearchType;
    readonly numResults?: number;
  },
  command: ResearchCommand,
  coverage: WebGatherContext["reusedProfileCoverage"],
  acceptancePolicy: WebGatherAcceptancePolicy | undefined,
  thematicListSearchWidened: boolean,
): { readonly query: string; readonly searchType: WebSearchType; readonly numResults?: number } {
  if (parsedArgs.numResults !== undefined) {
    return parsedArgs;
  }
  if (!thematicListSearchWidened && isThematicListSearch(command, parsedArgs)) {
    return { ...parsedArgs, numResults: MAX_WEB_GATHER_SEARCH_RESULTS };
  }
  if (coverage?.present === true) {
    return {
      ...parsedArgs,
      numResults:
        acceptancePolicy?.implicitPerQueryAcceptanceCap ?? REUSED_PROFILE_DEFAULT_SEARCH_RESULTS,
    };
  }
  return parsedArgs;
}

export function isThematicListSearch(
  command: ResearchCommand,
  parsedArgs: { readonly query: string; readonly searchType: WebSearchType },
): boolean {
  if (
    command.jobType !== "research" ||
    command.assetClass !== "equity" ||
    parsedArgs.searchType !== "current-subject"
  ) {
    return false;
  }
  const text = `${command.subject} ${parsedArgs.query}`.toLowerCase();
  return /\b(top|best|list|ranking|ranked|screen|screening|picks?|promising|stocks? to buy)\b/u.test(
    text,
  );
}

export function normalizeTerm(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}
