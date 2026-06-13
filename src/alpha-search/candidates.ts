import type { SocialMomentumRankedCandidate } from "./social-momentum-ranking";

export type AlphaSearchDiscoverySource = "apewisdom" | "sec-filings";

export interface AlphaSearchSecFiling {
  readonly form: string;
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber?: string;
  readonly sourceIds: readonly string[];
}

export interface AlphaSearchCandidate {
  readonly symbol: string;
  readonly name?: string;
  readonly sourceIds: readonly string[];
  readonly discoverySources: readonly AlphaSearchDiscoverySource[];
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly mentions?: number;
  readonly upvotes?: number;
  readonly rank24hAgo?: number;
  readonly mentions24hAgo?: number;
  readonly secCik?: string;
  readonly secCompanyName?: string;
  readonly recentSecFilings?: readonly AlphaSearchSecFiling[];
}

export function socialAlphaSearchCandidate(
  candidate: SocialMomentumRankedCandidate,
): AlphaSearchCandidate {
  return {
    symbol: candidate.symbol,
    name: candidate.name,
    sourceIds: candidate.sourceIds,
    discoverySources: ["apewisdom"],
    socialRank: candidate.socialRank,
    socialMomentumScore: candidate.socialMomentumScore,
    mentions: candidate.mentions,
    upvotes: candidate.upvotes,
    ...(candidate.rank24hAgo !== undefined ? { rank24hAgo: candidate.rank24hAgo } : {}),
    ...(candidate.mentions24hAgo !== undefined ? { mentions24hAgo: candidate.mentions24hAgo } : {}),
  };
}

function mergeDiscoverySources(
  left: readonly AlphaSearchDiscoverySource[],
  right: readonly AlphaSearchDiscoverySource[],
): readonly AlphaSearchDiscoverySource[] {
  return [...new Set([...left, ...right])];
}

function mergeSourceIds(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function mergeSecFilings(
  left: readonly AlphaSearchSecFiling[] | undefined,
  right: readonly AlphaSearchSecFiling[] | undefined,
): readonly AlphaSearchSecFiling[] | undefined {
  const filings = [...(left ?? []), ...(right ?? [])];
  if (filings.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  return filings.filter((filing) => {
    const key = `${filing.form}:${filing.filingDate}:${filing.accessionNumber ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mergeAlphaSearchCandidates(
  candidates: readonly AlphaSearchCandidate[],
): readonly AlphaSearchCandidate[] {
  const merged = new Map<string, AlphaSearchCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.symbol);
    if (existing === undefined) {
      merged.set(candidate.symbol, candidate);
      continue;
    }
    const recentSecFilings = mergeSecFilings(existing.recentSecFilings, candidate.recentSecFilings);
    merged.set(candidate.symbol, {
      ...candidate,
      ...existing,
      sourceIds: mergeSourceIds(existing.sourceIds, candidate.sourceIds),
      discoverySources: mergeDiscoverySources(
        existing.discoverySources,
        candidate.discoverySources,
      ),
      ...(candidate.secCik !== undefined ? { secCik: candidate.secCik } : {}),
      ...(candidate.secCompanyName !== undefined
        ? { secCompanyName: candidate.secCompanyName }
        : {}),
      ...(recentSecFilings !== undefined ? { recentSecFilings } : {}),
    });
  }
  return [...merged.values()];
}
