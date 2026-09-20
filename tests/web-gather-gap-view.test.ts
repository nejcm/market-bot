import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstrumentCommand, ResearchCommand } from "../src/cli/args";
import { sourceGap } from "../src/domain/source-gaps";
import type { ResearchReport, RunTrace, SourceGap } from "../src/domain/types";
import { prepareRunArtifacts } from "../src/artifacts";
import { listRunSummaries, readRunDetail, searchRunReports } from "../app/artifacts";
import { buildRunWorkspaceView } from "../app/client/run-workspace-view";
import { buildDeepEquityEvidenceBundle } from "../src/deep-equity/evidence";
import { readGapTriage } from "../src/report/gap-triage";
import { renderMarkdownReport } from "../src/report/markdown";
import { validateResearchReport } from "../src/report/schema";
import { deterministicSourceGapEntries } from "../src/research/deterministic-gaps";
import {
  createHistoricalContextReader,
  type HistoricalResearchContext,
} from "../src/research/historical-context";
import { createSanitizedHistoricalContextReader } from "../src/research/historical-context-sanitization";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import {
  collectedSourcesForGapView,
  type SourceGapView,
} from "../src/research/prompts/source-gap-view";
import { assembleResearchReport, buildSourceList } from "../src/research/report-assembly";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import { rebuildRunArtifactIndex } from "../src/run-artifact-index";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { readReport } from "../src/run-artifact-report-reader";
import { buildResearchRunManifest, persistRunArtifactWrites } from "../src/run-artifact-writer";
import { collectAnalystExpectations } from "../src/sources/extended-evidence/analyst-expectations";
import {
  frameworkGaps,
  QUALITATIVE_GAPS,
} from "../src/sources/extended-evidence/business-framework";
import type { CollectContext, CollectedSources, SourceRequestExecutor } from "../src/sources/types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import {
  config,
  contextWithHistory,
  stagePromptFromArgs,
} from "./support/research-context-helpers";
import { assertSourceIdClosure } from "./support/run-fixtures/financial-invariants";

const command: ResearchCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};
const generatedAt = "2026-05-19T00:00:00.000Z";
const amdCommand: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AMD",
  depth: "deep",
};
const priorAmdCommand: InstrumentCommand = { ...amdCommand, depth: "brief" };

const excludedHistoricalPrefixes = [
  "finnhub-analyst-range",
  "finnhub-eps-estimate",
  "finnhub-revenue-estimate",
  "finnhub-ebitda-estimate",
] as const;
const priorAmdSourceGaps = [
  ...excludedHistoricalPrefixes.map((source) =>
    sourceGap({
      source,
      message: `${source} endpoint is unavailable for the configured token (status 403)`,
      cause: "unsupported-coverage",
      capability: "extended-evidence",
    }),
  ),
  sourceGap({
    source: "finnhub-events",
    message: "Finnhub dividend endpoint is unavailable for the configured token (status 403)",
    cause: "unsupported-coverage",
    capability: "extended-evidence",
  }),
  sourceGap({
    source: "finnhub-events",
    message: "Finnhub split endpoint is unavailable for the configured token (status 403)",
    cause: "unsupported-coverage",
    capability: "extended-evidence",
  }),
  sourceGap({
    source: "finnhub-institutional-ownership",
    message:
      "Institutional ownership endpoint is unavailable for the configured token (status 403)",
    cause: "unsupported-coverage",
    capability: "extended-evidence",
  }),
  sourceGap({
    source: "tradier-options",
    message: "Options evidence is unavailable",
    cause: "provider-data-missing",
    capability: "extended-evidence",
  }),
] as const;
const priorAmdGapTexts = priorAmdSourceGaps.map((gap) => `${gap.source}: ${gap.message}`);
const compoundHistoricalGap =
  "business-framework: Business Framework partial for AMD: analyst-consensus: missing; segment-mix: revenue by segment unavailable";
const priorAmdReportGapTexts = [compoundHistoricalGap, ...priorAmdGapTexts];
const historicalDataGapLimit = 8;

