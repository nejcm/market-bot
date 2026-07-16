import type { YahooRejectedCandidate, YahooValidatedLead } from "./yahoo-validation";
import { isRecord, readNumber, readString, readStringArray } from "../guards";
import type { AlphaSearchDiscoverySource, AlphaSearchSecFiling } from "./candidates";
import { socialMomentumBaseSourceId, socialMomentumReportSourceId } from "./source-ids";

export interface AlphaSearchLead {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange: string;
  readonly price: number;
  readonly volume: number;
  readonly marketCap: number;
  readonly discoverySources: readonly AlphaSearchDiscoverySource[];
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly mentions?: number;
  readonly upvotes?: number;
  readonly rank24hAgo?: number;
  readonly mentions24hAgo?: number;
  readonly mentionDelta24h?: number;
  readonly rankImprovement?: number;
  readonly upvotesPerMention?: number;
  readonly secCik?: string;
  readonly secCompanyName?: string;
  readonly recentSecFilings?: readonly AlphaSearchSecFiling[];
  readonly sourceIds: readonly string[];
}

export interface AlphaSearchRejectedCandidate {
  readonly symbol: string;
  readonly discoverySources: readonly AlphaSearchDiscoverySource[];
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly reason: string;
  readonly secCik?: string;
  readonly secCompanyName?: string;
  readonly sourceIds: readonly string[];
}

export type AlphaSearchReportExtras = Readonly<Record<string, unknown>> & {
  readonly depth: string;
  readonly socialCandidateCount: number;
  readonly researchLeads: readonly AlphaSearchLead[];
  readonly leadDisplayLimit?: number;
  readonly rejectedCandidates: readonly AlphaSearchRejectedCandidate[];
  readonly profileCoverage?: AlphaSearchProfileCoverage;
};

export interface AlphaSearchProfileCoverage {
  readonly displayedLeadCount: number;
  readonly candidateProfilesWithFundamentals: number;
  readonly fundamentalGapCount: number;
  readonly unmappedSecFilingCount: number;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function leadSourceIds(
  lead: YahooValidatedLead,
  yahooSourceId: string | undefined,
): readonly string[] {
  const sourceIds = reportCandidateSourceIds(lead.candidate);
  return yahooSourceId === undefined ? sourceIds : [...new Set([...sourceIds, yahooSourceId])];
}

export function alphaSearchLead(
  lead: YahooValidatedLead,
  yahooSourceId: string | undefined,
): AlphaSearchLead {
  return {
    symbol: lead.symbol,
    ...(lead.name !== undefined ? { name: lead.name } : {}),
    exchange: lead.exchange,
    price: lead.price,
    volume: lead.volume,
    marketCap: lead.marketCap,
    discoverySources: lead.candidate.discoverySources,
    ...(lead.candidate.socialRank !== undefined ? { socialRank: lead.candidate.socialRank } : {}),
    ...(lead.candidate.socialMomentumScore !== undefined
      ? { socialMomentumScore: lead.candidate.socialMomentumScore }
      : {}),
    ...(lead.candidate.mentions !== undefined ? { mentions: lead.candidate.mentions } : {}),
    ...(lead.candidate.upvotes !== undefined ? { upvotes: lead.candidate.upvotes } : {}),
    ...(lead.candidate.rank24hAgo !== undefined ? { rank24hAgo: lead.candidate.rank24hAgo } : {}),
    ...(lead.candidate.mentions24hAgo !== undefined
      ? { mentions24hAgo: lead.candidate.mentions24hAgo }
      : {}),
    ...(lead.candidate.mentions24hAgo !== undefined && lead.candidate.mentions !== undefined
      ? { mentionDelta24h: lead.candidate.mentions - lead.candidate.mentions24hAgo }
      : {}),
    ...(lead.candidate.rank24hAgo !== undefined && lead.candidate.socialRank !== undefined
      ? { rankImprovement: Math.max(0, lead.candidate.rank24hAgo - lead.candidate.socialRank) }
      : {}),
    ...(lead.candidate.upvotes !== undefined && lead.candidate.mentions !== undefined
      ? {
          upvotesPerMention: rounded(lead.candidate.upvotes / Math.max(1, lead.candidate.mentions)),
        }
      : {}),
    ...(lead.candidate.secCik !== undefined ? { secCik: lead.candidate.secCik } : {}),
    ...(lead.candidate.secCompanyName !== undefined
      ? { secCompanyName: lead.candidate.secCompanyName }
      : {}),
    ...(lead.candidate.recentSecFilings !== undefined
      ? { recentSecFilings: lead.candidate.recentSecFilings }
      : {}),
    sourceIds: leadSourceIds(lead, yahooSourceId),
  };
}

export function alphaSearchRejectedCandidate(
  rejected: YahooRejectedCandidate,
): AlphaSearchRejectedCandidate {
  return {
    symbol: rejected.candidate.symbol,
    discoverySources: rejected.candidate.discoverySources,
    ...(rejected.candidate.socialRank !== undefined
      ? { socialRank: rejected.candidate.socialRank }
      : {}),
    ...(rejected.candidate.socialMomentumScore !== undefined
      ? { socialMomentumScore: rejected.candidate.socialMomentumScore }
      : {}),
    reason: rejected.reason,
    ...(rejected.candidate.secCik !== undefined ? { secCik: rejected.candidate.secCik } : {}),
    ...(rejected.candidate.secCompanyName !== undefined
      ? { secCompanyName: rejected.candidate.secCompanyName }
      : {}),
    sourceIds: reportCandidateSourceIds(rejected.candidate),
  };
}

function reportCandidateSourceIds(candidate: {
  readonly symbol: string;
  readonly socialRank?: number;
  readonly sourceIds: readonly string[];
}): readonly string[] {
  if (candidate.socialRank === undefined) {
    return candidate.sourceIds;
  }
  const socialSourceId = socialMomentumBaseSourceId(candidate);
  const additionalSourceIds = candidate.sourceIds.filter((sourceId) => sourceId !== socialSourceId);
  return [
    ...new Set([
      socialMomentumReportSourceId({
        symbol: candidate.symbol,
        socialRank: candidate.socialRank,
        sourceIds: candidate.sourceIds,
      }),
      ...additionalSourceIds,
    ]),
  ];
}

function hasValidOptionalAlphaSearchLeadFields(value: Record<string, unknown>): boolean {
  return (
    (value.name === undefined || typeof value.name === "string") &&
    typeof value.exchange === "string" &&
    typeof value.marketCap === "number" &&
    Number.isFinite(value.marketCap) &&
    (value.socialRank === undefined || readNumber(value, "socialRank") !== undefined) &&
    (value.socialMomentumScore === undefined ||
      readNumber(value, "socialMomentumScore") !== undefined) &&
    (value.mentions === undefined || readNumber(value, "mentions") !== undefined) &&
    (value.upvotes === undefined || readNumber(value, "upvotes") !== undefined) &&
    (value.rank24hAgo === undefined || readNumber(value, "rank24hAgo") !== undefined) &&
    (value.mentions24hAgo === undefined || readNumber(value, "mentions24hAgo") !== undefined) &&
    (value.mentionDelta24h === undefined || readNumber(value, "mentionDelta24h") !== undefined) &&
    (value.rankImprovement === undefined || readNumber(value, "rankImprovement") !== undefined) &&
    (value.upvotesPerMention === undefined ||
      readNumber(value, "upvotesPerMention") !== undefined) &&
    (value.secCik === undefined || typeof value.secCik === "string") &&
    (value.secCompanyName === undefined || typeof value.secCompanyName === "string") &&
    (value.recentSecFilings === undefined || Array.isArray(value.recentSecFilings))
  );
}

export function isAlphaSearchLead(value: unknown): value is AlphaSearchLead {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasValidOptionalAlphaSearchLeadFields(value) &&
    readString(value, "symbol") !== undefined &&
    readNumber(value, "price") !== undefined &&
    readNumber(value, "volume") !== undefined &&
    readStringArray(value, "discoverySources") !== undefined &&
    readStringArray(value, "sourceIds") !== undefined
  );
}

