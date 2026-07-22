import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstrumentCommand, MarketOverviewCommand } from "../src/cli/args";
import type { ResearchSubjectCommand } from "../src/cli/job-registry";
import type { AppConfig } from "../src/config";
import type { ResearchReport, RunTrace, SourceGap } from "../src/domain/types";
import { prepareRunArtifacts } from "../src/artifacts";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import {
  buildAlphaSearchManifest,
  buildResearchRunManifest,
  persistRunArtifactWrites,
  type ResearchRunManifestResult,
} from "../src/run-artifact-writer";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import type {
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
  SourcePlanArtifact,
} from "../src/research/source-plan";
import type { RawSourceSnapshot } from "../src/sources/types";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import type { SubsequentFinancingBridgeArtifact } from "../src/sources/extended-evidence/subsequent-financing";
import {
  collectedSources,
  marketSnapshot,
  researchReport,
  verifiedMarketSnapshot,
} from "./support/fixtures";

const GENERATED_AT = "2026-05-19T00:00:00.000Z";

const config: AppConfig = {
  provider: "openai",
  quickModel: "quick",
  synthesisModel: "synthesis",
  modelTimeoutMs: 120_000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 3,
    cryptoMoverLimit: 3,
    newsLimit: 3,
    sourceTimeoutMs: 1000,
  },
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

const sourcePlan: SourcePlanArtifact = {
  version: 2,
  generatedAt: GENERATED_AT,
  run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
  lanes: [],
};

const evidenceLanes: EvidenceLanesArtifact = {
  version: 2,
  generatedAt: GENERATED_AT,
  lanes: [],
  summary: {
    plannedLaneCount: 0,
    coveredLaneCount: 0,
    gapLaneCount: 0,
    sourceCount: 0,
    gapCount: 0,
    coverageRatio: 0,
  },
};

const sourceLedger: SourceLedgerArtifact = {
  version: 2,
  generatedAt: GENERATED_AT,
  sources: [],
};

const historicalContext: HistoricalResearchContext = {
  generatedAt: GENERATED_AT,
  recentDays: 90,
  anchorMonths: [],
  runs: [],
  sources: [],
  gaps: [],
  artifactDeltas: [],
  audit: {
    scannedRunCount: 0,
    malformedRunCount: 0,
    malformedScoreCount: 0,
    candidateRunCount: 0,
    selectedRunCount: 0,
    recentSelectedCount: 0,
    anchorSelectedCount: 0,
    sameSymbolSelectedCount: 0,
    spotlightSymbolSelectedCount: 0,
    sameSubjectSelectedCount: 0,
    sameHorizonSelectedCount: 0,
    crossHorizonSelectedCount: 0,
    resolvedMissRunCount: 0,
    missCorrectionSelectedCount: 0,
    gapCount: 0,
  },
};

const equityCommand: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "brief",
};

function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run-1",
    jobType: "equity",
    assetClass: "equity",
    depth: "brief",
    provider: "openai",
    quickModel: "quick",
    synthesisModel: "synthesis",
    startedAt: GENERATED_AT,
    completedAt: GENERATED_AT,
    sourceGaps: [],
    stages: [],
    tokenEstimate: 0,
    domainPlaybooks: { selected: [], rejected: [] },
    ...overrides,
  };
}

function result(overrides: Partial<ResearchRunManifestResult> = {}): ResearchRunManifestResult {
  const report = researchReport({
    runId: "run-1",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
  });
  return {
    report,
    markdown: "# Report\n",
    trace: trace(),
    analytics: { version: 1 },
    stageOutputs: [],
    collectedSources: collectedSources({
      marketSnapshots: [marketSnapshot({ sourceId: "market-aapl", symbol: "AAPL" })],
    }),
    historicalContext,
    sourcePlan,
    evidenceLanes,
    sourceLedger,
    ...overrides,
  };
}

function filesOf(writes: ReturnType<typeof buildResearchRunManifest>): readonly string[] {
  return writes.map((write) => write.file).toSorted();
}

function valueFor(
  writes: readonly { readonly file: string; readonly value: unknown }[],
  file: string,
): unknown {
  return writes.find((write) => write.file === file)?.value;
}

