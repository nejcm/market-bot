import { describe, expect, test } from "bun:test";
import { buildRunAnalytics } from "../src/research/run-analytics";
import { sourceGap } from "../src/domain/source-gaps";
import type { RunTrace } from "../src/domain/types";
import type { CollectedSources } from "../src/sources/types";
import {
  collectedSources as collectedSourceBundle,
  marketSnapshot,
  newsSource,
  prediction,
  researchReport,
} from "./support/fixtures";

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
    const collectedSources: CollectedSources = collectedSourceBundle({
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
        gaps: [
          sourceGap({
            source: "tradier-options",
            message: "missing MARKET_BOT_TRADIER_API_TOKEN",
            cause: "missing-credential",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      },
      sourceGaps: [
        sourceGap({
          source: "marketaux-news",
          message: "missing MARKET_BOT_MARKETAUX_API_TOKEN",
          cause: "missing-credential",
          evidenceQualityImpact: "core-cap",
        }),
      ],
      verifiedMarketSnapshot: {
        symbol: "AAPL",
        assetClass: "equity",
        analysisDate: "2026-05-19",
        fetchedAt: "2026-05-19T00:00:00.000Z",
        latestSessionDate: "2026-05-17",
        ohlcv: { date: "2026-05-17", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
        indicators: {
          ema10: null,
          sma50: null,
          sma200: null,
          rsi14: null,
          macd: null,
          macdSignal: null,
          macdHistogram: null,
          bollUpper: null,
          bollMiddle: null,
          bollLower: null,
          atr14: null,
        },
        recentCloses: [
          { date: "2026-05-16", close: 1 },
          { date: "2026-05-17", close: 1.5 },
        ],
      },
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
    });
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
      targetPredictions: 3,
      sourcePlanSummary: {
        plannedLaneCount: 5,
        requiredLaneCount: 2,
        optionalLaneCount: 3,
        coveredLaneCount: 3,
        gapLaneCount: 1,
        requiredGapLaneCount: 1,
        sourceCount: 4,
        gapCount: 1,
        coverageRatio: 0.6,
      },
      calibrationContext: {
        generatedAt: "2026-05-18T00:00:00.000Z",
        resolvedCount: 12,
        byAssetClass: { equity: { brierScore: 0.2, count: 8 } },
        byJobType: { ticker: { brierScore: 0.22, count: 6 } },
      },
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
      targetCount: 3,
      targetMet: false,
      shortfall: {
        emittedCount: 2,
        targetCount: 3,
        missingCount: 1,
        disclosed: false,
      },
    });
    expect(analytics.calibrationAtGeneration).toMatchObject({
      generatedAt: "2026-05-18T00:00:00.000Z",
      resolvedCount: 12,
      assetClass: {
        key: "equity",
        brierScore: 0.2,
        brierSkillScore: 0.199_999_999_999_999_96,
        count: 8,
      },
      jobType: { key: "ticker", brierScore: 0.22, brierSkillScore: 0.12, count: 6 },
    });
    expect(analytics.verifiedMarketSnapshot).toEqual({
      symbol: "AAPL",
      analysisDate: "2026-05-19",
      latestSessionDate: "2026-05-17",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      latestSessionAgeDays: 2,
    });
    expect(analytics.sourcePlan).toEqual({
      plannedLaneCount: 5,
      requiredLaneCount: 2,
      optionalLaneCount: 3,
    });
    expect(analytics.evidenceLanes).toEqual({
      coveredLaneCount: 3,
      gapLaneCount: 1,
      requiredGapLaneCount: 1,
      sourceCount: 4,
      gapCount: 1,
      coverageRatio: 0.6,
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

describe("forecast quality telemetry (3.2)", () => {
  const baseTrace: RunTrace = {
    runId: "run-q",
    jobType: "ticker",
    assetClass: "equity",
    symbol: "AAPL",
    depth: "brief",
    provider: "mock",
    quickModel: "quick",
    synthesisModel: "synthesis",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:01.000Z",
    sourceGaps: [],
    stages: ["specialist-analysis", "final-synthesis"],
    tokenEstimate: 100,
    costEstimateUsd: 0.01,
    domainPlaybooks: { selected: [], rejected: [] },
  };

  const aaplSource = {
    id: "src-1",
    title: "AAPL market snapshot",
    fetchedAt: "2026-05-19T00:00:00.000Z",
    kind: "market-data" as const,
    assetClass: "equity" as const,
    symbol: "AAPL",
  };

  function predictionsFor(
    preds: ReturnType<typeof prediction>[],
  ): ReturnType<typeof buildRunAnalytics>["predictions"] {
    return buildRunAnalytics({
      report: researchReport({
        jobType: "ticker",
        assetClass: "equity",
        symbol: "AAPL",
        predictions: preds,
        sources: [aaplSource],
      }),
      trace: baseTrace,
      collectedSources: collectedSourceBundle(),
      stageOutputs: [],
      targetPredictions: preds.length,
    }).predictions;
  }

  test("straddling set produces correct nearBaseRateCount and informativeCount", () => {
    // P1 and p2 are near base rate (within 0.05 of 0.5); p3 and p4 are informative.
    // P4 uses range kind so the set is not all-direction and the direction warning stays silent.
    const preds = [
      prediction({ id: "p1", probability: 0.5 }),
      prediction({ id: "p2", probability: 0.54 }),
      prediction({ id: "p3", probability: 0.56 }),
      prediction({
        id: "p4",
        kind: "range",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [170, 230]",
        probability: 0.4,
      }),
    ];
    const result = predictionsFor(preds);
    expect(result.nearBaseRateCount).toBe(2);
    expect(result.informativeCount).toBe(2);
    expect(result.signalTargetMet).toBe(true);
    expect(result.mixWarnings).toHaveLength(0);
  });

  test("near-base-rate band includes exact 0.45 and 0.55 boundaries", () => {
    const preds = [
      prediction({ id: "p1", probability: 0.45 }),
      prediction({ id: "p2", probability: 0.5 }),
      prediction({ id: "p3", probability: 0.55 }),
      prediction({ id: "p4", probability: 0.44 }),
      prediction({ id: "p5", probability: 0.56 }),
    ];
    const result = predictionsFor(preds);
    expect(result.nearBaseRateCount).toBe(3);
    expect(result.informativeCount).toBe(2);
    expect(result.signalTargetMet).toBe(false);
  });

  test("all-near-0.5 set yields signalTargetMet: false and a mix warning, but count unchanged", () => {
    const preds = [
      prediction({ id: "p1", probability: 0.5 }),
      prediction({
        id: "p2",
        subject: "QQQ",
        measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
        probability: 0.52,
      }),
      prediction({
        id: "p3",
        subject: "^VIX",
        measurableAs: "close(^VIX, +5) > close(^VIX, 0)",
        probability: 0.48,
      }),
    ];
    const result = predictionsFor(preds);
    expect(result.nearBaseRateCount).toBe(3);
    expect(result.informativeCount).toBe(0);
    expect(result.signalTargetMet).toBe(false);
    // All 3 predictions must still be emitted — telemetry never rejects
    expect(result.count).toBe(3);
    expect(result.mixWarnings.some((w) => w.includes("base rate"))).toBe(true);
  });

  test("all-direction set produces direction-only mix warning", () => {
    const preds = [
      prediction({ id: "p1", kind: "direction", probability: 0.65 }),
      prediction({
        id: "p2",
        kind: "direction",
        subject: "QQQ",
        measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
        probability: 0.7,
      }),
    ];
    const result = predictionsFor(preds);
    expect(result.mixWarnings.some((w) => w.includes("direction kind"))).toBe(true);
  });

  test("mixed kinds do not produce direction-only mix warning", () => {
    const preds = [
      prediction({ id: "p1", kind: "direction", probability: 0.65 }),
      prediction({
        id: "p2",
        kind: "range",
        subject: "AAPL",
        measurableAs: "close(AAPL, +5) outside [170, 230]",
        probability: 0.6,
      }),
    ];
    const result = predictionsFor(preds);
    expect(result.mixWarnings.every((w) => !w.includes("direction kind"))).toBe(true);
  });

  test("zero predictions yields signalTargetMet: true with empty warnings", () => {
    const result = predictionsFor([]);
    expect(result.nearBaseRateCount).toBe(0);
    expect(result.informativeCount).toBe(0);
    expect(result.signalTargetMet).toBe(true);
    expect(result.mixWarnings).toHaveLength(0);
  });
});