const unsupportedAnalystRange = sourceGap({
  source: "finnhub-analyst-range",
  message: "Analyst price-target distribution unavailable: request failed with status 403",
  cause: "unsupported-coverage",
  capability: "extended-evidence",
  evidenceQualityImpact: "no-cap",
});
const missingCredentialAnalystRange = sourceGap({
  source: "finnhub-analyst-range",
  message: "Analyst price-target distribution unavailable: missing Finnhub credential",
  cause: "missing-credential",
  capability: "extended-evidence",
  evidenceQualityImpact: "no-cap",
});
const analystConsensus = frameworkGaps(
  "AAPL",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "analyst-consensus"),
)[0]!;
const segmentMix = frameworkGaps(
  "AAPL",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "segment-mix"),
)[0]!;
const amdAnalystConsensus = frameworkGaps(
  "AMD",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "analyst-consensus"),
)[0]!;
const amdSegmentMix = frameworkGaps(
  "AMD",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "segment-mix"),
)[0]!;
const unsupportedEpsEstimate = sourceGap({
  source: "finnhub-eps-estimate",
  message: "Finnhub EPS estimate endpoint is unavailable for the configured token (status 403)",
  cause: "unsupported-coverage",
  capability: "extended-evidence",
  evidenceQualityImpact: "extended-evidence-cap",
});
const missingCredentialEpsEstimate = sourceGap({
  source: "finnhub-eps-estimate",
  message: "MARKET_BOT_FINNHUB_API_TOKEN is not set for the Finnhub EPS estimate endpoint",
  cause: "missing-credential",
  capability: "extended-evidence",
  evidenceQualityImpact: "extended-evidence-cap",
});
const unsupportedRevenueEstimate = sourceGap({
  source: "finnhub-revenue-estimate",
  message: "Finnhub revenue estimate endpoint is unavailable for the configured token (status 403)",
  cause: "unsupported-coverage",
  capability: "extended-evidence",
  evidenceQualityImpact: "extended-evidence-cap",
});
const missingCredentialRevenueEstimate = sourceGap({
  source: "finnhub-revenue-estimate",
  message: "MARKET_BOT_FINNHUB_API_TOKEN is not set for the Finnhub revenue estimate endpoint",
  cause: "missing-credential",
  capability: "extended-evidence",
  evidenceQualityImpact: "extended-evidence-cap",
});
const secCompanyFacts = sourceGap({
  source: "sec-edgar",
  message: "Company facts unavailable",
  capability: "extended-evidence",
  cause: "provider-data-missing",
});
const marketauxNews = sourceGap({
  source: "marketaux-news",
  message: "News unavailable",
  capability: "news",
  cause: "fetch-failed",
});

const droppedGaps = [
  unsupportedAnalystRange,
  analystConsensus,
  unsupportedEpsEstimate,
  unsupportedRevenueEstimate,
] as const;
const allGaps = [
  segmentMix,
  unsupportedAnalystRange,
  unsupportedEpsEstimate,
  unsupportedRevenueEstimate,
  analystConsensus,
  secCompanyFacts,
  marketauxNews,
] as const;

function sourcesWithGaps(
  sourceGaps: readonly SourceGap[] = allGaps,
  overrides: Partial<CollectedSources> = {},
): CollectedSources {
  return collectedSources({
    marketSnapshots: [marketSnapshot()],
    newsSources: [newsSource()],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    sourceGaps,
    ...overrides,
  });
}

function payload(view: SourceGapView, sources: CollectedSources): Record<string, unknown> {
  return buildEvidencePayload(
    { includePriorCalibration: false, sourceGapView: view, webSourceText: "metadata" },
    command,
    sources,
    config,
    contextWithHistory(command),
  );
}

function sourceGapTexts(value: Record<string, unknown>): readonly string[] {
  return value.sourceGaps as readonly string[];
}

function analystCollectContext(input: {
  readonly token?: string;
  readonly request?: SourceRequestExecutor;
}): CollectContext {
  return {
    command,
    fetchedAt: generatedAt,
    newsLimit: 1,
    cryptoMoverLimit: 1,
    ...(input.token !== undefined ? { finnhubApiToken: input.token } : {}),
    request: input.request ?? {
      json: async () => {
        throw new Error("unexpected request");
      },
      text: async () => {
        throw new Error("unexpected text request");
      },
    },
  };
}

