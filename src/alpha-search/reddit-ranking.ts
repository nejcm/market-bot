import type { RedditDiscussionComment, RedditDiscussionPost } from "../sources/reddit";

const MENTION_WEIGHT = 30;
const ENGAGEMENT_WEIGHT = 25;
const PARTICIPANT_WEIGHT = 20;
const STANCE_WEIGHT = 15;
const RECENCY_WEIGHT = 10;
const MS_PER_DAY = 86_400_000;

const CASH_TAG_RE = /\$([A-Za-z][A-Za-z0-9]{0,4})(?=\b)/gu;
const BARE_TICKER_RE = /(?<![A-Z0-9$])[A-Z]{2,5}(?![A-Z0-9])/gu;
const STOP_WORDS = new Set([
  "ATH",
  "CEO",
  "CFO",
  "EPS",
  "ETF",
  "FED",
  "GDP",
  "IMO",
  "IPO",
  "LOL",
  "NYSE",
  "SEC",
  "THE",
  "USA",
  "USD",
  "YOY",
]);
const CONSTRUCTIVE_TERMS = [
  "beat",
  "breakout",
  "constructive",
  "growth",
  "profitable",
  "strong",
  "undervalued",
  "upgrade",
];
const SKEPTICAL_TERMS = [
  "bearish",
  "decline",
  "dilution",
  "downgrade",
  "lawsuit",
  "miss",
  "overvalued",
  "risk",
  "scam",
  "skeptical",
  "weak",
];
const WORD_CHAR_RE = /[a-z0-9_]/u;

export type DiscussionStance = "constructive" | "skeptical" | "mixed" | "unclear";

export interface RedditCandidateRankInput {
  readonly posts: readonly RedditDiscussionPost[];
  readonly comments: readonly RedditDiscussionComment[];
  readonly fetchedAt: string;
  readonly lookbackDays: number;
  readonly candidateLimit: number;
}

export interface RedditRankedCandidate {
  readonly rank: number;
  readonly symbol: string;
  readonly redditDiscoveryScore: number;
  readonly mentionCount: number;
  readonly mentionVelocity: number;
  readonly engagementScore: number;
  readonly uniqueParticipantCount: number;
  readonly discussionStance: DiscussionStance;
  readonly recencyScore: number;
  readonly sourceIds: readonly string[];
}

interface DiscussionItem {
  readonly text: string;
  readonly sourceId: string;
  readonly author: string;
  readonly createdAt: string;
  readonly engagement: number;
}

interface TickerMention {
  readonly symbol: string;
  readonly index: number;
}

interface CandidateAccumulator {
  readonly symbol: string;
  mentionCount: number;
  engagementScore: number;
  stanceConstructive: number;
  stanceSkeptical: number;
  recencyTotal: number;
  readonly participants: Set<string>;
  readonly sourceIds: Set<string>;
}

function discussionItems(input: RedditCandidateRankInput): readonly DiscussionItem[] {
  return [
    ...input.posts.map((post) => ({
      text: `${post.title} ${post.selfText}`,
      sourceId: post.fullname,
      author: post.author,
      createdAt: post.createdAt,
      engagement: Math.max(0, post.score) + Math.max(0, post.commentCount),
    })),
    ...input.comments.map((comment) => ({
      text: comment.body,
      sourceId: comment.fullname,
      author: comment.author,
      createdAt: comment.createdAt,
      engagement: Math.max(0, comment.score),
    })),
  ];
}

function extractTickerMentions(text: string): readonly TickerMention[] {
  const cashtags = [...text.matchAll(CASH_TAG_RE)].flatMap((match) => {
    const [, value] = match;
    return value === undefined || match.index === undefined
      ? []
      : [{ symbol: value.toUpperCase(), index: match.index }];
  });
  const bareTickers = [...text.matchAll(BARE_TICKER_RE)]
    .map((match) => ({ symbol: match[0], index: match.index }))
    .filter((mention) => mention.index !== undefined && !STOP_WORDS.has(mention.symbol));

  return [...cashtags, ...bareTickers];
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && WORD_CHAR_RE.test(value);
}

function termIndexes(lowerText: string, term: string): readonly number[] {
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex < lowerText.length) {
    const index = lowerText.indexOf(term, fromIndex);
    if (index === -1) {
      return indexes;
    }
    const before = lowerText[index - 1];
    const after = lowerText[index + term.length];
    if (!isWordChar(before) && !isWordChar(after)) {
      indexes.push(index);
    }
    fromIndex = index + term.length;
  }
  return indexes;
}

function nearestMention(
  mentions: readonly TickerMention[],
  termIndex: number,
): TickerMention | undefined {
  const nearest = mentions.reduce<{
    readonly mention?: TickerMention;
    readonly distance: number;
    readonly tied: boolean;
  }>(
    (best, mention) => {
      const distance = Math.abs(mention.index + mention.symbol.length / 2 - termIndex);
      if (distance < best.distance) {
        return { mention, distance, tied: false };
      }
      if (distance === best.distance) {
        return { ...best, tied: true };
      }
      return best;
    },
    { distance: Number.POSITIVE_INFINITY, tied: false },
  );
  return nearest.tied ? undefined : nearest.mention;
}

function countTermsForSymbol(
  text: string,
  mentions: readonly TickerMention[],
  symbol: string,
  terms: readonly string[],
): number {
  const lowerText = text.toLowerCase();
  return terms
    .flatMap((term) => termIndexes(lowerText, term))
    .filter((termIndex) => nearestMention(mentions, termIndex)?.symbol === symbol).length;
}