export function isAlphaSearchRejectedCandidate(
  value: unknown,
): value is AlphaSearchRejectedCandidate {
  if (!isRecord(value)) {
    return false;
  }

  return (
    readString(value, "symbol") !== undefined &&
    (value.socialRank === undefined || readNumber(value, "socialRank") !== undefined) &&
    (value.socialMomentumScore === undefined ||
      readNumber(value, "socialMomentumScore") !== undefined) &&
    readStringArray(value, "discoverySources") !== undefined &&
    readString(value, "reason") !== undefined &&
    readStringArray(value, "sourceIds") !== undefined
  );
}

export function readAlphaSearchLeads(
  extras: Record<string, unknown> | undefined,
): readonly AlphaSearchLead[] {
  const leads = extras?.researchLeads;
  return Array.isArray(leads) ? leads.filter((lead) => isAlphaSearchLead(lead)) : [];
}

export function readAlphaSearchLeadDisplayLimit(
  extras: Record<string, unknown> | undefined,
): number | undefined {
  return extras === undefined ? undefined : readNumber(extras, "leadDisplayLimit");
}

export function readAlphaSearchRejectedCandidates(
  extras: Record<string, unknown> | undefined,
): readonly AlphaSearchRejectedCandidate[] {
  const rejected = extras?.rejectedCandidates;
  return Array.isArray(rejected)
    ? rejected.filter((candidate) => isAlphaSearchRejectedCandidate(candidate))
    : [];
}

export function readAlphaSearchProfileCoverage(
  extras: Record<string, unknown> | undefined,
): AlphaSearchProfileCoverage | undefined {
  const coverage = extras?.profileCoverage;
  if (!isRecord(coverage)) {
    return undefined;
  }
  const displayedLeadCount = readNumber(coverage, "displayedLeadCount");
  const candidateProfilesWithFundamentals = readNumber(
    coverage,
    "candidateProfilesWithFundamentals",
  );
  const fundamentalGapCount = readNumber(coverage, "fundamentalGapCount");
  const unmappedSecFilingCount = readNumber(coverage, "unmappedSecFilingCount");
  if (
    displayedLeadCount === undefined ||
    candidateProfilesWithFundamentals === undefined ||
    fundamentalGapCount === undefined ||
    unmappedSecFilingCount === undefined
  ) {
    return undefined;
  }
  return {
    displayedLeadCount,
    candidateProfilesWithFundamentals,
    fundamentalGapCount,
    unmappedSecFilingCount,
  };
}
