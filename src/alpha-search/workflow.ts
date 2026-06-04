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
import { collectApeWisdomCandidates } from "../sources/apewisdom";
import type { FetchLike, RawSourceSnapshot } from "../sources/types";
import { buildAlphaCandidateProfiles } from "./candidate-state";
import {
  mergeAlphaSearchCandidates,
  socialAlphaSearchCandidate,
  type AlphaSearchCandidate,
} from "./candidates";
import {
  collectListedUniverse,
  filterListedUniverseCandidates,
  type ListedUniverseRejectedCandidate,
} from "./listed-universe";
import {
  alphaSearchLead,
  alphaSearchRejectedCandidate,
  leadSourceIds,
  readAlphaSearchLeads,
  type AlphaSearchReportExtras,
} from "./report-extras";
import { discoverSecAlphaSearchCandidates, type SecDiscoveryCandidate } from "./sec-discovery";
import {
  rankSocialMomentumCandidates,
  type SocialMomentumRankedCandidate,
} from "./social-momentum-ranking";
import {
  crossCheckAlphaSearchCandidatesWithYahoo,
  type YahooRejectedCandidate,
  type YahooValidatedLead,
} from "./yahoo-validation";

export interface AlphaSearchWorkflowResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly artifacts: RunArtifacts;
}

function pageLimit(command: AlphaSearchCommand, config: AppConfig): number {
  return command.depth === "deep"
    ? config.alphaSearchOptions.apeWisdomDeepPageLimit
    : config.alphaSearchOptions.apeWisdomBriefPageLimit;
}

function socialCandidateSource(
  candidate: SocialMomentumRankedCandidate,
  fetchedAt: string,
): Source {
  return {
    id: candidate.sourceIds[0] ?? `apewisdom-${candidate.symbol}`,
    title: `ApeWisdom ${candidate.symbol} social momentum rank ${String(candidate.socialRank)}`,
    publisher: "apewisdom",
    fetchedAt,
    kind: "discussion",
    assetClass: "equity",
    provider: "apewisdom",
    ...(candidate.sourceIds[0] !== undefined ? { rawRef: candidate.sourceIds[0] } : {}),
  };
}

function yahooValidationSource(fetchedAt: string): Source {
  return {
    id: "market-yahoo-alpha-search",
    title: "Yahoo quote validation for official-listed alpha-search candidates",
    fetchedAt,
    kind: "market-data",
    assetClass: "equity",
    provider: "yahoo",
  };
}

function secDiscoverySource(
  candidate: SecDiscoveryCandidate,
  fetchedAt: string,
): readonly Source[] {
  return candidate.recentSecFilings.flatMap((filing) =>
    filing.sourceIds.map((sourceId) => ({
      id: sourceId,
      title: `SEC ${filing.form} filing for ${candidate.symbol} filed ${filing.filingDate}`,
      fetchedAt,
      kind: "market-data" as const,
      assetClass: "equity" as const,
      symbol: candidate.symbol,
      provider: "sec-edgar",
    })),
  );
}

function listedUniverseSource(fetchedAt: string): Source {
  return {
    id: "market-listed-universe-alpha-search",
    title: "Official listed-symbol universe for alpha-search candidates",
    fetchedAt,
    kind: "market-data",
    assetClass: "equity",
    provider: "listed-universe",
  };
}

function sourceList(input: {
  readonly candidates: readonly SocialMomentumRankedCandidate[];
  readonly secCandidates: readonly SecDiscoveryCandidate[];
  readonly listedUniverseRawSnapshots: readonly RawSourceSnapshot[];
  readonly yahooRawSnapshots: readonly RawSourceSnapshot[];
  readonly fetchedAt: string;
}): readonly Source[] {
  return [
    ...input.candidates.map((candidate) => socialCandidateSource(candidate, input.fetchedAt)),
    ...input.secCandidates.flatMap((candidate) => secDiscoverySource(candidate, input.fetchedAt)),
    ...(input.listedUniverseRawSnapshots.length > 0 ? [listedUniverseSource(input.fetchedAt)] : []),
    ...(input.yahooRawSnapshots.length > 0 ? [yahooValidationSource(input.fetchedAt)] : []),
  ];
}