function emptyHistoricalContext(at: string): HistoricalResearchContext {
  return {
    generatedAt: at,
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
}

function amdSources(sourceGaps: readonly SourceGap[] = priorAmdSourceGaps): CollectedSources {
  return collectedSources({
    marketSnapshots: [
      marketSnapshot({
        sourceId: "market-amd",
        symbol: "AMD",
        observedAt: "2026-09-18T00:00:00.000Z",
      }),
    ],
    newsSources: [newsSource({ id: "news-amd", assetClass: "equity" })],
    verifiedMarketSnapshot: verifiedMarketSnapshot({
      symbol: "AMD",
      fetchedAt: "2026-09-18T00:00:00.000Z",
    }),
    sourceGaps,
  });
}

function amdContext(historicalContext?: HistoricalResearchContext) {
  const context = contextWithHistory(amdCommand, historicalContext);
  return {
    ...context,
    analysisAsOf: "2026-09-19T00:00:00.000Z",
    runParams: { ...context.runParams, predictionSubjects: ["AMD"] },
  };
}

function promptText(
  stage: "web-gather" | "evidence-request",
  sources: CollectedSources,
  historicalContext?: HistoricalResearchContext,
): string {
  return stagePromptFromArgs(stage, amdCommand, sources, config, amdContext(historicalContext), {
    system: "Research only.",
    instruction: "Inspect the evidence.",
    goal: "Identify evidence gaps.",
  });
}

function promptEvidence(
  stage: "web-gather" | "evidence-request",
  sources: CollectedSources,
  historicalContext?: HistoricalResearchContext,
): Record<string, unknown> {
  return (
    JSON.parse(promptText(stage, sources, historicalContext)) as {
      readonly evidence: Record<string, unknown>;
    }
  ).evidence;
}

function priorAssemblyContext() {
  const context = contextWithHistory(priorAmdCommand);
  const depthProfile = {
    ...context.depthProfile,
    minimumKeyFindings: 0,
    minimumScenarios: 0,
    targetPredictions: 0,
  };
  return {
    ...context,
    depthProfile,
    runParams: {
      ...context.runParams,
      minimumKeyFindings: 0,
      minimumScenarios: 0,
      targetPredictions: 0,
      predictionSubjects: ["AMD"],
    },
  };
}

function priorTrace(runId: string, at: string): RunTrace {
  return {
    runId,
    jobType: "equity",
    assetClass: "equity",
    symbol: "AMD",
    depth: "brief",
    provider: "openai",
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    startedAt: at,
    completedAt: at,
    sourceGaps: priorAmdGapTexts,
    stages: [],
    tokenEstimate: 0,
    domainPlaybooks: { selected: [], rejected: [] },
    sourceTextResearchOnly: {
      summary: { scannedCount: 0, flaggedCount: 0, flaggedByKind: {}, flaggedByProvider: {} },
      items: [],
    },
  };
}

interface AmdHistoryFixture {
  readonly dataDir: string;
  readonly history: HistoricalResearchContext;
  readonly reportGapTexts: readonly (readonly string[])[];
}

const amdHistoryFixtureState: {
  promise?: Promise<AmdHistoryFixture>;
  dataDir?: string;
} = {};

async function writePriorAmdRun(dataDir: string, runId: string, at: string) {
  const sources = amdSources();
  const context = priorAssemblyContext();
  const report = assembleResearchReport({
    runId,
    generatedAt: at,
    command: priorAmdCommand,
    payload: {
      summary: `${runId} AMD research summary.`,
      confidence: "low",
      dataGaps: [compoundHistoricalGap],
    },
    predResult: { predictions: [], errors: [] },
    collectedSources: sources,
    depthProfile: context.depthProfile,
    context,
    sources: buildSourceList(priorAmdCommand, sources),
  });
  const sourcePlanning = assessSourcePlan(buildSourcePlan(priorAmdCommand, at), sources, at);
  const artifacts = await prepareRunArtifacts(dataDir, runId);
  await persistRunArtifactWrites(
    artifacts,
    buildResearchRunManifest(
      priorAmdCommand,
      { ...config, dataDir },
      {
        report,
        markdown: renderMarkdownReport(report),
        trace: priorTrace(runId, at),
        analytics: { version: 1 },
        outcomes: [],
        stageOutputs: [],
        collectedSources: sources,
        historicalContext: emptyHistoricalContext(at),
        ...sourcePlanning,
      },
    ),
  );
  return report;
}

async function amdHistoryFixture(): Promise<AmdHistoryFixture> {
  if (amdHistoryFixtureState.promise === undefined) {
    amdHistoryFixtureState.promise = (async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "market-bot-web-gather-gap-view-"));
      amdHistoryFixtureState.dataDir = dataDir;
      const reports = await Promise.all([
        writePriorAmdRun(dataDir, "amd-prior-1", "2026-09-18T12:00:00.000Z"),
        writePriorAmdRun(dataDir, "amd-prior-2", "2026-09-17T12:00:00.000Z"),
        writePriorAmdRun(dataDir, "amd-prior-3", "2026-09-16T12:00:00.000Z"),
      ]);
      const reader = createSanitizedHistoricalContextReader(
        await createHistoricalContextReader(dataDir),
      );
      const loaded = await reader.load({
        command: amdCommand,
        config: {
          historyOptions: {
            tickerRecentLimit: 3,
            marketRecentLimit: 0,
            recentDays: 90,
            anchorMonths: [],
            missCorrectionLimit: 0,
          },
        },
        now: new Date("2026-09-19T00:00:00.000Z"),
      });
      return {
        dataDir,
        history: loaded.context,
        reportGapTexts: reports.map((report) => report.dataGaps),
      };
    })();
  }
  return structuredClone(await amdHistoryFixtureState.promise);
}

afterAll(async () => {
  if (amdHistoryFixtureState.dataDir !== undefined) {
    await rm(amdHistoryFixtureState.dataDir, { recursive: true, force: true });
  }
});

