import { describe, expect, test } from "bun:test";
import type { CollectedSources } from "../src/research/orchestrator";
import { buildRunAnalytics } from "../src/research/run-analytics";
import type { RunTrace } from "../src/domain/types";
import { marketSnapshot, newsSource, prediction, researchReport } from "./support/fixtures";

const trace: RunTrace = {
  runId: "run-1",
  jobType: "ticker",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
  provider: "mock",
  quickModel: "quick",
  synthesisModel: "synthesis",
  startedAt: "2026-05-19T00:00:00.000Z",
  completedAt: "2026-05-19T00:00:01.000Z",
  sourceGaps: ["marketaux-news: missing MARKET_BOT_MARKETAUX_API_TOKEN"],
  stages: ["source-collection", "specialist-analysis", "final-synthesis"],
  tokenEstimate: 300,
  costEstimateUsd: 0.03,
  evidenceRequestLoop: {
    rounds: 1,
    acceptedRequests: [
      {
        round: 1,
        tool: "sec_latest_filing",
        status: "accepted",
        sourceUnits: 3,
      },
    ],
    rejectedRequests: [],
    sourceUnitsUsed: 3,
    executedTools: ["sec_latest_filing"],
    emittedGaps: [],
  },
  domainPlaybooks: { selected: [], rejected: [] },
  predictionErrors: ["Unknown source ID: missing"],
  predictionRetryErrors: ["predictionShortfall: required 2, received 1"],
};

describe("run analytics", () => {
  test("summarizes deterministic source, evidence, news, prediction, and run metrics", () => {
    const collectedSources: CollectedSources = {
      rawSnapshots: [
        {
          id: "raw-marketaux",
          adapter: "marketaux-news",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          payload: {},
        },
      ],
      marketSnapshots: [marketSnapshot({ sourceId: "market-aapl" })],
      newsSources: [
        newsSource({
          id: "news-equity-1",
          provider: "marketaux",
          providerAliases: [{ provider: "marketaux" }, { provider: "finnhub" }],
        }),
      ],
      extendedSources: [],
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          {
            category: "sec-edgar",
            title: "SEC filing",
            summary: "Latest filing captured.",
            sourceIds: ["extended-sec-edgar"],
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        ],
        gaps: [{ source: "tradier-options", message: "missing MARKET_BOT_TRADIER_API_TOKEN" }],
      },
      sourceGaps: [{ source: "marketaux-news", message: "missing MARKET_BOT_MARKETAUX_API_TOKEN" }],
      newsAnalytics: {
        fetchedNewsSourcesByProvider: { marketaux: 2, finnhub: 1 },
        fetchedNewsSourceCount: 3,
        canonicalDedupedNewsSourceCount: 2,
        canonicalDuplicateNewsSourceCount: 1,
        persistentSuppressedNewsSourceCount: 1,
        repeatFallbackKeptCount: 0,
        selectedNewsSourceCount: 1,
        repeatFallbackUsed: false,
      },
    };
    const report = researchReport({
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      confidence: "medium",
      dataGaps: ["marketaux-news: missing MARKET_BOT_MARKETAUX_API_TOKEN"],
      predictions: [
        prediction({
          id: "pred-1",
          kind: "direction",
          horizonTradingDays: 5,
          sourceIds: ["market-aapl"],
        }),
        prediction({ id: "pred-2", kind: "iv", horizonTradingDays: 20, sourceIds: [] }),
      ],
      sources: [
        {
          id: "market-aapl",
          title: "AAPL market snapshot",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
          assetClass: "equity",
          symbol: "AAPL",
        },
        collectedSources.newsSources[0]!,
      ],
    });

    const analytics = buildRunAnalytics({
      report,
      trace,
      collectedSources,
      stageOutputs: [
        {
          stage: "specialist-analysis",
          content: "{}",
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        },
        {
          stage: "final-synthesis",
          content: "{}",
          tokenEstimate: 200,
          costEstimateUsd: 0.02,
        },
      ],
      minimumPredictions: 3,
    });

    expect(analytics.newsDedupe).toEqual({
      fetchedNewsSourcesByProvider: { marketaux: 2, finnhub: 1 },
      fetchedNewsSourceCount: 3,
      canonicalDedupedNewsSourceCount: 2,
      canonicalDuplicateNewsSourceCount: 1,
      persistentSuppressedNewsSourceCount: 1,
      repeatFallbackKeptCount: 0,
      selectedNewsSourceCount: 1,
      repeatFallbackUsed: false,
    });
    expect(analytics.sourceFunnel.sourceGaps.bySource).toEqual({ "marketaux-news": 1 });
    expect(analytics.sourceFunnel.sourceGapClasses).toEqual({
      fetchFailed: 0,
      missingCredential: 1,
      other: 0,
    });
    expect(analytics.evidenceQuality.extendedEvidence.itemsByCategory).toEqual({ "sec-edgar": 1 });
    expect(analytics.predictions).toMatchObject({
      count: 2,
      retryErrorCount: 1,
      validationErrorCount: 1,
      byKind: { direction: 1, iv: 1 },
      citedCount: 1,
      uncitedCount: 1,
      minimumRequired: 3,
      minimumMet: false,
    });
    expect(analytics.runShape.stages).toEqual([
      { stage: "specialist-analysis", tokenEstimate: 100, costEstimateUsd: 0.01 },
      { stage: "final-synthesis", tokenEstimate: 200, costEstimateUsd: 0.02 },
    ]);
    expect(analytics.runShape.durationMs).toBe(1000);
    expect(analytics.evidenceQuality.evidenceRequestLoop).toEqual({
      rounds: 1,
      acceptedRequestCount: 1,
      rejectedRequestCount: 0,
      sourceUnitsUsed: 3,
      executedTools: ["sec_latest_filing"],
      emittedGapCount: 0,
    });
  });
});