function leadFinding(lead: YahooValidatedLead, yahooSourceId: string | undefined): KeyFinding {
  const name = lead.name === undefined ? lead.symbol : `${lead.symbol} (${lead.name})`;
  const social =
    lead.candidate.socialRank === undefined || lead.candidate.socialMomentumScore === undefined
      ? ""
      : ` ranked ${String(lead.candidate.socialRank)} by ApeWisdom social momentum with score ${String(lead.candidate.socialMomentumScore)}`;
  const sec =
    lead.candidate.recentSecFilings === undefined || lead.candidate.recentSecFilings.length === 0
      ? ""
      : ` with recent SEC filing evidence (${lead.candidate.recentSecFilings.map((filing) => `${filing.form} ${filing.filingDate}`).join(", ")})`;
  return {
    text: `${name}${social}${sec}; Yahoo resolved it as a listed stock on ${lead.exchange}.`,
    sourceIds: leadSourceIds(lead, yahooSourceId),
  };
}

function dataGaps(input: {
  readonly sourceGaps: readonly SourceGap[];
  readonly rankedCandidates: readonly SocialMomentumRankedCandidate[];
  readonly validLeads: readonly YahooValidatedLead[];
}): readonly string[] {
  return [
    ...input.sourceGaps.map((gap) => gap.message),
    ...(input.rankedCandidates.length === 0
      ? ["No ApeWisdom-ranked equity candidates were found"]
      : []),
    ...(input.rankedCandidates.length > 0 && input.validLeads.length === 0
      ? ["No ApeWisdom-ranked candidates passed Yahoo validation"]
      : []),
  ];
}