describe("Web Gather Source Gap view", () => {
  test("drops every finnhub analyst-range variant from sourceGaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([unsupportedAnalystRange, missingCredentialAnalystRange, segmentMix]),
      ),
    );

    expect(texts.some((text) => text.includes("finnhub-analyst-range"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("drops the Business Framework analyst-consensus gap", () => {
    const texts = sourceGapTexts(
      payload("web-gather", sourcesWithGaps([analystConsensus, segmentMix])),
    );

    expect(texts.some((text) => text.includes("analyst-consensus"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("drops every finnhub eps-estimate variant from sourceGaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([unsupportedEpsEstimate, missingCredentialEpsEstimate, segmentMix]),
      ),
    );

    expect(texts.some((text) => text.includes("finnhub-eps-estimate"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("drops every finnhub revenue-estimate variant from sourceGaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([unsupportedRevenueEstimate, missingCredentialRevenueEstimate, segmentMix]),
      ),
    );

    expect(texts.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("keeps web-closable gaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([
          ...frameworkGaps("AAPL", QUALITATIVE_GAPS),
          secCompanyFacts,
          marketauxNews,
        ]),
      ),
    );

    for (const { code } of QUALITATIVE_GAPS) {
      expect(texts.some((text) => text.includes(code))).toBe(code !== "analyst-consensus");
    }
    for (const expected of ["sec-edgar", "marketaux-news"]) {
      expect(texts.some((text) => text.includes(expected))).toBe(true);
    }
  });

  test("narrows extendedEvidence gaps while preserving sibling order", () => {
    const extendedGaps = (
      payload(
        "web-gather",
        sourcesWithGaps(allGaps, {
          extendedEvidence: {
            instrument: { symbol: "AAPL", assetClass: "equity" },
            items: [],
            gaps: allGaps,
          },
        }),
      ).extendedEvidence as { readonly gaps: readonly SourceGap[] }
    ).gaps;

    expect(extendedGaps).toEqual([segmentMix, secCompanyFacts, marketauxNews]);
  });

  test("narrows marketContext gaps", () => {
    const marketContext = payload(
      "web-gather",
      sourcesWithGaps([], {
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [unsupportedAnalystRange, segmentMix],
        },
      }),
    ).marketContext as { readonly gaps: readonly SourceGap[] };

    expect(marketContext.gaps).toEqual([segmentMix]);
  });

  test("leaves reused Web Subject Profile openGaps byte-identical", () => {
    const openGaps = [
      "The supplied excerpts do not provide customer concentration, repeat-purchase rates, pricing elasticity, or analyst consensus.",
    ];
    const sources = sourcesWithGaps(droppedGaps, {
      webSubjectProfile: {
        version: 2,
        generatedAt,
        subjectKind: "company",
        subjectId: "AAPL",
        symbol: "AAPL",
        subjectSummary: { answer: "Apple makes consumer devices.", sourceIds: ["web-aapl"] },
        recentMaterialEvents: [],
        factLedger: [],
        openGaps,
        sourceIds: ["web-aapl"],
        questions: {
          whatItDoes: { answer: "Devices.", sourceIds: ["web-aapl"] },
          howItMakesMoney: { answer: "Sales.", sourceIds: ["web-aapl"] },
          customers: { answer: "Consumers.", sourceIds: ["web-aapl"] },
          geography: { answer: "Global.", sourceIds: ["web-aapl"] },
          purchaseRecurrence: { answer: "Mixed.", sourceIds: ["web-aapl"] },
          pricingPower: { answer: "Unknown.", sourceIds: ["web-aapl"] },
          recessionCyclicality: { answer: "Unknown.", sourceIds: ["web-aapl"] },
        },
      },
    });
    const allOpenGaps = (payload("all", sources).webSubjectProfile as { openGaps: string[] })
      .openGaps;
    const gatherOpenGaps = (
      payload("web-gather", sources).webSubjectProfile as { openGaps: string[] }
    ).openGaps;

    expect(JSON.stringify(gatherOpenGaps)).toBe(JSON.stringify(allOpenGaps));
    expect(gatherOpenGaps).toBe(openGaps);
  });

  test("keeps dropped gaps visible to every other prompt stage", () => {
    const sources = sourcesWithGaps(droppedGaps, {
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: droppedGaps,
      },
    });

    for (const stage of [
      "final-synthesis",
      "evidence-request",
      "specialist-analysis",
      "web-subject-profile",
    ] as const) {
      const parsed = JSON.parse(
        stagePromptFromArgs(stage, command, sources, config, contextWithHistory(command), {
          system: "Research only.",
          instruction: "Analyze.",
          goal: "Find evidence.",
        }),
      ) as {
        evidence: {
          sourceGaps: readonly string[];
          extendedEvidence: { readonly gaps: readonly SourceGap[] };
        };
      };

      expect(
        parsed.evidence.sourceGaps.some((text) => text.includes("finnhub-analyst-range")),
      ).toBe(true);
      expect(parsed.evidence.sourceGaps.some((text) => text.includes("finnhub-eps-estimate"))).toBe(
        true,
      );
      expect(
        parsed.evidence.sourceGaps.some((text) => text.includes("finnhub-revenue-estimate")),
      ).toBe(true);
      expect(parsed.evidence.sourceGaps.some((text) => text.includes("analyst-consensus"))).toBe(
        true,
      );
      expect(parsed.evidence.extendedEvidence.gaps).toEqual(droppedGaps);
    }
  });

  test("does not mutate or hide gaps from deterministic report projection", () => {
    const sourceGaps = [...droppedGaps];
    const sources = sourcesWithGaps(sourceGaps);

    payload("web-gather", sources);

    const reportGaps = deterministicSourceGapEntries(command, sources).map((gap) => gap.text);
    expect(reportGaps.some((text) => text.includes("finnhub-analyst-range"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-eps-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("analyst-consensus"))).toBe(true);
    expect(sources.sourceGaps).toBe(sourceGaps);
    expect(sources.sourceGaps).toHaveLength(droppedGaps.length);
  });

  test("keeps an empty sourceGaps key under both views", () => {
    const sources = sourcesWithGaps([]);

    for (const view of ["all", "web-gather"] as const) {
      expect(payload(view, sources)).toHaveProperty("sourceGaps", []);
    }
  });

  test("drops every unclosable gap from web-gather while the all view keeps them", () => {
    const sources = sourcesWithGaps([
      unsupportedAnalystRange,
      missingCredentialAnalystRange,
      unsupportedEpsEstimate,
      missingCredentialEpsEstimate,
      unsupportedRevenueEstimate,
      missingCredentialRevenueEstimate,
      analystConsensus,
    ]);
    const gather = payload("web-gather", sources);
    const all = payload("all", sources);
    const allTexts = sourceGapTexts(all);

    expect(gather).toHaveProperty("sourceGaps", []);
    expect(allTexts).toHaveLength(7);
    expect(allTexts.some((text) => text.includes("request failed with status 403"))).toBe(true);
    expect(allTexts.some((text) => text.includes("missing Finnhub credential"))).toBe(true);
    expect(allTexts.some((text) => text.includes("finnhub-eps-estimate"))).toBe(true);
    expect(allTexts.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(true);
    expect(allTexts.some((text) => text.includes("analyst-consensus"))).toBe(true);
  });

  test("does not assign dropped gaps to Source Plan lanes", () => {
    const sources = sourcesWithGaps(droppedGaps);
    const assessed = assessSourcePlan(buildSourcePlan(command, generatedAt), sources, generatedAt);
    const laneGapText = assessed.evidenceLanes.lanes.flatMap((lane) => lane.gapText);

    for (const gap of droppedGaps) {
      expect(laneGapText.some((text) => text.includes(gap.message))).toBe(false);
    }
  });

  test("does not hide a 403 gap from a different producer", () => {
    const lookalike = sourceGap({
      source: "sec-edgar",
      message: "request failed with status 403",
      cause: "unsupported-coverage",
      capability: "extended-evidence",
    });
    const texts = sourceGapTexts(payload("web-gather", sourcesWithGaps([lookalike, segmentMix])));

    expect(texts.some((text) => text.includes("sec-edgar"))).toBe(true);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("omits extendedEvidence when the producer omitted it, and keeps empty gaps as []", () => {
    const omitted = sourcesWithGaps(droppedGaps);
    expect(omitted.extendedEvidence).toBeUndefined();
    expect(collectedSourcesForGapView("web-gather", omitted).extendedEvidence).toBeUndefined();
    expect(payload("web-gather", omitted).extendedEvidence).toBeUndefined();
    expect(payload("all", omitted).extendedEvidence).toBeUndefined();

    const emptyGaps = sourcesWithGaps([], {
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: [],
      },
    });
    const filteredEmpty = collectedSourcesForGapView("web-gather", emptyGaps).extendedEvidence;
    expect(filteredEmpty).toEqual({
      instrument: { symbol: "AAPL", assetClass: "equity" },
      items: [],
      gaps: [],
    });
    expect(
      (payload("web-gather", emptyGaps).extendedEvidence as { readonly gaps: readonly SourceGap[] })
        .gaps,
    ).toEqual([]);
  });

  test("keeps extendedEvidence.gaps as [] when every row is dropped, rather than omitting the section", () => {
    const sources = sourcesWithGaps(droppedGaps, {
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: droppedGaps,
      },
    });
    const gather = payload("web-gather", sources);

    expect(gather).toHaveProperty("extendedEvidence");
    expect((gather.extendedEvidence as { readonly gaps: readonly SourceGap[] }).gaps).toEqual([]);
    expect(
      (payload("all", sources).extendedEvidence as { readonly gaps: readonly SourceGap[] }).gaps,
    ).toEqual(droppedGaps);
  });

  test("hides collectAnalystExpectations 403 estimate gaps from web-gather and keeps them on persisted surfaces", async () => {
    const result = await collectAnalystExpectations(
      analystCollectContext({
        token: "fixture-token",
        request: {
          json: async ({ adapter }) =>
            sourceGap({
              source: adapter,
              message: `${adapter} source request failed with status 403`,
              cause: "fetch-failed",
            }),
          text: async () => {
            throw new Error("unexpected text request");
          },
        },
      }),
    );
    const producerGaps = result.gaps;
    const sources = sourcesWithGaps(producerGaps);

    const gatherTexts = sourceGapTexts(payload("web-gather", sources));
    const allTexts = sourceGapTexts(payload("all", sources));
    const reportGaps = deterministicSourceGapEntries(command, sources).map((gap) => gap.text);

    expect(producerGaps.some((gap) => gap.source === "finnhub-eps-estimate")).toBe(true);
    expect(producerGaps.some((gap) => gap.source === "finnhub-revenue-estimate")).toBe(true);
    expect(producerGaps.some((gap) => gap.source === "finnhub-ebitda-estimate")).toBe(true);
    expect(gatherTexts.some((text) => text.includes("finnhub-eps-estimate"))).toBe(false);
    expect(gatherTexts.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(false);
    expect(gatherTexts.some((text) => text.includes("finnhub-ebitda-estimate"))).toBe(false);
    expect(allTexts.some((text) => text.includes("finnhub-eps-estimate"))).toBe(true);
    expect(allTexts.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(true);
    expect(allTexts.some((text) => text.includes("finnhub-ebitda-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-eps-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-ebitda-estimate"))).toBe(true);
    expect(collectedSourcesForGapView("all", sources)).toBe(sources);
    expect(sources.sourceGaps).toBe(producerGaps);
  });

  test("hides collectAnalystExpectations missing-credential estimate gaps from web-gather", async () => {
    const result = await collectAnalystExpectations(analystCollectContext({}));
    const producerGaps = result.gaps;
    const sources = sourcesWithGaps(producerGaps);
    const gatherTexts = sourceGapTexts(payload("web-gather", sources));
    const reportGaps = deterministicSourceGapEntries(command, sources).map((gap) => gap.text);

    expect(producerGaps.every((gap) => gap.cause === "missing-credential")).toBe(true);
    expect(gatherTexts.some((text) => text.includes("finnhub-eps-estimate"))).toBe(false);
    expect(gatherTexts.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(false);
    expect(gatherTexts.some((text) => text.includes("finnhub-ebitda-estimate"))).toBe(false);
    expect(reportGaps.some((text) => text.includes("finnhub-eps-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-revenue-estimate"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("finnhub-ebitda-estimate"))).toBe(true);
  });
});

describe("Web Gather historical Source Gap view", () => {
  test("loads three AMD prior runs through report assembly, the Run Artifact writer, and the production history reader", async () => {
    const fixture = await amdHistoryFixture();

    expect(fixture.history.runs.map((run) => run.runId)).toEqual([
      "amd-prior-1",
      "amd-prior-2",
      "amd-prior-3",
    ]);
    expect(fixture.reportGapTexts).toEqual([
      priorAmdReportGapTexts,
      priorAmdReportGapTexts,
      priorAmdReportGapTexts,
    ]);
    expect(fixture.history.runs.map((run) => run.dataGaps)).toEqual(
      fixture.reportGapTexts.map((gaps) => gaps.slice(0, historicalDataGapLimit)),
    );
  });

  test("exposes persisted historical gaps through markdown, Console, source-ID closure, and index/disk parity", async () => {
    const fixture = await amdHistoryFixture();
    const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
    const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;
    try {
      for (const runId of fixture.history.runs.map((run) => run.runId)) {
        const runDir = join(fixture.dataDir, runId);
        const raw = JSON.parse(
          await readFile(join(runDir, RUN_ARTIFACT_FILES.report), "utf8"),
        ) as unknown;
        const report = validateResearchReport(raw as ResearchReport);
        const readerReport = readReport(raw);
        expect(readerReport).toBeDefined();
        expect(readerReport?.dataGaps).toEqual(report.dataGaps);
        const markdown = await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8");
        const persistedGaps = JSON.parse(
          await readFile(join(runDir, RUN_ARTIFACT_FILES.sourceGaps), "utf8"),
        ) as readonly SourceGap[];
        const trace = JSON.parse(
          await readFile(join(runDir, RUN_ARTIFACT_FILES.trace), "utf8"),
        ) as RunTrace;
        expect(report.dataGaps).toEqual(priorAmdReportGapTexts);
        expect(report.summary).toBe(`${runId} AMD research summary.`);
        expect(persistedGaps.map((gap) => gap.source)).toEqual(
          priorAmdSourceGaps.map((gap) => gap.source),
        );
        expect(trace.sourceGaps).toEqual(priorAmdGapTexts);
        for (const prefix of excludedHistoricalPrefixes) {
          expect(report.dataGaps.some((gap) => gap.startsWith(`${prefix}:`))).toBe(true);
          expect(trace.sourceGaps.some((gap) => gap.startsWith(`${prefix}:`))).toBe(true);
        }
        expect(report.dataGaps.some((gap) => gap.includes("analyst-consensus"))).toBe(true);
        // Fixture wrote markdown via renderMarkdownReport; this pins report.json round-trip, not orchestrator.md production.
        expect(markdown).toBe(renderMarkdownReport(report));
        assertSourceIdClosure(raw, new Set(report.sources.map((source) => source.id)));

        const detail = await readRunDetail(fixture.dataDir, runId);
        expect(detail).toBeDefined();
        if (detail === undefined) {
          throw new Error(`missing run detail for ${runId}`);
        }
        const persistedSourceGaps = detail.sourceGaps;
        expect(persistedSourceGaps).toBeDefined();
        if (persistedSourceGaps === undefined) {
          throw new Error(`missing sourceGaps for ${runId}`);
        }
        expect(persistedGaps).toEqual(persistedSourceGaps);
        expect(detail.summary.availableFiles).not.toContain(RUN_ARTIFACT_FILES.evidenceBundle);
        expect(detail.markdown).toBe(markdown);
        const view = buildRunWorkspaceView(detail);
        expect(view.equityPresentation).toBeDefined();
        expect(view.report.summary).toBe(report.summary);
        expect(view.report.markdown).toBe(markdown);
        expect(view.report.findings.map((finding) => finding.text)).toEqual(
          report.keyFindings.map((finding) => finding.text),
        );
        expect(view.report.findings.map((finding) => finding.sourceIds)).toEqual(
          report.keyFindings.map((finding) => finding.sourceIds),
        );
        expect(view.sources.items.map((source) => source.id)).toEqual(
          report.sources.map((source) => source.id),
        );
        const { equityPresentation } = view;
        if (equityPresentation === undefined) {
          throw new Error(`missing equity presentation for ${runId}`);
        }
        for (const gap of report.dataGaps) {
          const triage = readGapTriage(gap, persistedSourceGaps, report.symbol);
          expect(view.gaps.triagedGaps.filter((item) => item.text === gap)).toHaveLength(1);
          expect(view.gaps.triagedGaps).toContainEqual({ text: gap, triage });
          const { materialGaps } = equityPresentation.defaultView;
          const { diagnosticGaps } = equityPresentation.advanced;
          if (triage === "material") {
            expect(materialGaps).toContain(gap);
            expect(diagnosticGaps).not.toContain(gap);
          } else {
            expect(diagnosticGaps).toContain(gap);
            expect(materialGaps).not.toContain(gap);
          }
        }
      }

      const dbPath = join(fixture.dataDir, "index.sqlite");
      process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
      delete process.env.MARKET_BOT_INDEX_DISABLE;
      await rebuildRunArtifactIndex(fixture.dataDir, { dbPath });
      const indexedSummaries = await listRunSummaries(fixture.dataDir);
      const indexedSearch = await searchRunReports(fixture.dataDir, {
        query: "finnhub-eps-estimate",
      });
      process.env.MARKET_BOT_INDEX_DISABLE = "1";
      const diskSummaries = await listRunSummaries(fixture.dataDir);
      const diskSearch = await searchRunReports(fixture.dataDir, {
        query: "finnhub-eps-estimate",
      });
      expect(indexedSummaries).toEqual(diskSummaries);
      expect(indexedSearch.map((entry) => entry.run.runId)).toEqual(
        diskSearch.map((entry) => entry.run.runId),
      );
      expect(indexedSearch.map((entry) => entry.run.runId)).toEqual([
        "amd-prior-1",
        "amd-prior-2",
        "amd-prior-3",
      ]);
    } finally {
      if (originalIndexDbPath === undefined) {
        delete process.env.MARKET_BOT_INDEX_DB_PATH;
      } else {
        process.env.MARKET_BOT_INDEX_DB_PATH = originalIndexDbPath;
      }
      if (originalIndexDisable === undefined) {
        delete process.env.MARKET_BOT_INDEX_DISABLE;
      } else {
        process.env.MARKET_BOT_INDEX_DISABLE = originalIndexDisable;
      }
    }
  });

  test("keeps current AMD Source Gap filtering in the actual Web Gather prompt", () => {
    const sources = amdSources([
      ...priorAmdSourceGaps.slice(0, excludedHistoricalPrefixes.length),
      amdAnalystConsensus,
      amdSegmentMix,
    ]);
    const texts = promptEvidence("web-gather", sources).sourceGaps as readonly string[];

    for (const prefix of excludedHistoricalPrefixes) {
      expect(texts.some((text) => text.startsWith(`${prefix}:`))).toBe(false);
    }
    expect(texts.some((text) => text.includes("analyst-consensus"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("hides only unambiguous historical Source Gap exclusions in the actual Web Gather prompt", async () => {
    const { history } = await amdHistoryFixture();
    const hiddenEdgeGaps = [
      `${amdAnalystConsensus.source}: ${amdAnalystConsensus.message}`,
      "finnhub-eps-estimate: issuer guidance missing from the public earnings release",
    ];
    const retainedEdgeGaps = [
      `${amdSegmentMix.source}: ${amdSegmentMix.message}`,
      "business-framework: Business Framework partial for AMD: analyst-consensus + segment-mix: mixed gap",
      "finnhub-operating-income-estimate: unknown estimate adapter gap",
      "sec-edgar: filing coverage mentions finnhub-eps-estimate mid-sentence",
      "business-framework: Business Framework partial for AMD: analyst-consensus: missing; segment-mix: revenue by segment unavailable",
      "business-framework: Business Framework partial for AMD: analyst-consensus: segment-mix: revenue by segment unavailable",
      "finnhub-eps-estimate: unavailable; sec-edgar: latest filing unavailable",
      "finnhub-eps-estimate:  ",
    ];
    const edgeRun = {
      ...history.runs[0]!,
      runId: "amd-edge-cases",
      sourceId: "history-report-amd-edge-cases",
      dataGaps: [...hiddenEdgeGaps, ...retainedEdgeGaps],
    };
    const input = { ...history, runs: [...history.runs, edgeRun] };
    const projected = promptEvidence("web-gather", amdSources(), input).historicalContext as {
      readonly runs: readonly { readonly dataGaps: readonly string[] }[];
    };

    expect(projected.runs.map((run) => run.dataGaps)).toEqual([
      ...history.runs.map((run) =>
        run.dataGaps.filter(
          (gap) => !excludedHistoricalPrefixes.some((prefix) => gap.startsWith(`${prefix}:`)),
        ),
      ),
      retainedEdgeGaps,
    ]);
  });

  test("keeps the complete-view prompt and input evidence bundle unchanged", async () => {
    const { history } = await amdHistoryFixture();
    const sources = amdSources();
    const sourcePlanning = assessSourcePlan(
      buildSourcePlan(amdCommand, "2026-09-19T00:00:00.000Z"),
      sources,
      "2026-09-19T00:00:00.000Z",
    );
    const bundle = buildDeepEquityEvidenceBundle({
      symbol: "AMD",
      analysisAsOf: "2026-09-19T00:00:00.000Z",
      collectedSources: sources,
      historicalContext: history,
      ...sourcePlanning,
    });
    const original = structuredClone(bundle);
    const originalBytes = JSON.stringify(bundle);
    const completeBefore = promptText(
      "evidence-request",
      sources,
      bundle.context.historicalContext,
    );

    promptText("web-gather", sources, bundle.context.historicalContext);
    const completeAfter = promptText("evidence-request", sources, bundle.context.historicalContext);
    const completeHistory = (
      JSON.parse(completeAfter) as {
        readonly evidence: {
          readonly historicalContext: { readonly runs: HistoricalResearchContext["runs"] };
        };
      }
    ).evidence.historicalContext;

    expect(completeAfter).toBe(completeBefore);
    expect(completeHistory.runs.map((run) => run.dataGaps)).toEqual(
      history.runs.map((run) => run.dataGaps),
    );
    expect(bundle).toEqual(original);
    expect(JSON.stringify(bundle)).toBe(originalBytes);
  });

  test("distinguishes absent history from empty history with retained producer disclosures", async () => {
    const sources = amdSources();
    const absentEvidence = promptEvidence("web-gather", sources);
    const dataDir = await mkdtemp(join(tmpdir(), "market-bot-web-gather-absent-history-"));
    const disclosures = [
      "No prior ticker runs found for AMD",
      "No prior equity market-update runs found",
      "Skipped 1 malformed historical report artifact(s)",
    ];
    try {
      const malformedDir = join(dataDir, "malformed");
      await mkdir(malformedDir);
      await writeFile(join(malformedDir, "report.json"), "{bad-json", "utf8");
      const reader = createSanitizedHistoricalContextReader(
        await createHistoricalContextReader(dataDir),
      );
      const loaded = await reader.load({
        command: amdCommand,
        config: {
          historyOptions: {
            tickerRecentLimit: 3,
            marketRecentLimit: 0,
            recentDays: 90,
            anchorMonths: [],
            missCorrectionLimit: 0,
          },
        },
        now: new Date("2026-09-19T00:00:00.000Z"),
      });
      const emptyEvidence = promptEvidence("web-gather", sources, loaded.context);
      const emptyProjected = emptyEvidence.historicalContext as {
        readonly runs: readonly unknown[];
        readonly gaps: readonly string[];
        readonly audit: HistoricalResearchContext["audit"];
      };

      expect(Object.hasOwn(absentEvidence, "historicalContext")).toBe(false);
      expect(Object.hasOwn(emptyEvidence, "historicalContext")).toBe(true);
      expect(loaded.context.runs).toEqual([]);
      expect(loaded.context.gaps).toEqual(disclosures);
      expect(loaded.context.audit).toMatchObject({ malformedRunCount: 1, gapCount: 3 });
      expect(emptyProjected.runs).toEqual([]);
      expect(emptyProjected.gaps).toEqual(disclosures);
      expect(emptyProjected.audit).toEqual(loaded.context.audit);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps a run and absent optional fields when every historical data gap is filtered", async () => {
    const { history } = await amdHistoryFixture();
    const { keyExtras: _keyExtras, ...runWithoutKeyExtras } = history.runs[0]!;
    const run = {
      ...runWithoutKeyExtras,
      dataGaps: priorAmdGapTexts.slice(0, excludedHistoricalPrefixes.length),
    };
    const input = {
      ...history,
      runs: [run],
      sources: history.sources.slice(0, 1),
    };
    const inputBytes = JSON.stringify(input);
    const gatherProjected = promptEvidence("web-gather", amdSources(), input).historicalContext as {
      readonly sourceIds: readonly string[];
      readonly runs: HistoricalResearchContext["runs"];
      readonly gaps: readonly string[];
      readonly audit: HistoricalResearchContext["audit"];
    };
    const completeProjected = promptEvidence("evidence-request", amdSources(), input)
      .historicalContext as {
      readonly runs: HistoricalResearchContext["runs"];
    };
    const projectedRun = gatherProjected.runs[0]!;

    expect(gatherProjected.runs).toHaveLength(1);
    expect(projectedRun).toEqual({ ...run, dataGaps: [] });
    expect(Object.hasOwn(projectedRun, "keyExtras")).toBe(false);
    expect(gatherProjected.sourceIds).toEqual([history.sources[0]!.id]);
    expect(gatherProjected.gaps).toEqual(history.gaps);
    expect(gatherProjected.audit).toEqual(history.audit);
    expect(completeProjected.runs).toEqual([run]);
    expect(JSON.stringify(input)).toBe(inputBytes);
  });
});
