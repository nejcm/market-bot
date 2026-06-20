import { join } from "node:path";
import {
  createRunId,
  prepareRunArtifacts,
  writeJson,
  writeRunOutputs,
  type RunArtifactPaths,
} from "../artifacts";
import type { AlphaSearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import { readCodeVersion } from "../code-version";
import type { KeyFinding, ResearchReport, RunTrace, Source, SourceGap } from "../domain/types";
import {
  compactUnmappedSecFilingGaps,
  isCoreEvidenceQualityGap,
  isUnmappedSecFilingGap,
  sourceGapReportText,
} from "../domain/source-gaps";
import { renderMarkdownReport } from "../report/markdown";
import { validateResearchReport } from "../report/schema";
import { createSourceRequestContext, DEFAULT_RETRY_DELAYS_MS } from "../sources/collector";
import { collectApeWisdomCandidates } from "../sources/apewisdom";
import { compactOversizedRawSnapshots } from "../sources/raw-snapshots";
import type { FetchLike, RawSourceSnapshot } from "../sources/types";
import {
  buildAlphaCandidateProfiles,
  type AlphaCandidateFundamentals,
  type AlphaCandidateProfile,
} from "./candidate-state";
import {
  mergeAlphaSearchCandidates,
  socialAlphaSearchCandidate,
  type AlphaSearchCandidate,
} from "./candidates";
import { collectAlphaSearchFundamentals } from "./fundamentals";
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
  type AlphaSearchProfileCoverage,
} from "./report-extras";
import { discoverSecAlphaSearchCandidates, type SecDiscoveryCandidate } from "./sec-discovery";
import {
  rankSocialMomentumCandidates,
  type SocialMomentumRankedCandidate,
} from "./social-momentum-ranking";
import { socialMomentumReportSourceId } from "./source-ids";
import {
  crossCheckAlphaSearchCandidatesWithYahoo,
  type YahooRejectedCandidate,
  type YahooValidatedLead,
} from "./yahoo-validation";

export interface AlphaSearchWorkflowResult {
  readonly report: ResearchReport;
  readonly markdown: string;
  readonly trace: RunTrace;
  readonly analytics: AlphaSearchRunAnalytics;
  readonly artifacts: RunArtifactPaths;
}

export interface AlphaSearchRunAnalytics {
  readonly version: 1;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: "alpha-search";
  readonly assetClass: "equity";
  readonly depth: AlphaSearchCommand["depth"];
  readonly codeVersion?: RunTrace["codeVersion"];
  readonly sourceFunnel: {
    readonly reportSources: {
      readonly total: number;
      readonly byKind: Readonly<Record<string, number>>;
      readonly byProvider: Readonly<Record<string, number>>;
    };
    readonly sourceGaps: {
      readonly total: number;
      readonly bySource: Readonly<Record<string, number>>;
    };
    readonly dataGaps: {
      readonly total: number;
    };
  };
  readonly alphaSearch: {
    readonly socialCandidateCount: number;
    readonly secCandidateCount: number;
    /** All Yahoo-validated leads before the display limit is applied. */
    readonly validLeadCount: number;
    /** Leads actually surfaced in the report (after leadLimit slice). */
    readonly researchLeadCount: number;
    readonly rejectedCandidateCount: number;
    readonly fundamentalGapCount: number;
  };
  readonly runShape: {
    readonly traceStages: readonly string[];
    readonly tokenEstimate: number;
    readonly costEstimateUsd: number;
    readonly durationMs?: number;
  };
}