function buildAlphaSearchReport(input: {
  readonly runId: string;
  readonly command: AlphaSearchCommand;
  readonly generatedAt: string;
  readonly leadLimit: number;
  readonly rankedCandidates: readonly SocialMomentumRankedCandidate[];
  readonly secCandidates: readonly SecDiscoveryCandidate[];
  readonly validLeads: readonly YahooValidatedLead[];
  readonly rejectedCandidates: readonly (
    | YahooRejectedCandidate
    | ListedUniverseRejectedCandidate<AlphaSearchCandidate>
  )[];
  readonly sourceGaps: readonly SourceGap[];
  readonly sources: readonly Source[];
}): ResearchReport {
  const yahooSourceId = input.sources.find((source) => source.provider === "yahoo")?.id;
  const validLeads = input.validLeads.slice(0, input.leadLimit);
  const researchLeads = validLeads.map((lead) => alphaSearchLead(lead, yahooSourceId));
  const extras: AlphaSearchReportExtras = {
    depth: input.command.depth,
    socialCandidateCount: input.rankedCandidates.length,
    secCandidateCount: input.secCandidates.length,
    researchLeads,
    rejectedCandidates: input.rejectedCandidates.map(alphaSearchRejectedCandidate),
  };
  const gaps = dataGaps({
    sourceGaps: input.sourceGaps,
    rankedCandidates: input.rankedCandidates,
    validLeads,
  });

  return validateResearchReport({
    runId: input.runId,
    jobType: "alpha-search",
    assetClass: "equity",
    generatedAt: input.generatedAt,
    summary: `Alpha search reviewed ApeWisdom social momentum and SEC filing discovery, then found ${String(validLeads.length)} Yahoo-validated research lead(s) from ${String(input.rankedCandidates.length)} ranked social candidate(s) and ${String(input.secCandidates.length)} SEC candidate(s).`,
    keyFindings: validLeads.map((lead) => leadFinding(lead, yahooSourceId)),
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: validLeads.length > 0 && input.sourceGaps.length === 0 ? "medium" : "low",
    dataGaps: gaps,
    predictions: [],
    sources: input.sources,
    notFinancialAdvice: true,
    extras,
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
    stages: [
      "apewisdom-discovery",
      "social-momentum-ranking",
      "sec-filing-discovery",
      "official-listed-universe-filter",
      "yahoo-validation",
      "alpha-search-report",
    ],
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
  const rankedCandidateLimit = Math.max(
    alphaSearchOptions.topCandidateLimit,
    alphaSearchOptions.validationCandidateLimit,
  );
  const { request, staleFallbackGaps } = createSourceRequestContext(
    input.config.sourceOptions,
    now,
    input.fetchImpl ?? fetch,
    input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
  );
  const apeWisdom = await collectApeWisdomCandidates({
    filter: alphaSearchOptions.apeWisdomFilter,
    pageLimit: pageLimit(input.command, input.config),
    request,
  });
  const rankedCandidates = rankSocialMomentumCandidates({
    candidates: apeWisdom.candidates,
    candidateLimit: rankedCandidateLimit,
  });
  const secDiscovery = await discoverSecAlphaSearchCandidates({
    formTypes: alphaSearchOptions.secFormTypes,
    candidateLimit: alphaSearchOptions.secDiscoveryLimit,
    ...(input.config.sourceOptions.secUserAgent !== undefined
      ? { secUserAgent: input.config.sourceOptions.secUserAgent }
      : {}),
    request,
  });
  const socialValidationCandidates = rankedCandidates
    .slice(0, alphaSearchOptions.validationCandidateLimit)
    .map((candidate) => socialAlphaSearchCandidate(candidate));
  const validationCandidates = mergeAlphaSearchCandidates([
    ...socialValidationCandidates,
    ...secDiscovery.candidates,
  ]);
  const listedUniverse = await collectListedUniverse(request);
  const listed = filterListedUniverseCandidates({
    candidates: validationCandidates,
    entries: listedUniverse.entries,
  });
  const yahoo = await crossCheckAlphaSearchCandidatesWithYahoo({
    candidates: listed.eligibleCandidates,
    candidateLimit: listed.eligibleCandidates.length,
    request,
    eligibility: alphaSearchOptions,
  });
  const sourceGaps = [
    ...apeWisdom.sourceGaps,
    ...secDiscovery.sourceGaps,
    ...listedUniverse.sourceGaps,
    ...yahoo.sourceGaps,
    ...staleFallbackGaps,
  ];
  const sources = sourceList({
    candidates: rankedCandidates,
    secCandidates: secDiscovery.candidates,
    listedUniverseRawSnapshots: listedUniverse.rawSnapshots,
    yahooRawSnapshots: yahoo.rawSnapshots,
    fetchedAt: startedAt,
  });
  const report = buildAlphaSearchReport({
    runId,
    command: input.command,
    generatedAt: startedAt,
    leadLimit: alphaSearchOptions.leadLimit,
    rankedCandidates,
    secCandidates: secDiscovery.candidates,
    validLeads: yahoo.validLeads,
    rejectedCandidates: [...listed.rejectedCandidates, ...yahoo.rejectedCandidates],
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
    ...apeWisdom.rawSnapshots,
    ...secDiscovery.rawSnapshots,
    ...listedUniverse.rawSnapshots,
    ...yahoo.rawSnapshots,
  ]);
  await writeJson(join(artifacts.normalizedDir, "social-candidates.json"), rankedCandidates);
  await writeJson(
    join(artifacts.normalizedDir, "sec-discovery-candidates.json"),
    secDiscovery.candidates,
  );
  await writeJson(
    join(artifacts.normalizedDir, "alpha-search-candidates.json"),
    validationCandidates,
  );
  await writeJson(join(artifacts.normalizedDir, "listed-universe.json"), listedUniverse.entries);
  await writeJson(
    join(artifacts.normalizedDir, "research-leads.json"),
    readAlphaSearchLeads(report.extras),
  );
  await writeJson(
    join(artifacts.normalizedDir, "candidate-profiles.json"),
    buildAlphaCandidateProfiles(report),
  );
  await writeJson(join(artifacts.normalizedDir, "rejected-candidates.json"), [
    ...listed.rejectedCandidates,
    ...yahoo.rejectedCandidates,
  ]);
  await writeJson(join(artifacts.normalizedDir, "source-gaps.json"), sourceGaps);
  await writeRunOutputs(artifacts, report, markdown, trace);

  return { report, markdown, trace, artifacts };
}
