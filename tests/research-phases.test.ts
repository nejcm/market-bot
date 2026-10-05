import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import type { ModelProvider } from "../src/model/types";
import { runAnalysisPhase } from "../src/research/analysis-phase";
import { runEvidenceRequestLoop } from "../src/research/evidence-request-loop";
import { runFinancialTableExtractionPhase } from "../src/research/financial-table-extraction-phase";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type { StageOutput } from "../src/research/final-synthesis";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import { runMarketUpdatePhase } from "../src/research/market-update-phase";
import type { ResearchContext } from "../src/research/research-context-types";
import { collectedSources, marketSnapshot } from "./support/fixtures";
import { secEvidenceFetch } from "./support/orchestrator-helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "market-bot-research-phases-"));
  tempDirs.push(dir);
  return dir;
}

function configFor(dataDir = "data/runs"): AppConfig {
  return {
    provider: "openai",
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    modelTimeoutMs: 120_000,
    dataDir,
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      secUserAgent: "market-bot test@example.test",
    },
    evidenceRequestOptions: { maxRounds: 1, maxToolCalls: 1, sourceBudget: 5 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
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
      secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
  };
}

const context: ResearchContext = {
  analysisAsOf: "2026-05-19T00:00:00.000Z",
  depthProfile: {
    depth: "deep",
    analystStyle: "fuller analyst-style",
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["AAPL"],
    focus: [],
    targetKindMix: { favored: ["direction"] },
  },
  runParams: {
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    quickModelParams: undefined,
    synthesisModelParams: undefined,
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["AAPL"],
    focus: [],
    analystStyle: "fuller analyst-style",
    targetKindMix: { favored: ["direction"] },
  },
  marketRegime: {
    assetClass: "equity",
    label: "insufficient-data",
    proxyCount: 0,
    drivers: [],
    sourceIds: [],
  },
  calibrationContext: undefined,
};

const historicalContext: HistoricalResearchContext = {
  generatedAt: "2026-05-19T00:00:00.000Z",
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

const NBIS_PAIR_FS = "0001104659-26-094844";
const NBIS_PAIR_SUBMISSIONS = {
  cik: "0001513845",
  filings: {
    recent: {
      form: ["6-K", "6-K", "6-K", "6-K", "6-K", "20-F"],
      filingDate: [
        "2026-08-18",
        "2026-08-15",
        "2026-08-12",
        "2026-08-12",
        "2026-05-20",
        "2026-04-30",
      ],
      reportDate: [
        "2026-08-18",
        "2026-08-15",
        "2026-08-12",
        "2026-08-12",
        "2026-03-31",
        "2025-12-31",
      ],
      accessionNumber: [
        "0001104659-26-096002",
        "0001104659-26-095001",
        NBIS_PAIR_FS,
        "0001104659-26-094568",
        "0001104659-26-064092",
        "0001104659-26-052948",
      ],
      primaryDocument: [
        "tm2623002d1_6k.htm",
        "tm2623001d1_6k.htm",
        "nbis-20260812x6k.htm",
        "tm2622968d1_6k.htm",
        "nbis-20260331x6k.htm",
        "nbis-20251231x20f.htm",
      ],
    },
  },
};

function nbisPairFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("company_tickers")) {
    return Promise.resolve(
      Response.json({ "0": { cik_str: 1_513_845, ticker: "NBIS", title: "Nebius Group N.V." } }),
    );
  }
  if (url.includes("submissions")) {
    return Promise.resolve(Response.json(NBIS_PAIR_SUBMISSIONS));
  }
  if (url.endsWith("nbis-20260812x6k.htm")) {
    return Promise.resolve(
      new Response(
        "Furnished as Exhibit 99.2 are the Unaudited Condensed Consolidated Financial Statements for the Three and Six Months Ended June 30, 2026.",
      ),
    );
  }
  if (url.endsWith("tm2622968d1_6k.htm")) {
    return Promise.resolve(
      new Response(
        "Filed as Exhibit 99.1 is a press release announcing unaudited consolidated financial results for the second quarter ended June 30, 2026.",
      ),
    );
  }
  if (url.includes("tm262300")) {
    return Promise.resolve(
      new Response("Furnished as Exhibit 99.1 is a press release announcing a new data center."),
    );
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function nbisStatements() {
  return deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [
                {
                  val: 200_000_000,
                  form: "20-F",
                  accn: "annual",
                  filed: "2026-04-30",
                  start: "2025-01-01",
                  end: "2025-12-31",
                  fy: 2025,
                  fp: "FY",
                },
              ],
            },
          },
        },
      },
    },
    {
      symbol: "NBIS",
      generatedAt: "2026-08-20T00:00:00.000Z",
      analysisAsOf: "2026-08-20T00:00:00.000Z",
      sourceId: "sec-facts",
      submissionsPayload: NBIS_PAIR_SUBMISSIONS,
      submissionsSourceId: "sec-submissions",
    },
  );
}

