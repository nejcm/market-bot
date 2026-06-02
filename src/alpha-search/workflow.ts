import { join } from "node:path";
import {
  createRunId,
  prepareRunArtifacts,
  writeJson,
  writeRunOutputs,
  type RunArtifacts,
} from "../artifacts";
import type { AlphaSearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { KeyFinding, ResearchReport, RunTrace, Source, SourceGap } from "../domain/types";
import { renderMarkdownReport } from "../report/markdown";
import { validateResearchReport } from "../report/schema";
import { createSourceRequestContext, DEFAULT_RETRY_DELAYS_MS } from "../sources/collector";
import {
  collectRedditDiscussions,
  type RedditDiscussionComment,
  type RedditDiscussionPost,
} from "../sources/reddit";
import type { FetchLike, RawSourceSnapshot } from "../sources/types";
import { rankRedditCandidates, type RedditRankedCandidate } from "./reddit-ranking";
import { readRedditSeenIds, recordRedditSeenPosts } from "./reddit-seen";
import { redactExpiredRedditRawSnapshots } from "./raw-retention";
import {
  crossCheckRedditCandidatesWithYahoo,
  type YahooRejectedCandidate,
  type YahooValidatedLead,
} from "./yahoo-validation";

export interface AlphaSearchWorkflowResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly artifacts: RunArtifacts;
}

function commentDepth(command: AlphaSearchCommand): number {
  return command.depth === "deep" ? 3 : 1;
}

function redditPostSource(post: RedditDiscussionPost): Source {
  return {
    id: post.fullname,
    title: `r/${post.subreddit}: ${post.title}`,
    url: post.permalink,
    publisher: "reddit",
    fetchedAt: post.createdAt,
    kind: "discussion",
    assetClass: "equity",
    provider: "reddit",
    rawRef: post.fullname,
  };
}

function redditCommentSource(comment: RedditDiscussionComment): Source {
  return {
    id: comment.fullname,
    title: `r/${comment.subreddit} comment ${comment.id}`,
    publisher: "reddit",
    fetchedAt: comment.createdAt,
    kind: "discussion",
    assetClass: "equity",
    provider: "reddit",
    rawRef: comment.fullname,
  };
}

function yahooValidationSource(fetchedAt: string): Source {
  return {
    id: "market-yahoo-alpha-search",
    title: "Yahoo quote validation for Reddit alpha-search candidates",
    fetchedAt,
    kind: "market-data",
    assetClass: "equity",
    provider: "yahoo",
  };
}

function sourceList(input: {
  readonly posts: readonly RedditDiscussionPost[];
  readonly comments: readonly RedditDiscussionComment[];
  readonly yahooRawSnapshots: readonly RawSourceSnapshot[];
  readonly fetchedAt: string;
}): readonly Source[] {
  return [
    ...input.posts.map(redditPostSource),
    ...input.comments.map(redditCommentSource),
    ...(input.yahooRawSnapshots.length > 0 ? [yahooValidationSource(input.fetchedAt)] : []),
  ];
}

function leadSourceIds(
  lead: YahooValidatedLead,
  yahooSourceId: string | undefined,
): readonly string[] {
  return yahooSourceId === undefined
    ? lead.candidate.sourceIds
    : [...lead.candidate.sourceIds, yahooSourceId];
}

function leadFinding(lead: YahooValidatedLead, yahooSourceId: string | undefined): KeyFinding {
  const name = lead.name === undefined ? lead.symbol : `${lead.symbol} (${lead.name})`;
  const exchange = lead.exchange === undefined ? "" : ` on ${lead.exchange}`;
  return {
    text: `${name} ranked ${String(lead.candidate.rank)} by Reddit Discovery Score with ${String(lead.candidate.mentionCount)} mention(s) and ${lead.candidate.discussionStance} stance; Yahoo resolved it as a ${lead.instrumentKind}${exchange}.`,
    sourceIds: leadSourceIds(lead, yahooSourceId),
  };
}