function countBy<T>(
  items: readonly T[],
  keyFor: (item: T) => string | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
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
  const [canonicalSourceId] = candidate.sourceIds;
  return {
    id: socialMomentumReportSourceId({
      symbol: candidate.symbol,
      socialRank: candidate.socialRank,
      sourceIds: candidate.sourceIds,
    }),
    title: `ApeWisdom ${candidate.symbol} social momentum rank ${String(candidate.socialRank)}`,
    publisher: "apewisdom",
    fetchedAt,
    kind: "discussion",
    assetClass: "equity",
    provider: "apewisdom",
    ...(canonicalSourceId !== undefined ? { rawRef: canonicalSourceId } : {}),
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

function dedupeSourcesById(sources: readonly Source[]): readonly Source[] {
  const byId = new Map<string, Source>();
  for (const source of sources) {
    if (!byId.has(source.id)) {
      byId.set(source.id, source);
    }
  }
  return [...byId.values()];
}

function alphaSearchSourceGapReportTexts(gaps: readonly SourceGap[]): readonly string[] {
  return compactUnmappedSecFilingGaps(gaps).map((gap) => sourceGapReportText(gap));
}

function unmappedSecFilingCount(gaps: readonly SourceGap[]): number {
  return gaps.filter((gap) => isUnmappedSecFilingGap(gap)).length;
}

function profileCoverage(input: {
  readonly researchLeads: readonly unknown[];
  readonly candidateProfiles: readonly AlphaCandidateProfile[];
  readonly fundamentalSourceGaps: readonly SourceGap[];
  readonly sourceGaps: readonly SourceGap[];
}): AlphaSearchProfileCoverage {
  return {
    displayedLeadCount: input.researchLeads.length,
    candidateProfilesWithFundamentals: input.candidateProfiles.filter(
      (profile) => profile.fundamentals !== undefined,
    ).length,
    fundamentalGapCount: input.fundamentalSourceGaps.length,
    unmappedSecFilingCount: unmappedSecFilingCount(input.sourceGaps),
  };
}

function withProfileCoverage(
  report: ResearchReport,
  coverage: AlphaSearchProfileCoverage,
): ResearchReport {
  return validateResearchReport({
    ...report,
    extras: {
      ...report.extras,
      profileCoverage: coverage,
    },
  });
}

function sourceList(input: {
  readonly candidates: readonly SocialMomentumRankedCandidate[];
  readonly secCandidates: readonly SecDiscoveryCandidate[];
  readonly listedUniverseRawSnapshots: readonly RawSourceSnapshot[];
  readonly yahooRawSnapshots: readonly RawSourceSnapshot[];
  readonly fetchedAt: string;
}): readonly Source[] {
  return dedupeSourcesById([
    ...input.candidates.map((candidate) => socialCandidateSource(candidate, input.fetchedAt)),
    ...input.secCandidates.flatMap((candidate) => secDiscoverySource(candidate, input.fetchedAt)),
    ...(input.listedUniverseRawSnapshots.length > 0 ? [listedUniverseSource(input.fetchedAt)] : []),
    ...(input.yahooRawSnapshots.length > 0 ? [yahooValidationSource(input.fetchedAt)] : []),
  ]);
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
    ...alphaSearchSourceGapReportTexts(input.sourceGaps),
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
    // Only quality-capping (core) gaps should downgrade confidence.
    // No-cap gaps such as pre-ticker SEC filings are disclosed in dataGaps,
    // Yet must not pin an otherwise-clean run with valid leads to "low".
    confidence:
      validLeads.length > 0 && input.sourceGaps.filter(isCoreEvidenceQualityGap).length === 0
        ? "medium"
        : "low",
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
    codeVersion: readCodeVersion(),
    quickModel: input.config.quickModel,
    synthesisModel: input.config.synthesisModel,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    sourceGaps: alphaSearchSourceGapReportTexts(input.sourceGaps),
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

function sourceProvider(source: Source): string | undefined {
  if (source.provider !== undefined) {
    return source.provider;
  }
  return source.providerAliases?.[0]?.provider;
}

function durationMs(trace: RunTrace): number | undefined {
  const startedAt = Date.parse(trace.startedAt);
  const completedAt = Date.parse(trace.completedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return undefined;
  }
  return Math.max(0, completedAt - startedAt);
}

function buildAlphaSearchAnalytics(input: {
  readonly report: ResearchReport;
  readonly trace: RunTrace;
  readonly rankedCandidates: readonly SocialMomentumRankedCandidate[];
  readonly secCandidates: readonly SecDiscoveryCandidate[];
  readonly validLeads: readonly YahooValidatedLead[];
  /** Number of leads actually surfaced after the leadLimit slice. */
  readonly researchLeadCount: number;
  readonly rejectedCandidates: readonly (
    | YahooRejectedCandidate
    | ListedUniverseRejectedCandidate<AlphaSearchCandidate>
  )[];
  readonly sourceGaps: readonly SourceGap[];
  readonly fundamentalSourceGaps: readonly SourceGap[];
}): AlphaSearchRunAnalytics {
  const { report, trace } = input;
  const runDurationMs = durationMs(trace);
  return {
    version: 1,
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: "alpha-search",
    assetClass: "equity",
    depth: trace.depth,
    ...(trace.codeVersion !== undefined ? { codeVersion: trace.codeVersion } : {}),
    sourceFunnel: {
      reportSources: {
        total: report.sources.length,
        byKind: countBy(report.sources, (source) => source.kind),
        byProvider: countBy(report.sources, (source) => sourceProvider(source)),
      },
      // Funnel metric: tracks raw gap volume before dedupe, so it can exceed
      // The deduped count surfaced in report.dataGaps below.
      sourceGaps: {
        total: input.sourceGaps.length,
        bySource: countBy(input.sourceGaps, (gap) => gap.source),
      },
      dataGaps: {
        total: report.dataGaps.length,
      },
    },
    alphaSearch: {
      socialCandidateCount: input.rankedCandidates.length,
      secCandidateCount: input.secCandidates.length,
      validLeadCount: input.validLeads.length,
      researchLeadCount: input.researchLeadCount,
      rejectedCandidateCount: input.rejectedCandidates.length,
      fundamentalGapCount: input.fundamentalSourceGaps.length,
    },
    runShape: {
      traceStages: trace.stages,
      tokenEstimate: trace.tokenEstimate,
      costEstimateUsd: trace.costEstimateUsd,
      ...(runDurationMs !== undefined ? { durationMs: runDurationMs } : {}),
    },
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
    fetchedAt: startedAt,
    ...(input.config.sourceOptions.massiveApiKey !== undefined
      ? { massiveApiKey: input.config.sourceOptions.massiveApiKey }
      : {}),
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
  const rejectedCandidates = [...listed.rejectedCandidates, ...yahoo.rejectedCandidates];
  const initialReport = buildAlphaSearchReport({
    runId,
    command: input.command,
    generatedAt: startedAt,
    leadLimit: alphaSearchOptions.leadLimit,
    rankedCandidates,
    secCandidates: secDiscovery.candidates,
    validLeads: yahoo.validLeads,
    rejectedCandidates,
    sourceGaps,
    sources,
  });
  const researchLeads = readAlphaSearchLeads(initialReport.extras);
  const fundamentals = await collectAlphaSearchFundamentals({
    leads: researchLeads,
    request,
    ...(input.config.sourceOptions.secUserAgent !== undefined
      ? { secUserAgent: input.config.sourceOptions.secUserAgent }
      : {}),
  });
  const fundamentalsBySymbol = new Map<string, AlphaCandidateFundamentals>(
    fundamentals.fundamentals.map((entry) => [
      entry.symbol,
      {
        secCik: entry.secCik,
        sourceIds: entry.sourceIds,
        metrics: entry.metrics,
      },
    ]),
  );
  const candidateProfiles = buildAlphaCandidateProfiles(initialReport, fundamentalsBySymbol);
  const report = withProfileCoverage(
    initialReport,
    profileCoverage({
      researchLeads,
      candidateProfiles,
      fundamentalSourceGaps: fundamentals.sourceGaps,
      sourceGaps,
    }),
  );
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
  const analytics = buildAlphaSearchAnalytics({
    report,
    trace,
    rankedCandidates,
    secCandidates: secDiscovery.candidates,
    validLeads: yahoo.validLeads,
    researchLeadCount: researchLeads.length,
    rejectedCandidates,
    sourceGaps,
    fundamentalSourceGaps: fundamentals.sourceGaps,
  });
  const artifacts = await prepareRunArtifacts(input.config.dataDir, runId);

  await writeJson(
    join(artifacts.rawDir, "snapshots.json"),
    compactOversizedRawSnapshots([
      ...apeWisdom.rawSnapshots,
      ...secDiscovery.rawSnapshots,
      ...fundamentals.rawSnapshots,
      ...listedUniverse.rawSnapshots,
      ...yahoo.rawSnapshots,
    ]),
  );
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
  await writeJson(join(artifacts.normalizedDir, "research-leads.json"), researchLeads);
  await writeJson(
    join(artifacts.normalizedDir, "sec-fundamentals.json"),
    fundamentals.fundamentals,
  );
  await writeJson(
    join(artifacts.normalizedDir, "sec-fundamentals-source-gaps.json"),
    fundamentals.sourceGaps,
  );
  await writeJson(join(artifacts.normalizedDir, "candidate-profiles.json"), candidateProfiles);
  await writeJson(join(artifacts.normalizedDir, "rejected-candidates.json"), rejectedCandidates);
  await writeJson(
    join(artifacts.normalizedDir, "source-gaps.json"),
    compactUnmappedSecFilingGaps(sourceGaps),
  );
  await writeJson(join(artifacts.runDir, "analytics.json"), analytics);
  await writeRunOutputs(artifacts, report, markdown, trace);

  return { report, markdown, trace, analytics, artifacts };
}