describe("research phase seams", () => {
  test("hands every results-cover 6-K from filing evidence to untagged discovery", async () => {
    const evidence = await runEvidenceRequestLoop({
      command: { jobType: "equity", assetClass: "equity", symbol: "NBIS", depth: "deep" },
      config: configFor(await tempDataDir()),
      collectedSources: collectedSources({ marketSnapshots: [marketSnapshot({ symbol: "NBIS" })] }),
      context,
      now: new Date("2026-08-20T00:00:00.000Z"),
      fetchImpl: nbisPairFetch,
      retryDelaysMs: [],
      generateRound: async () => ({
        stage: "evidence-request",
        content: JSON.stringify({ requests: [] }),
        tokenEstimate: 10,
      }),
    });
    const indexUrls: string[] = [];

    await runFinancialTableExtractionPhase({
      symbol: "NBIS",
      generatedAt: "2026-08-20T00:00:00.000Z",
      collectedSources: {
        ...evidence.collectedSources,
        rawSnapshots: [
          ...evidence.collectedSources.rawSnapshots,
          {
            id: "sec-submissions",
            adapter: "sec-submissions",
            fetchedAt: "2026-08-20T00:00:00.000Z",
            payload: NBIS_PAIR_SUBMISSIONS,
          },
        ],
        financialStatements: nbisStatements(),
      },
      executionPolicy: { enabled: true },
      collect: {
        request: {
          json: async () => {
            throw new Error("unexpected JSON request");
          },
          text: async (request) => {
            indexUrls.push(request.url.split("/").at(-1) ?? "");
            return { source: "sec-filing-index", message: "fixture miss" };
          },
        },
      },
      generateMapping: async () => {
        throw new Error("unexpected mapping");
      },
    });

    // The report keeps only the press release; the statements sibling still reaches discovery.
    expect(
      evidence.collectedSources.extendedEvidence?.items.map(
        (item) => item.metrics?.accessionNumber,
      ),
    ).not.toContain(NBIS_PAIR_FS);
    expect(indexUrls).toEqual([
      `${NBIS_PAIR_FS}-index.html`,
      "0001104659-26-094568-index.html",
      "0001104659-26-064092-index.html",
    ]);
  });

  test("evidence request phase retrieves required SEC evidence without a model round", async () => {
    let generated = 0;

    const result = await runEvidenceRequestLoop({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: configFor(),
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: secEvidenceFetch,
      retryDelaysMs: [],
      generateRound: async () => {
        generated += 1;
        return {
          stage: "evidence-request",
          content: JSON.stringify({ requests: [] }),
          tokenEstimate: 10,
        };
      },
    });

    expect(generated).toBe(0);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit).toMatchObject({
      rounds: 0,
      acceptedRequests: [],
      rejectedRequests: [],
      sourceUnitsUsed: 0,
      executedTools: ["sec_latest_filing"],
    });
    expect(result.collectedSources.extendedSources.map((source) => source.id)).toEqual([
      "extended-sec-edgar-aapl-10q",
    ]);
    expect(result.collectedSources.extendedEvidence?.items[0]?.category).toBe("sec-edgar");
  });

  test("evidence request phase emits unsupported-coverage gap for non-US SEC coverage", async () => {
    let generated = 0;

    const result = await runEvidenceRequestLoop({
      command: { jobType: "equity", assetClass: "equity", symbol: "RR.L", depth: "deep" },
      config: configFor(),
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "RR.L" })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: async () => {
        throw new Error("non-US SEC coverage must not fetch");
      },
      retryDelaysMs: [],
      generateRound: async () => {
        generated += 1;
        return {
          stage: "evidence-request",
          content: JSON.stringify({ requests: [] }),
          tokenEstimate: 10,
        };
      },
    });

    expect(generated).toBe(0);
    expect(result.stageOutputs).toEqual([]);
    expect(result.audit?.rounds).toBe(0);
    expect(result.audit?.emittedGaps).toContainEqual(
      expect.objectContaining({
        source: "sec-edgar",
        cause: "unsupported-coverage",
        message: expect.stringContaining("RR.L"),
      }),
    );
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "sec-edgar",
        cause: "unsupported-coverage",
      }),
    );
  });

  test("evidence request phase emits malformed SourceGap and stops after invalid JSON", async () => {
    let generated = 0;

    const result = await runEvidenceRequestLoop({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...configFor(),
        sourceOptions: { ...configFor().sourceOptions, tradierApiToken: "tradier-token" },
      },
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ symbol: "AAPL" })],
      }),
      context,
      now: new Date("2026-05-19T00:00:00.000Z"),
      fetchImpl: secEvidenceFetch,
      retryDelaysMs: [],
      generateRound: async () => {
        generated += 1;
        return {
          stage: "evidence-request",
          content: "not-json",
          tokenEstimate: 10,
        };
      },
    });

    expect(generated).toBe(1);
    expect(result.stageOutputs).toHaveLength(1);
    expect(result.audit?.rounds).toBe(1);
    expect(result.audit?.emittedGaps).toContainEqual(
      expect.objectContaining({
        source: "evidence-request",
        cause: "malformed-response",
        message: "Evidence request stage returned invalid JSON",
      }),
    );
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "evidence-request",
        cause: "malformed-response",
      }),
    );
  });

  test("market update phase refreshes spotlight context and emits movers at its interface", async () => {
    const loads: string[][] = [];
    const dataDir = await tempDataDir();
    const provider: ModelProvider = {
      name: "mock",
      generate: async () => ({
        content: JSON.stringify({
          rationale: "focus on the largest current mover",
          selections: [{ symbol: "NVDA", rationale: "largest move" }],
        }),
        tokenEstimate: 10,
      }),
    };
    const sources = collectedSources({
      marketSnapshots: [
        marketSnapshot({
          sourceId: "market-nvda",
          symbol: "NVDA",
          changePercent24h: 5,
          volume: 3_000_000,
        }),
        marketSnapshot({
          sourceId: "market-aapl",
          symbol: "AAPL",
          changePercent24h: 2,
          volume: 2_000_000,
        }),
      ],
    });

    const result = await runMarketUpdatePhase({
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
      },
      config: configFor(dataDir),
      provider,
      collectedSources: sources,
      context,
      historicalContext,
      historicalContextReader: {
        load: async (input) => {
          loads.push([...(input.spotlightSymbols ?? [])]);
          return { context: historicalContext, modelInputSanitization: { entries: [] } };
        },
        findForecastPersistenceBaseline: (): undefined => {},
      },
      alpha: {},
      alphaGaps: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(loads).toEqual([["NVDA", "AAPL"], ["NVDA"]]);
    expect(result.spotlightSelection?.selected.map((item) => item.symbol)).toEqual(["NVDA"]);
    expect(result.context.spotlightCandidates?.map((candidate) => candidate.symbol)).toEqual([
      "NVDA",
    ]);
    expect(result.marketUpdateMovers?.map((mover) => mover.snapshot.symbol)).toEqual([
      "NVDA",
      "AAPL",
    ]);
    expect(result.context.marketUpdateDelta?.hasBaseline).toBe(false);
  });

  test("analysis phase exposes stage ordering and prior-stage handoff", async () => {
    const calls: { readonly stage: string; readonly priorStages: readonly string[] }[] = [];

    const result = await runAnalysisPhase({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      collectedSources: collectedSources(),
      context,
      quickModel: "quick-test",
      runStage: async (stage, model, stageInput): Promise<StageOutput> => {
        expect(model).toBe("quick-test");
        calls.push({
          stage,
          priorStages: stageInput.priorStages?.map((item) => item.stage) ?? [],
        });
        return { stage, content: JSON.stringify({ stage }), tokenEstimate: 1 };
      },
    });

    expect(result.analysisOutputs.map((output) => output.stage)).toEqual([
      "specialist-analysis",
      "instrument-evidence-analysis",
      "market-behavior-analysis",
    ]);
    expect(result.critiqueOutput.stage).toBe("critique");
    expect(calls).toEqual([
      { stage: "specialist-analysis", priorStages: [] },
      { stage: "instrument-evidence-analysis", priorStages: ["specialist-analysis"] },
      { stage: "market-behavior-analysis", priorStages: ["specialist-analysis"] },
      {
        stage: "critique",
        priorStages: [
          "specialist-analysis",
          "instrument-evidence-analysis",
          "market-behavior-analysis",
        ],
      },
    ]);
  });
});