function dataGaps(input: {
  readonly sourceGaps: readonly SourceGap[];
  readonly rankedCandidates: readonly RedditRankedCandidate[];
  readonly validLeads: readonly YahooValidatedLead[];
}): readonly string[] {
  return [
    ...input.sourceGaps.map((gap) => gap.message),
    ...(input.rankedCandidates.length === 0
      ? ["No Reddit-ranked equity candidates were found in the configured lookback window"]
      : []),
    ...(input.rankedCandidates.length > 0 && input.validLeads.length === 0
      ? ["No Reddit-ranked candidates passed Yahoo validation"]
      : []),
  ];
}

function reportLead(
  lead: YahooValidatedLead,
  yahooSourceId: string | undefined,
): Record<string, unknown> {
  return {
    symbol: lead.symbol,
    ...(lead.name !== undefined ? { name: lead.name } : {}),
    ...(lead.exchange !== undefined ? { exchange: lead.exchange } : {}),
    price: lead.price,
    volume: lead.volume,
    ...(lead.marketCap !== undefined ? { marketCap: lead.marketCap } : {}),
    instrumentKind: lead.instrumentKind,
    redditRank: lead.candidate.rank,
    redditDiscoveryScore: lead.candidate.redditDiscoveryScore,
    mentionCount: lead.candidate.mentionCount,
    discussionStance: lead.candidate.discussionStance,
    sourceIds: leadSourceIds(lead, yahooSourceId),
  };
}

function rejectedCandidate(rejected: YahooRejectedCandidate): Record<string, unknown> {
  return {
    symbol: rejected.candidate.symbol,
    redditRank: rejected.candidate.rank,
    redditDiscoveryScore: rejected.candidate.redditDiscoveryScore,
    reason: rejected.reason,
    sourceIds: rejected.candidate.sourceIds,
  };
}

function buildAlphaSearchReport(input: {
  readonly runId: string;
  readonly command: AlphaSearchCommand;
  readonly generatedAt: string;
  readonly rankedCandidates: readonly RedditRankedCandidate[];
  readonly validLeads: readonly YahooValidatedLead[];
  readonly rejectedCandidates: readonly YahooRejectedCandidate[];
  readonly sourceGaps: readonly SourceGap[];
  readonly sources: readonly Source[];
}): ResearchReport {
  const yahooSourceId = input.sources.find((source) => source.provider === "yahoo")?.id;
  const gaps = dataGaps({
    sourceGaps: input.sourceGaps,
    rankedCandidates: input.rankedCandidates,
    validLeads: input.validLeads,
  });

  return validateResearchReport({
    runId: input.runId,
    jobType: "alpha-search",
    assetClass: "equity",
    generatedAt: input.generatedAt,
    summary: `Alpha search reviewed Reddit discussion and found ${String(input.validLeads.length)} Yahoo-validated research lead(s) from ${String(input.rankedCandidates.length)} Reddit-ranked candidate(s).`,
    keyFindings: input.validLeads.map((lead) => leadFinding(lead, yahooSourceId)),
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: input.validLeads.length > 0 && input.sourceGaps.length === 0 ? "medium" : "low",
    dataGaps: gaps,
    predictions: [],
    sources: input.sources,
    notFinancialAdvice: true,
    extras: {
      depth: input.command.depth,
      redditCandidateCount: input.rankedCandidates.length,
      researchLeads: input.validLeads.map((lead) => reportLead(lead, yahooSourceId)),
      rejectedCandidates: input.rejectedCandidates.map(rejectedCandidate),
    },
  });
}

function buildTrace(input: {
  readonly runId: string;
  readonly command: AlphaSearchCommand;
  readonly config: AppConfig;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceGaps: readonly SourceGap[];
}): RunTrace {
  return {
    runId: input.runId,
    jobType: "alpha-search",
    assetClass: input.command.assetClass,
    depth: input.command.depth,
    provider: input.config.provider,
    quickModel: input.config.quickModel,
    synthesisModel: input.config.synthesisModel,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    sourceGaps: input.sourceGaps.map((gap) => gap.message),
    stages: ["reddit-discovery", "reddit-ranking", "yahoo-validation", "alpha-search-report"],
    tokenEstimate: 0,
    costEstimateUsd: 0,
    domainPlaybooks: { selected: [], rejected: [] },
  };
}