const baseResearchFiles = [
  RUN_ARTIFACT_FILES.rawSnapshots,
  RUN_ARTIFACT_FILES.marketSnapshots,
  RUN_ARTIFACT_FILES.supplementalMarketSnapshots,
  RUN_ARTIFACT_FILES.newsSources,
  RUN_ARTIFACT_FILES.extendedSources,
  RUN_ARTIFACT_FILES.sourceGaps,
  RUN_ARTIFACT_FILES.sourcePlan,
  RUN_ARTIFACT_FILES.evidenceLanes,
  RUN_ARTIFACT_FILES.sourceLedger,
  RUN_ARTIFACT_FILES.historicalContext,
  RUN_ARTIFACT_FILES.webSubjectProfile,
  RUN_ARTIFACT_FILES.extendedEvidence,
  RUN_ARTIFACT_FILES.marketContext,
  RUN_ARTIFACT_FILES.stages,
  RUN_ARTIFACT_FILES.analytics,
  RUN_ARTIFACT_FILES.report,
  RUN_ARTIFACT_FILES.reportMarkdown,
  RUN_ARTIFACT_FILES.trace,
] as const;

const instrumentFiles = [
  RUN_ARTIFACT_FILES.verifiedMarketSnapshot,
  RUN_ARTIFACT_FILES.instrumentIdentity,
  RUN_ARTIFACT_FILES.valuationComps,
  RUN_ARTIFACT_FILES.financialLenses,
  RUN_ARTIFACT_FILES.fundamentalHistory,
  RUN_ARTIFACT_FILES.financialStatements,
  RUN_ARTIFACT_FILES.businessFramework,
] as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempDir(): string {
  const path = join(
    tmpdir(),
    `market-bot-run-artifact-writer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  tempDirs.push(path);
  return path;
}

describe("run artifact writer manifests", () => {
  test("research equity brief manifest preserves instrument null policies", () => {
    const writes = buildResearchRunManifest(equityCommand, config, result());

    expect(filesOf(writes)).toEqual([...baseResearchFiles, ...instrumentFiles].toSorted());
    expect(valueFor(writes, RUN_ARTIFACT_FILES.extendedEvidence)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.marketContext)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.webSubjectProfile)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.verifiedMarketSnapshot)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.instrumentIdentity)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.valuationComps)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.financialLenses)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.fundamentalHistory)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.financialStatements)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.businessFramework)).toBeNull();
  });

  test("writes the collected fundamental-history sidecar", () => {
    const fundamentalHistory = deriveFundamentalHistory(
      { facts: { "us-gaap": {} } },
      {
        symbol: "AAPL",
        generatedAt: GENERATED_AT,
        sourceId: "extended-sec-edgar-aapl-fundamentals",
      },
    );
    const writes = buildResearchRunManifest(
      equityCommand,
      config,
      result({ collectedSources: collectedSources({ fundamentalHistory }) }),
    );

    expect(valueFor(writes, RUN_ARTIFACT_FILES.fundamentalHistory)).toEqual(fundamentalHistory);
  });

  test("writes the financing bridge only when events are present", () => {
    const subsequentFinancing: SubsequentFinancingBridgeArtifact = {
      version: 1,
      generatedAt: GENERATED_AT,
      symbol: "AAPL",
      statementPeriodEnd: "2026-03-31",
      events: [
        {
          disclosureDate: "2026-05-16",
          eventDate: "2026-05-15",
          instrument: "debt",
          proceeds: { amount: 100, currency: "USD", basis: "gross" },
          costs: null,
          sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          reconciled: false,
        },
      ],
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    };
    const absent = buildResearchRunManifest(equityCommand, config, result());
    const present = buildResearchRunManifest(
      equityCommand,
      config,
      result({ collectedSources: collectedSources({ subsequentFinancing }) }),
    );

    expect(filesOf(absent)).not.toContain(RUN_ARTIFACT_FILES.subsequentFinancing);
    expect(valueFor(present, RUN_ARTIFACT_FILES.subsequentFinancing)).toEqual(subsequentFinancing);
  });

  test("research deep instrument manifest includes conditional audit artifacts", () => {
    const command: InstrumentCommand = { ...equityCommand, depth: "deep" };
    const writes = buildResearchRunManifest(
      command,
      config,
      result({
        trace: trace({
          depth: "deep",
          webGatherLoop: {
            rounds: 1,
            acceptedRequests: [],
            rejectedRequests: [],
            sourceUnitsUsed: 0,
            executedTools: [],
            emittedGaps: [],
            sanitizer: {
              sourceCount: 0,
              sanitizedSourceCount: 0,
              emptyAfterSanitizeCount: 0,
              inputCharCount: 0,
              outputCharCount: 0,
              removedInstructionSpanCount: 0,
              removedChromeHtmlCount: 0,
            },
          },
        }),
        forecastDisagreement: {
          version: 1,
          generatedAt: GENERATED_AT,
          participantCount: 2,
          successfulParticipantCount: 2,
          errorCount: 0,
          predictions: [],
          provider: "openai",
          baselineModel: "synthesis",
          challengerModels: ["challenger"],
          participants: [],
        },
      }),
    );

    expect(filesOf(writes)).toEqual(
      [
        ...baseResearchFiles,
        ...instrumentFiles,
        RUN_ARTIFACT_FILES.webGatherAudit,
        RUN_ARTIFACT_FILES.forecastDisagreement,
      ].toSorted(),
    );
    expect(valueFor(writes, RUN_ARTIFACT_FILES.webGatherAudit)).toMatchObject({ rounds: 1 });
  });

  test("market overview manifest preserves empty-when-absent policies", () => {
    const command: MarketOverviewCommand = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 5,
    };
    const writes = buildResearchRunManifest(
      command,
      config,
      result({
        report: researchReport({ jobType: "market-overview", horizonTradingDays: 5 }),
        trace: trace({ jobType: "market-overview" }),
      }),
    );

    expect(filesOf(writes)).toEqual(
      [
        ...baseResearchFiles,
        RUN_ARTIFACT_FILES.spotlightCandidates,
        RUN_ARTIFACT_FILES.spotlightSelection,
        RUN_ARTIFACT_FILES.movers,
      ].toSorted(),
    );
    expect(valueFor(writes, RUN_ARTIFACT_FILES.spotlightCandidates)).toEqual([]);
    expect(valueFor(writes, RUN_ARTIFACT_FILES.movers)).toEqual([]);
    expect(valueFor(writes, RUN_ARTIFACT_FILES.spotlightSelection)).toMatchObject({
      selected: [],
      rejected: [],
      audit: { candidateCount: 0, selectedCount: 0, rejectedCount: 0 },
    });
  });

  test("research subject manifest writes resolved subject as null when absent", () => {
    const command: ResearchSubjectCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "semiconductors",
      depth: "brief",
    };
    const writes = buildResearchRunManifest(
      command,
      config,
      result({
        report: researchReport({ jobType: "research" }),
        trace: trace({ jobType: "research" }),
      }),
    );

    expect(filesOf(writes)).toEqual(
      [
        ...baseResearchFiles,
        RUN_ARTIFACT_FILES.resolvedSubject,
        RUN_ARTIFACT_FILES.verifiedRepresentativeSnapshots,
        RUN_ARTIFACT_FILES.themeCatalysts,
      ].toSorted(),
    );
    expect(valueFor(writes, RUN_ARTIFACT_FILES.resolvedSubject)).toBeNull();
    expect(valueFor(writes, RUN_ARTIFACT_FILES.verifiedRepresentativeSnapshots)).toEqual([]);
    expect(valueFor(writes, RUN_ARTIFACT_FILES.themeCatalysts)).toEqual([]);
  });

  test("research subject manifest writes assembled catalyst calendar items", () => {
    const command: ResearchSubjectCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      depth: "deep",
    };
    const items = [
      {
        date: "2026-11-01",
        label: "PDUFA decision expected 2026-11-01.",
        sourceIds: ["web-biotech"],
        sourceStatus: "sourced catalyst",
        researchRelevance: "watch item",
      },
    ];
    const writes = buildResearchRunManifest(
      command,
      config,
      result({
        report: researchReport({
          jobType: "research",
          extras: { catalystCalendar: { items } },
        }),
        trace: trace({ jobType: "research", depth: "deep" }),
      }),
    );

    expect(valueFor(writes, RUN_ARTIFACT_FILES.themeCatalysts)).toEqual(items);
  });

  test("research subject manifest writes representative verified snapshots", () => {
    const command: ResearchSubjectCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "biotech",
      depth: "deep",
    };
    const snapshot = verifiedMarketSnapshot({ symbol: "AMGN" });
    const writes = buildResearchRunManifest(
      command,
      config,
      result({
        report: researchReport({ jobType: "research" }),
        trace: trace({ jobType: "research", depth: "deep" }),
        collectedSources: collectedSources({
          marketSnapshots: [marketSnapshot({ sourceId: "market-amgn", symbol: "AMGN" })],
          verifiedRepresentativeSnapshots: [snapshot],
        }),
      }),
    );

    expect(valueFor(writes, RUN_ARTIFACT_FILES.verifiedRepresentativeSnapshots)).toEqual([
      snapshot,
    ]);
  });

  test("alpha-search manifest preserves file set and compaction policies", () => {
    const duplicateGap: SourceGap = {
      source: "sec-alpha-search",
      message: "SEC filing S-1 2026-05-18 did not map to a ticker",
    };
    const rawSnapshot: RawSourceSnapshot = {
      id: "raw-alpha",
      adapter: "alpha",
      fetchedAt: GENERATED_AT,
      payload: { text: "x".repeat(1024 * 1024 + 1) },
    };
    const report: ResearchReport = researchReport({
      runId: "alpha-1",
      jobType: "alpha-search",
      assetClass: "equity",
    });
    const writes = buildAlphaSearchManifest({
      rawSnapshots: [rawSnapshot],
      socialCandidates: [],
      secDiscoveryCandidates: [],
      alphaSearchCandidates: [],
      listedUniverse: [],
      researchLeads: [],
      secFundamentals: [],
      secFundamentalsSourceGaps: [],
      candidateProfiles: [],
      rejectedCandidates: [],
      sourceGaps: [duplicateGap, duplicateGap],
      analytics: {
        version: 2,
        runId: "alpha-1",
        generatedAt: GENERATED_AT,
        jobType: "alpha-search",
        assetClass: "equity",
        depth: "brief",
        sourceFunnel: {
          reportSources: { total: 0, byKind: {}, byProvider: {} },
          sourceGaps: { total: 0, bySource: {} },
          dataGaps: { total: 0 },
        },
        alphaSearch: {
          socialCandidateCount: 0,
          secCandidateCount: 0,
          validLeadCount: 0,
          researchLeadCount: 0,
          rejectedCandidateCount: 0,
          fundamentalGapCount: 0,
        },
        runShape: { traceStages: [], tokenEstimate: 0 },
      },
      report,
      markdown: "# Alpha\n",
      trace: trace({ runId: "alpha-1", jobType: "alpha-search" }),
    });

    expect(writes.map((write) => write.file).toSorted()).toEqual(
      [
        RUN_ARTIFACT_FILES.rawSnapshots,
        RUN_ARTIFACT_FILES.socialCandidates,
        RUN_ARTIFACT_FILES.secDiscoveryCandidates,
        RUN_ARTIFACT_FILES.alphaSearchCandidates,
        RUN_ARTIFACT_FILES.listedUniverse,
        RUN_ARTIFACT_FILES.researchLeads,
        RUN_ARTIFACT_FILES.secFundamentals,
        RUN_ARTIFACT_FILES.secFundamentalsSourceGaps,
        RUN_ARTIFACT_FILES.candidateProfiles,
        RUN_ARTIFACT_FILES.rejectedCandidates,
        RUN_ARTIFACT_FILES.sourceGaps,
        RUN_ARTIFACT_FILES.analytics,
        RUN_ARTIFACT_FILES.report,
        RUN_ARTIFACT_FILES.reportMarkdown,
        RUN_ARTIFACT_FILES.trace,
      ].toSorted(),
    );
    expect(valueFor(writes, RUN_ARTIFACT_FILES.rawSnapshots)).toMatchObject([
      { id: "raw-alpha", payloadCompacted: true },
    ]);
    expect(valueFor(writes, RUN_ARTIFACT_FILES.sourceGaps)).toEqual([
      {
        ...duplicateGap,
        message: "SEC filing S-1 2026-05-18 did not map to a ticker (2 filings)",
      },
    ]);
  });
});

describe("persistRunArtifactWrites", () => {
  test("writes JSON and text manifest entries", async () => {
    const dataDir = tempDir();
    await mkdir(dataDir, { recursive: true });
    const artifacts = await prepareRunArtifacts(dataDir, "run-1");

    await persistRunArtifactWrites(artifacts, [
      { file: RUN_ARTIFACT_FILES.analytics, kind: "json", value: { ok: true } },
      { file: RUN_ARTIFACT_FILES.reportMarkdown, kind: "text", value: "# Report\n" },
    ]);

    expect(await readFile(join(artifacts.runDir, RUN_ARTIFACT_FILES.analytics), "utf8")).toBe(
      '{\n  "ok": true\n}\n',
    );
    expect(await readFile(join(artifacts.runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8")).toBe(
      "# Report\n",
    );
  });
});