function discussionStance(constructiveCount: number, skepticalCount: number): DiscussionStance {
  if (constructiveCount > 0 && skepticalCount > 0) {
    return "mixed";
  }
  if (constructiveCount > 0) {
    return "constructive";
  }
  if (skepticalCount > 0) {
    return "skeptical";
  }
  return "unclear";
}

function stanceScore(stance: DiscussionStance): number {
  if (stance === "constructive") {
    return 1;
  }
  if (stance === "mixed") {
    return 0.6;
  }
  if (stance === "skeptical") {
    return 0.3;
  }
  return 0.4;
}

function recencyValue(createdAt: string, fetchedAt: string, lookbackDays: number): number {
  const ageMs = new Date(fetchedAt).getTime() - new Date(createdAt).getTime();
  const lookbackMs = Math.max(1, lookbackDays) * MS_PER_DAY;
  if (!Number.isFinite(ageMs)) {
    return 0;
  }
  return Math.max(0, Math.min(1, 1 - ageMs / lookbackMs));
}

function accumulatorFor(symbol: string): CandidateAccumulator {
  return {
    symbol,
    mentionCount: 0,
    engagementScore: 0,
    stanceConstructive: 0,
    stanceSkeptical: 0,
    recencyTotal: 0,
    participants: new Set(),
    sourceIds: new Set(),
  };
}

function scoreCandidate(input: {
  readonly candidate: CandidateAccumulator;
  readonly maxMentionVelocity: number;
  readonly maxEngagementScore: number;
  readonly maxUniqueParticipantCount: number;
  readonly lookbackDays: number;
}): Omit<RedditRankedCandidate, "rank"> {
  const { candidate } = input;
  const mentionVelocity = candidate.mentionCount / Math.max(1, input.lookbackDays);
  const mentionComponent =
    input.maxMentionVelocity === 0 ? 0 : mentionVelocity / input.maxMentionVelocity;
  const engagementComponent =
    input.maxEngagementScore === 0 ? 0 : candidate.engagementScore / input.maxEngagementScore;
  const uniqueParticipantCount = candidate.participants.size;
  const participantComponent =
    input.maxUniqueParticipantCount === 0
      ? 0
      : uniqueParticipantCount / input.maxUniqueParticipantCount;
  const stance = discussionStance(candidate.stanceConstructive, candidate.stanceSkeptical);
  const recencyScore =
    candidate.mentionCount === 0 ? 0 : candidate.recencyTotal / candidate.mentionCount;
  const score =
    mentionComponent * MENTION_WEIGHT +
    engagementComponent * ENGAGEMENT_WEIGHT +
    participantComponent * PARTICIPANT_WEIGHT +
    stanceScore(stance) * STANCE_WEIGHT +
    recencyScore * RECENCY_WEIGHT;

  return {
    symbol: candidate.symbol,
    redditDiscoveryScore: Math.round(score * 100) / 100,
    mentionCount: candidate.mentionCount,
    mentionVelocity: Math.round(mentionVelocity * 100) / 100,
    engagementScore: candidate.engagementScore,
    uniqueParticipantCount,
    discussionStance: stance,
    recencyScore: Math.round(recencyScore * 100) / 100,
    sourceIds: [...candidate.sourceIds],
  };
}

export function rankRedditCandidates(
  input: RedditCandidateRankInput,
): readonly RedditRankedCandidate[] {
  if (input.candidateLimit <= 0) {
    return [];
  }

  const candidates = new Map<string, CandidateAccumulator>();
  for (const item of discussionItems(input)) {
    const mentions = extractTickerMentions(item.text);
    if (mentions.length === 0) {
      continue;
    }

    const symbolsInSource = new Set(mentions.map((mention) => mention.symbol));
    for (const symbol of symbolsInSource) {
      const candidate = candidates.get(symbol) ?? accumulatorFor(symbol);
      const symbolMentions = mentions.filter((mention) => mention.symbol === symbol);
      const mentionCount = symbolMentions.length;
      candidate.mentionCount += mentionCount;
      candidate.engagementScore += item.engagement;
      candidate.stanceConstructive += countTermsForSymbol(
        item.text,
        mentions,
        symbol,
        CONSTRUCTIVE_TERMS,
      );
      candidate.stanceSkeptical += countTermsForSymbol(
        item.text,
        mentions,
        symbol,
        SKEPTICAL_TERMS,
      );
      candidate.recencyTotal +=
        recencyValue(item.createdAt, input.fetchedAt, input.lookbackDays) * mentionCount;
      candidate.participants.add(item.author);
      candidate.sourceIds.add(item.sourceId);
      candidates.set(symbol, candidate);
    }
  }

  const accumulated = [...candidates.values()];
  const maxMentionVelocity = Math.max(
    0,
    ...accumulated.map((candidate) => candidate.mentionCount / Math.max(1, input.lookbackDays)),
  );
  const maxEngagementScore = Math.max(
    0,
    ...accumulated.map((candidate) => candidate.engagementScore),
  );
  const maxUniqueParticipantCount = Math.max(
    0,
    ...accumulated.map((candidate) => candidate.participants.size),
  );

  return accumulated
    .map((candidate) =>
      scoreCandidate({
        candidate,
        maxMentionVelocity,
        maxEngagementScore,
        maxUniqueParticipantCount,
        lookbackDays: input.lookbackDays,
      }),
    )
    .toSorted(
      (left, right) =>
        right.redditDiscoveryScore - left.redditDiscoveryScore ||
        right.mentionCount - left.mentionCount ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, input.candidateLimit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