export async function runAlphaSearchWorkflow(input: {
  readonly command: AlphaSearchCommand;
  readonly config: AppConfig;
  readonly now?: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
}): Promise<AlphaSearchWorkflowResult> {
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const runId = createRunId(now);
  const { alphaSearchOptions } = input.config;
  const { request, staleFallbackGaps } = createSourceRequestContext(
    input.config.sourceOptions,
    now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  const seenRedditIds = await readRedditSeenIds(alphaSearchOptions.redditSeenPath);
  const reddit = await collectRedditDiscussions({
    ...(alphaSearchOptions.redditClientId !== undefined
      ? { clientId: alphaSearchOptions.redditClientId }
      : {}),
    ...(alphaSearchOptions.redditClientSecret !== undefined
      ? { clientSecret: alphaSearchOptions.redditClientSecret }
      : {}),
    userAgent: alphaSearchOptions.redditUserAgent,
    subreddits: alphaSearchOptions.redditSubreddits,
    lookbackDays: alphaSearchOptions.redditLookbackDays,
    fetchedAt: startedAt,
    commentDepth: commentDepth(input.command),
    seenRedditIds,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const rankedCandidates = rankRedditCandidates({
    posts: reddit.posts,
    comments: reddit.comments,
    fetchedAt: startedAt,
    lookbackDays: alphaSearchOptions.redditLookbackDays,
    candidateLimit: alphaSearchOptions.topCandidateLimit,
  });
  const yahoo = await crossCheckRedditCandidatesWithYahoo({
    candidates: rankedCandidates,
    candidateLimit: alphaSearchOptions.topCandidateLimit,
    request,
  });
  const sourceGaps = [...reddit.sourceGaps, ...yahoo.sourceGaps, ...staleFallbackGaps];
  const sources = sourceList({
    posts: reddit.posts,
    comments: reddit.comments,
    yahooRawSnapshots: yahoo.rawSnapshots,
    fetchedAt: startedAt,
  });
  const report = buildAlphaSearchReport({
    runId,
    command: input.command,
    generatedAt: startedAt,
    rankedCandidates,
    validLeads: yahoo.validLeads,
    rejectedCandidates: yahoo.rejectedCandidates,
    sourceGaps,
    sources,
  });
  const markdown = renderMarkdownReport(report);
  const completedAt = new Date().toISOString();
  const trace = buildTrace({
    runId,
    command: input.command,
    config: input.config,
    startedAt,
    completedAt,
    sourceGaps,
  });
  const artifacts = await prepareRunArtifacts(input.config.dataDir, runId);

  await writeJson(join(artifacts.rawDir, "snapshots.json"), [
    ...reddit.rawSnapshots,
    ...yahoo.rawSnapshots,
  ]);
  await writeJson(join(artifacts.normalizedDir, "reddit-candidates.json"), rankedCandidates);
  await writeJson(join(artifacts.normalizedDir, "research-leads.json"), yahoo.validLeads);
  await writeJson(
    join(artifacts.normalizedDir, "rejected-candidates.json"),
    yahoo.rejectedCandidates,
  );
  await writeJson(join(artifacts.normalizedDir, "source-gaps.json"), sourceGaps);
  await writeRunOutputs(artifacts, report, markdown, trace);
  await recordRedditSeenPosts({
    path: alphaSearchOptions.redditSeenPath,
    runId,
    seenAt: startedAt,
    posts: reddit.posts,
  });
  await redactExpiredRedditRawSnapshots({
    dataDir: input.config.dataDir,
    retentionHours: alphaSearchOptions.redditRawRetentionHours,
    now,
  });

  return { report, markdown, trace, artifacts };
}
