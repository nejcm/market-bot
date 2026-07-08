import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config";
import type { ModelProvider } from "../src/model/types";
import { runEvidenceRequestLoop } from "../src/research/evidence-request-loop";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import { runMarketUpdatePhase } from "../src/research/market-update-phase";
import type { ResearchContext } from "../src/research/research-context";
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
    modelParams: undefined,
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

describe("research phase seams", () => {
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
});
