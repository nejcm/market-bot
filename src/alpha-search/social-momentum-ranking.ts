import type { ApeWisdomCandidate } from "../sources/apewisdom";

const MENTION_GROWTH_WEIGHT = 40;
const RANK_IMPROVEMENT_WEIGHT = 25;
const CURRENT_MENTIONS_WEIGHT = 20;
const UPVOTES_PER_MENTION_WEIGHT = 15;

export const UPVOTE_RATIO_SHRINKAGE_K = 5;

export type SocialScoringVersion = 1 | 2;

export const CURRENT_SOCIAL_SCORING_VERSION = 2 as const satisfies SocialScoringVersion;

export function isSocialScoringVersion(value: unknown): value is SocialScoringVersion {
  return value === 1 || value === 2;
}

export interface SocialMomentumRankInput {
  readonly candidates: readonly ApeWisdomCandidate[];
  readonly candidateLimit: number;
}

export interface SocialMomentumRankedCandidate {
  readonly socialRank: number;
  readonly socialScoringVersion: SocialScoringVersion;
  readonly symbol: string;
  readonly name: string;
  readonly sourceProvider: "apewisdom";
  readonly sourceIds: readonly string[];
  readonly socialMomentumScore: number;
  readonly mentions: number;
  readonly upvotes: number;
  readonly rank24hAgo?: number;
  readonly mentions24hAgo?: number;
}

interface CandidateFeatures {
  readonly candidate: ApeWisdomCandidate;
  readonly mentionGrowth: number;
  readonly rankImprovement: number;
  readonly currentMentions: number;
  readonly upvotesPerMention: number;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalize(value: number, maxValue: number): number {
  return maxValue === 0 ? 0 : value / maxValue;
}

function featuresFor(candidate: ApeWisdomCandidate): CandidateFeatures {
  return {
    candidate,
    mentionGrowth:
      candidate.mentions24hAgo === undefined
        ? 0
        : Math.max(0, candidate.mentions - candidate.mentions24hAgo),
    rankImprovement:
      candidate.rank24hAgo === undefined ? 0 : Math.max(0, candidate.rank24hAgo - candidate.rank),
    currentMentions: candidate.mentions,
    upvotesPerMention:
      (candidate.upvotes / Math.max(1, candidate.mentions)) *
      (candidate.mentions / (candidate.mentions + UPVOTE_RATIO_SHRINKAGE_K)),
  };
}

function compareRawCandidates(left: ApeWisdomCandidate, right: ApeWisdomCandidate): number {
  return (
    right.mentions - left.mentions ||
    right.upvotes - left.upvotes ||
    left.rank - right.rank ||
    left.ticker.localeCompare(right.ticker)
  );
}

function dedupeCandidates(
  candidates: readonly ApeWisdomCandidate[],
): readonly ApeWisdomCandidate[] {
  const byTicker = new Map<string, ApeWisdomCandidate>();
  for (const candidate of candidates) {
    const existing = byTicker.get(candidate.ticker);
    if (existing === undefined || compareRawCandidates(candidate, existing) < 0) {
      byTicker.set(candidate.ticker, candidate);
    }
  }
  return [...byTicker.values()];
}

function scoreCandidate(
  features: CandidateFeatures,
  maxValues: {
    readonly mentionGrowth: number;
    readonly rankImprovement: number;
    readonly currentMentions: number;
    readonly upvotesPerMention: number;
  },
): Omit<SocialMomentumRankedCandidate, "socialRank"> {
  const { candidate } = features;
  const score =
    normalize(features.mentionGrowth, maxValues.mentionGrowth) * MENTION_GROWTH_WEIGHT +
    normalize(features.rankImprovement, maxValues.rankImprovement) * RANK_IMPROVEMENT_WEIGHT +
    normalize(features.currentMentions, maxValues.currentMentions) * CURRENT_MENTIONS_WEIGHT +
    normalize(features.upvotesPerMention, maxValues.upvotesPerMention) * UPVOTES_PER_MENTION_WEIGHT;

  return {
    socialScoringVersion: CURRENT_SOCIAL_SCORING_VERSION,
    symbol: candidate.ticker,
    name: candidate.name,
    sourceProvider: "apewisdom",
    sourceIds: [candidate.sourceId],
    socialMomentumScore: roundScore(score),
    mentions: candidate.mentions,
    upvotes: candidate.upvotes,
    ...(candidate.rank24hAgo !== undefined ? { rank24hAgo: candidate.rank24hAgo } : {}),
    ...(candidate.mentions24hAgo !== undefined ? { mentions24hAgo: candidate.mentions24hAgo } : {}),
  };
}

export function rankSocialMomentumCandidates(
  input: SocialMomentumRankInput,
): readonly SocialMomentumRankedCandidate[] {
  if (input.candidateLimit <= 0) {
    return [];
  }

  const features = dedupeCandidates(input.candidates).map((candidate) => featuresFor(candidate));
  const maxValues = {
    mentionGrowth: Math.max(0, ...features.map((entry) => entry.mentionGrowth)),
    rankImprovement: Math.max(0, ...features.map((entry) => entry.rankImprovement)),
    currentMentions: Math.max(0, ...features.map((entry) => entry.currentMentions)),
    upvotesPerMention: Math.max(0, ...features.map((entry) => entry.upvotesPerMention)),
  };

  return features
    .map((entry) => scoreCandidate(entry, maxValues))
    .toSorted(
      (left, right) =>
        right.socialMomentumScore - left.socialMomentumScore ||
        right.mentions - left.mentions ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, input.candidateLimit)
    .map((candidate, index) => ({ ...candidate, socialRank: index + 1 }));
}
