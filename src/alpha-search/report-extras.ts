import type { YahooRejectedCandidate, YahooValidatedLead } from "./yahoo-validation";
import { isRecord, readNumber, readString, readStringArray } from "../sources/guards";

export interface AlphaSearchLead {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange: string;
  readonly price: number;
  readonly volume: number;
  readonly marketCap: number;
  readonly socialRank: number;
  readonly socialMomentumScore: number;
  readonly mentions: number;
  readonly upvotes: number;
  readonly sourceIds: readonly string[];
}

export interface AlphaSearchRejectedCandidate {
  readonly symbol: string;
  readonly socialRank: number;
  readonly socialMomentumScore: number;
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

export type AlphaSearchReportExtras = Readonly<Record<string, unknown>> & {
  readonly depth: string;
  readonly socialCandidateCount: number;
  readonly researchLeads: readonly AlphaSearchLead[];
  readonly rejectedCandidates: readonly AlphaSearchRejectedCandidate[];
};

export function leadSourceIds(
  lead: YahooValidatedLead,
  yahooSourceId: string | undefined,
): readonly string[] {
  return yahooSourceId === undefined
    ? lead.candidate.sourceIds
    : [...lead.candidate.sourceIds, yahooSourceId];
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
    socialRank: lead.candidate.socialRank,
    socialMomentumScore: lead.candidate.socialMomentumScore,
    mentions: lead.candidate.mentions,
    upvotes: lead.candidate.upvotes,
    sourceIds: leadSourceIds(lead, yahooSourceId),
  };
}

export function alphaSearchRejectedCandidate(
  rejected: YahooRejectedCandidate,
): AlphaSearchRejectedCandidate {
  return {
    symbol: rejected.candidate.symbol,
    socialRank: rejected.candidate.socialRank,
    socialMomentumScore: rejected.candidate.socialMomentumScore,
    reason: rejected.reason,
    sourceIds: rejected.candidate.sourceIds,
  };
}

function hasValidOptionalAlphaSearchLeadFields(value: Record<string, unknown>): boolean {
  return (
    (value.name === undefined || typeof value.name === "string") &&
    typeof value.exchange === "string" &&
    typeof value.marketCap === "number" &&
    Number.isFinite(value.marketCap)
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
    readNumber(value, "socialRank") !== undefined &&
    readNumber(value, "socialMomentumScore") !== undefined &&
    readNumber(value, "mentions") !== undefined &&
    readNumber(value, "upvotes") !== undefined &&
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
    readNumber(value, "socialRank") !== undefined &&
    readNumber(value, "socialMomentumScore") !== undefined &&
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

export function readAlphaSearchRejectedCandidates(
  extras: Record<string, unknown> | undefined,
): readonly AlphaSearchRejectedCandidate[] {
  const rejected = extras?.rejectedCandidates;
  return Array.isArray(rejected)
    ? rejected.filter((candidate) => isAlphaSearchRejectedCandidate(candidate))
    : [];
}
