import { describe, expect, test } from "bun:test";
import { reportSearchCandidates } from "../app/report-artifact-view";
import {
  calibrationAutopsyCauses,
  calibrationHeadline,
  calibrationSampleWarning,
  calibrationSlices,
  alphaCohortHeadline,
  alphaRejectionBucketRows,
  alphaStaleLeadRows,
  businessFrameworkView,
  closeLinePoints,
  dashboardMetrics,
  extendedEvidenceItems,
  financialLensMetricTiles,
  financialLensStatTiles,
  forecastDisagreements,
  forecastGroups,
  filterRuns,
  forecastRollup,
  formatClose,
  horizonMarkers,
  predictionScores,
  predictionTargetHealth,
  scoredForecasts,
  groupedRunsByType,
  groupedSearchResults,
  historicalContextAuditView,
  matchesQuery,
  predictions,
  providerHealthRows,
  recentRunSummaries,
  reliabilityBins,
  runCountsLabel,
  runCompareCards,
  runIdFromPathname,
  runLabel,
  runPath,
  runTrend,
  sources,
  formatShortfallGap,
  splitDataGaps,
  textItems,
  tradingViewSymbol,
  tradingViewUrl,
  valuationMetricTiles,
  verifiedSnapshotView,
  webSubjectProfileView,
  instrumentFromPathname,
  instrumentPath,
} from "../app/client/view-model";

describe("research console app view model", () => {
  test("round-trips instrument routes with normalized symbols", () => {
    const pathname = instrumentPath("equity", "nvda");

    expect(pathname).toBe("/instruments/equity/NVDA");
    expect(instrumentFromPathname(pathname)).toEqual({ assetClass: "equity", symbol: "NVDA" });
  });

  test("matches run summaries by searchable fields", () => {
    const run = {
      runId: "run-1",
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
      confidence: "high",
      findingCount: 0,
      predictionCount: 0,
      sourceCount: 0,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    };

    expect(matchesQuery(run, "aapl")).toBe(true);
    expect(matchesQuery(run, "crypto")).toBe(false);
    expect(runLabel(run)).toBe("equity / AAPL");
  });

  test("formats sidebar run counts as a compact mono label", () => {
    expect(
      runCountsLabel({
        runId: "run-1",
        findingCount: 5,
        predictionCount: 4,
        sourceCount: 9,
        dataGapCount: 3,
        hasScore: false,
        availableFiles: [],
      }),
    ).toBe("5 fnd · 4 fct · 3 gap");
  });

  test("filters runs by job type and search query together", () => {
    const baseRun = {
      runId: "run-1",
      findingCount: 0,
      predictionCount: 0,
      sourceCount: 0,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    };
    const runs = [
      { ...baseRun, runId: "ticker-aapl", jobType: "equity", symbol: "AAPL" },
      { ...baseRun, runId: "ticker-msft", jobType: "equity", symbol: "MSFT" },
      { ...baseRun, runId: "daily-1", jobType: "daily" },
      { ...baseRun, runId: "untyped-1" },
    ];

    expect(filterRuns(runs, "all", "")).toEqual(runs);
    expect(filterRuns(runs, "equity", "").map((run) => run.runId)).toEqual([
      "ticker-aapl",
      "ticker-msft",
    ]);
    expect(filterRuns(runs, "equity", "aapl").map((run) => run.runId)).toEqual(["ticker-aapl"]);
    expect(filterRuns(runs, "run", "").map((run) => run.runId)).toEqual(["untyped-1"]);
    expect(filterRuns(runs, "daily", "aapl")).toEqual([]);
  });

  test("derives provider health rows from route gap counts", () => {
    expect(providerHealthRows({})).toEqual([]);
    expect(providerHealthRows({ summary: { routes: "broken" } })).toEqual([]);

    expect(
      providerHealthRows({
        summary: {
          routes: [
            {
              provider: "yahoo",
              route: "quote/daily",
              total: 12,
              fetchFailed: 2,
              yahooAuth: 1,
              sampleMessages: ["auth expired"],
            },
            { provider: "stooq", route: "eod", total: 8 },
            "malformed",
            { route: 42, total: "many", sampleMessages: [7] },
          ],
        },
      }),
    ).toEqual([
      {
        provider: "yahoo",
        route: "quote/daily",
        degraded: true,
        total: 12,
        gaps: 3,
        note: "auth expired",
      },
      {
        provider: "stooq",
        route: "eod",
        degraded: false,
        total: 8,
        gaps: 0,
        note: "",
      },
      {
        provider: "unknown",
        route: "",
        degraded: false,
        total: 0,
        gaps: 0,
        note: "",
      },
    ]);
  });

  test("parses selected run ids from client routes", () => {
    expect(runIdFromPathname("/")).toBeUndefined();
    expect(runIdFromPathname("/settings")).toBeUndefined();
    expect(runIdFromPathname("/runs/run-1")).toBe("run-1");
    expect(runIdFromPathname("/runs/")).toBeUndefined();
    expect(runIdFromPathname("/runs/run-1/files")).toBeUndefined();
  });

  test("round-trips run ids through client run paths", () => {
    const runId = "daily run+alpha";

    expect(runPath(runId)).toBe("/runs/daily%20run%2Balpha");
    expect(runIdFromPathname(runPath(runId))).toBe(runId);
    expect(runIdFromPathname("/runs/%")).toBeUndefined();
  });

  test("returns the five newest run summaries from the current order", () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({
      runId: `run-${String(index + 1)}`,
      findingCount: 0,
      predictionCount: 0,
      sourceCount: 0,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    }));

    expect(recentRunSummaries(runs).map((run) => run.runId)).toEqual([
      "run-1",
      "run-2",
      "run-3",
      "run-4",
      "run-5",
    ]);
    expect(recentRunSummaries(runs, 2).map((run) => run.runId)).toEqual(["run-1", "run-2"]);
  });

  test("groups run summaries by preferred job type order", () => {
    const baseRun = {
      runId: "run-1",
      findingCount: 0,
      predictionCount: 0,
      sourceCount: 0,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    };

    expect(
      groupedRunsByType([
        { ...baseRun, runId: "ticker-1", jobType: "equity" },
        { ...baseRun, runId: "daily-1", jobType: "daily" },
        { ...baseRun, runId: "weekly-1", jobType: "weekly" },
        { ...baseRun, runId: "ticker-2", jobType: "equity" },
        { ...baseRun, runId: "unknown-1" },
      ]),
    ).toEqual([
      {
        type: "daily",
        runs: [{ ...baseRun, runId: "daily-1", jobType: "daily" }],
      },
      {
        type: "weekly",
        runs: [{ ...baseRun, runId: "weekly-1", jobType: "weekly" }],
      },
      {
        type: "equity",
        runs: [
          { ...baseRun, runId: "ticker-1", jobType: "equity" },
          { ...baseRun, runId: "ticker-2", jobType: "equity" },
        ],
      },
      {
        type: "run",
        runs: [{ ...baseRun, runId: "unknown-1" }],
      },
    ]);
  });

  test("narrows report sections without throwing on malformed entries", () => {
    const blockedScheme = "javascript";
    const report = {
      keyFindings: [{ text: "Finding", sourceIds: ["s1", 7] }, { text: 4 }],
      predictions: [
        {
          id: "p1",
          claim: "SPY closes higher.",
          kind: "direction",
          probability: 0.6,
          horizonTradingDays: 5,
          sourceIds: ["s1"],
        },
      ],
      sources: [
        {
          id: "s1",
          title: "Source",
          kind: "news",
          provider: "yahoo",
          url: "https://example.test/source",
        },
        { id: "s2", title: "Blocked", url: `${blockedScheme}:alert(1)` },
        { id: "bad" },
      ],
    };

    expect(textItems(report, "keyFindings")).toEqual([{ text: "Finding", sourceIds: ["s1"] }]);
    expect(predictions(report)).toEqual([
      {
        id: "p1",
        claim: "SPY closes higher.",
        kind: "direction",
        probability: 0.6,
        horizonTradingDays: 5,
        sourceIds: ["s1"],
      },
    ]);
    expect(sources(report)).toEqual([
      {
        id: "s1",
        title: "Source",
        kind: "news",
        provider: "yahoo",
        url: "https://example.test/source",
      },
      { id: "s2", title: "Blocked" },
    ]);
  });

  test("groups structured search results by run", () => {
    const firstRun = {
      runId: "run-1",
      findingCount: 0,
      predictionCount: 0,
      sourceCount: 0,
      dataGapCount: 0,
      hasScore: false,
      availableFiles: [],
    };
    const secondRun = { ...firstRun, runId: "run-2" };

    expect(
      groupedSearchResults([
        { run: firstRun, section: "summary", label: "Summary", snippet: "one", sourceIds: [] },
        {
          run: firstRun,
          section: "sources",
          label: "Source s1",
          snippet: "two",
          sourceIds: ["s1"],
        },
        {
          run: secondRun,
          section: "dataGaps",
          label: "Data gap 1",
          snippet: "three",
          sourceIds: [],
        },
      ]),
    ).toEqual([
      {
        run: firstRun,
        results: [
          { run: firstRun, section: "summary", label: "Summary", snippet: "one", sourceIds: [] },
          {
            run: firstRun,
            section: "sources",
            label: "Source s1",
            snippet: "two",
            sourceIds: ["s1"],
          },
        ],
      },
      {
        run: secondRun,
        results: [
          {
            run: secondRun,
            section: "dataGaps",
            label: "Data gap 1",
            snippet: "three",
            sourceIds: [],
          },
        ],
      },
    ]);
  });

  test("calculates dashboard totals across mixed run history", () => {
    const runs = [
      {
        runId: "equity-1",
        assetClass: "equity",
        confidence: "high",
        findingCount: 2,
        predictionCount: 3,
        sourceCount: 5,
        dataGapCount: 1,
        hasScore: true,
        availableFiles: [],
      },
      {
        runId: "crypto-1",
        assetClass: "crypto",
        confidence: "low",
        findingCount: 1,
        predictionCount: 2,
        sourceCount: 4,
        dataGapCount: 3,
        hasScore: false,
        availableFiles: [],
      },
    ];

    expect(dashboardMetrics(runs)).toEqual({
      totalRuns: 2,
      totalSources: 9,
      totalForecasts: 5,
      totalDataGaps: 4,
      scoredRuns: 1,
      equityRuns: 1,
      cryptoRuns: 1,
      averageConfidence: "medium",
    });
  });

  test("builds compare cards from run analytics", () => {
    expect(
      runCompareCards([
        {
          summary: {
            runId: "run-1",
            generatedAt: "2026-06-12T10:00:00Z",
            jobType: "equity",
            assetClass: "equity",
            symbol: "AAPL",
            findingCount: 0,
            predictionCount: 2,
            sourceCount: 3,
            dataGapCount: 1,
            hasScore: false,
            availableFiles: [],
          },
          analytics: {
            predictions: {
              count: 2,
              targetCount: 3,
              targetMet: false,
              shortfall: { missingCount: 1, disclosed: true },
            },
            calibrationAtGeneration: {
              jobType: { key: "equity", brierScore: 0.2, brierSkillScore: 0.2, count: 8 },
            },
            verifiedMarketSnapshot: {
              symbol: "AAPL",
              latestSessionAgeDays: 1,
            },
          },
        },
        {
          summary: {
            runId: "run-2",
            findingCount: 0,
            predictionCount: 0,
            sourceCount: 0,
            dataGapCount: 0,
            hasScore: false,
            availableFiles: [],
          },
        },
      ]),
    ).toEqual([
      {
        runId: "run-1",
        label: "equity / AAPL",
        generatedAt: expect.any(String),
        forecasts: "2/3",
        targetMet: false,
        shortfall: "1 missing, disclosed",
        calibration: "skill +0.20",
        snapshotFreshness: "AAPL snapshot 1d",
      },
    ]);
  });

  test("parses historical-context audit trace fields", () => {
    expect(
      historicalContextAuditView({
        historicalContext: {
          scannedRunCount: 10,
          candidateRunCount: 4,
          selectedRunCount: 3,
          recentSelectedCount: 2,
          anchorSelectedCount: 1,
          sameSymbolSelectedCount: 1,
          spotlightSymbolSelectedCount: 0,
          sameSubjectSelectedCount: 0,
          sameHorizonSelectedCount: 2,
          crossHorizonSelectedCount: 1,
          resolvedMissRunCount: 1,
          missCorrectionSelectedCount: 1,
          gapCount: 2,
        },
      }),
    ).toEqual({
      scannedRunCount: 10,
      candidateRunCount: 4,
      selectedRunCount: 3,
      recentSelectedCount: 2,
      anchorSelectedCount: 1,
      sameSymbolSelectedCount: 1,
      spotlightSymbolSelectedCount: 0,
      sameSubjectSelectedCount: 0,
      sameHorizonSelectedCount: 2,
      crossHorizonSelectedCount: 1,
      resolvedMissRunCount: 1,
      missCorrectionSelectedCount: 1,
      gapCount: 2,
    });
    expect(historicalContextAuditView()).toBeUndefined();
  });

  test("returns empty dashboard trends for empty or undated run history", () => {
    expect(runTrend([])).toEqual([]);
    expect(
      runTrend([
        {
          runId: "run-1",
          generatedAt: "not-a-date",
          findingCount: 0,
          predictionCount: 0,
          sourceCount: 0,
          dataGapCount: 0,
          hasScore: false,
          availableFiles: [],
        },
      ]),
    ).toEqual([]);
  });

  test("buckets run trends by generated date with recent buckets last", () => {
    const runs = [
      {
        runId: "run-1",
        generatedAt: "2026-06-01T09:00:00Z",
        findingCount: 0,
        predictionCount: 2,
        sourceCount: 3,
        dataGapCount: 1,
        hasScore: false,
        availableFiles: [],
      },
      {
        runId: "run-2",
        generatedAt: "2026-06-01T18:00:00Z",
        findingCount: 0,
        predictionCount: 1,
        sourceCount: 2,
        dataGapCount: 0,
        hasScore: true,
        availableFiles: [],
      },
      {
        runId: "run-3",
        generatedAt: "2026-06-02T10:00:00Z",
        findingCount: 0,
        predictionCount: 4,
        sourceCount: 7,
        dataGapCount: 2,
        hasScore: true,
        availableFiles: [],
      },
    ];

    expect(runTrend(runs, 1)).toEqual([
      { date: "2026-06-02", runs: 1, forecasts: 4, sources: 7, dataGaps: 2 },
    ]);
    expect(runTrend(runs)).toEqual([
      { date: "2026-06-01", runs: 2, forecasts: 3, sources: 5, dataGaps: 1 },
      { date: "2026-06-02", runs: 1, forecasts: 4, sources: 7, dataGaps: 2 },
    ]);
  });
});

describe("calibration view model", () => {
  const detail = {
    summary: {
      generatedAt: "2026-06-10T05:53:20.310Z",
      resolvedCount: 13,
      brierScore: 0.2583,
      brierSkillScore: -0.0332,
      bins: [
        { pLow: 0.6, pHigh: 0.7, label: "0.6-0.7", hitCount: 4, totalCount: 8, hitRate: 0.5 },
        { pLow: 0.3, pHigh: 0.4, label: "0.3-0.4", hitCount: 1, totalCount: 1, hitRate: 1 },
        { pLow: 0.5, pHigh: 0.6, label: "0.5-0.6", hitCount: 2, totalCount: 4, hitRate: 0.5 },
        "broken",
        { pLow: 0.7, label: "missing fields" },
      ],
      byKind: {
        direction: { brierScore: 0.2374, count: 10 },
        range: { brierScore: 0.3281, count: 3 },
      },
      byHorizonBucket: {
        "6-10d": { brierScore: 0.31, count: 2 },
        "1-5d": { brierScore: 0.2583, count: 11 },
        custom: { brierScore: 0.5, count: 1 },
      },
      byMarketRegime: {
        "risk-on": { brierScore: 0.21, count: 8 },
        "risk-off": { brierScore: 0.29, count: 5 },
      },
      byMissAutopsyCause: {
        source_gap: 2,
        model_overconfidence: 5,
        broken: "many",
      },
    },
  };

  test("extracts the calibration headline", () => {
    expect(calibrationHeadline(detail)).toEqual({
      brierScore: 0.2583,
      brierSkillScore: -0.0332,
      resolvedCount: 13,
      generatedAt: "2026-06-10T05:53:20.310Z",
    });
    expect(calibrationHeadline({})).toEqual({ resolvedCount: 0 });
    expect(calibrationHeadline({ summary: { brierScore: Number.NaN } })).toEqual({
      resolvedCount: 0,
    });
  });

  test("filters and sorts sparse reliability bins", () => {
    expect(reliabilityBins(detail).map((bin) => bin.label)).toEqual([
      "0.3-0.4",
      "0.5-0.6",
      "0.6-0.7",
    ]);
    expect(reliabilityBins({})).toEqual([]);
    expect(reliabilityBins({ summary: { bins: "broken" } })).toEqual([]);
  });

  test("sorts slices by count except horizon buckets in bucket order", () => {
    expect(calibrationSlices(detail, "byKind")).toEqual([
      { key: "direction", brierScore: 0.2374, count: 10 },
      { key: "range", brierScore: 0.3281, count: 3 },
    ]);
    expect(calibrationSlices(detail, "byHorizonBucket").map((row) => row.key)).toEqual([
      "1-5d",
      "6-10d",
      "custom",
    ]);
    expect(calibrationSlices(detail, "byMarketRegime")).toEqual([
      { key: "risk-on", brierScore: 0.21, count: 8 },
      { key: "risk-off", brierScore: 0.29, count: 5 },
    ]);
    expect(calibrationSlices(detail, "byAssetClass")).toEqual([]);
    expect(calibrationSlices({}, "byKind")).toEqual([]);
  });

  test("flags small calibration samples", () => {
    expect(calibrationSampleWarning({ resolvedCount: 3 })).toEqual({
      show: true,
      resolvedCount: 3,
      minimum: 5,
    });
    expect(calibrationSampleWarning({ resolvedCount: 5 })).toEqual({
      show: false,
      resolvedCount: 5,
      minimum: 5,
    });
  });

  test("extracts sorted miss-autopsy taxonomy rows", () => {
    expect(calibrationAutopsyCauses(detail)).toEqual([
      { cause: "model_overconfidence", count: 5 },
      { cause: "source_gap", count: 2 },
    ]);
    expect(calibrationAutopsyCauses({})).toEqual([]);
  });
});

describe("alpha cohort view model", () => {
  const detail = {
    summary: {
      generatedAt: "2026-06-01T00:00:00.000Z",
      rejectedCandidateCount: 2,
      watchlistCandidateCount: 3,
      tickerBriefedLeadCount: 1,
      unbriefedLeadCount: 2,
      rejectionBuckets: [
        {
          reason: "Market cap above configured maximum",
          rejectedCount: 2,
          uniqueSymbolCount: 2,
          laterValidatedSymbolCount: 1,
          validation: {
            "5": { resolvedCount: 1, hitRate: 1, averageExcessReturn: 0.15 },
            "20": { resolvedCount: 0 },
          },
        },
      ],
      staleLeadDecay: [
        {
          ageBucket: "31+d",
          unbriefedLeadCount: 1,
          validation: {
            "5": { resolvedCount: 1, hitRate: 0, averageExcessReturn: -0.02 },
          },
        },
      ],
    },
  };

  test("extracts alpha cohort headline and rows", () => {
    expect(alphaCohortHeadline(detail)).toEqual({
      generatedAt: "2026-06-01T00:00:00.000Z",
      rejectedCandidateCount: 2,
      watchlistCandidateCount: 3,
      tickerBriefedLeadCount: 1,
      unbriefedLeadCount: 2,
    });
    expect(alphaRejectionBucketRows(detail)).toEqual([
      {
        reason: "Market cap above configured maximum",
        rejectedCount: 2,
        uniqueSymbolCount: 2,
        laterValidatedSymbolCount: 1,
        validation: "5d 100.0% hit · 15.0% excess · n=1",
      },
    ]);
    expect(alphaStaleLeadRows(detail)).toEqual([
      {
        ageBucket: "31+d",
        unbriefedLeadCount: 1,
        validation: "5d 0.0% hit · -2.0% excess · n=1",
      },
    ]);
  });
});

describe("verified market snapshot view model", () => {
  const snapshotJson = JSON.stringify({
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-06-11",
    fetchedAt: "2026-06-11T13:00:00Z",
    latestSessionDate: "2026-06-10",
    ohlcv: { date: "2026-06-10", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    indicators: {
      ema10: 199.2,
      sma50: 195.8,
      sma200: null,
      rsi14: 61.4,
      macd: 1.2,
      macdSignal: null,
      macdHistogram: null,
      bollUpper: 204.1,
      bollMiddle: 198,
      bollLower: 191.9,
      atr14: 4.3,
    },
    recentCloses: [
      { date: "2026-05-26", close: 196.1 },
      { date: "2026-05-27", close: 197.4 },
      { date: "2026-05-28", close: 200.3 },
    ],
  });

  test("parses a valid snapshot and drops null indicators", () => {
    expect(verifiedSnapshotView(snapshotJson)).toEqual({
      symbol: "AAPL",
      analysisDate: "2026-06-11",
      latestSessionDate: "2026-06-10",
      ohlcv: { date: "2026-06-10", close: 1.5 },
      indicators: {
        ema10: 199.2,
        sma50: 195.8,
        rsi14: 61.4,
        macd: 1.2,
        bollUpper: 204.1,
        bollMiddle: 198,
        bollLower: 191.9,
        atr14: 4.3,
      },
      recentCloses: [
        { date: "2026-05-26", close: 196.1 },
        { date: "2026-05-27", close: 197.4 },
        { date: "2026-05-28", close: 200.3 },
      ],
    });
  });

  test("rejects null, malformed, and close-poor payloads", () => {
    expect(verifiedSnapshotView("null")).toBeUndefined();
    expect(verifiedSnapshotView("not json")).toBeUndefined();
    expect(verifiedSnapshotView(JSON.stringify({ symbol: "AAPL" }))).toBeUndefined();
    expect(
      verifiedSnapshotView(
        JSON.stringify({ symbol: "AAPL", recentCloses: [{ date: "2026-05-26", close: 1 }] }),
      ),
    ).toBeUndefined();
    expect(
      verifiedSnapshotView(
        JSON.stringify({
          recentCloses: [
            { date: "2026-05-26", close: 1 },
            { date: "2026-05-27", close: 2 },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  test("ignores invalid close entries while keeping valid ones", () => {
    const view = verifiedSnapshotView(
      JSON.stringify({
        symbol: "AAPL",
        indicators: "broken",
        recentCloses: [
          { date: "2026-05-26", close: 1 },
          { date: "2026-05-27", close: "broken" },
          "broken",
          { date: "2026-05-28", close: 2 },
        ],
      }),
    );
    expect(view?.indicators).toEqual({});
    expect(view?.recentCloses).toEqual([
      { date: "2026-05-26", close: 1 },
      { date: "2026-05-28", close: 2 },
    ]);
  });

  test("maps closes onto chart coordinates", () => {
    const closes = [
      { date: "2026-05-26", close: 10 },
      { date: "2026-05-27", close: 20 },
      { date: "2026-05-28", close: 15 },
    ];
    const points = closeLinePoints(closes, 50, 600, 20, 180);
    expect(points.map((point) => point.x)).toEqual([50, 350, 650]);
    expect(points[0]?.y).toBe(200);
    expect(points[1]?.y).toBe(20);
    expect(points[2]?.y).toBe(110);
  });

  test("centers a flat series and handles tiny inputs", () => {
    const flat = closeLinePoints(
      [
        { date: "2026-05-26", close: 5 },
        { date: "2026-05-27", close: 5 },
      ],
      50,
      600,
      20,
      180,
    );
    expect(flat.every((point) => point.y === 110)).toBe(true);
    expect(closeLinePoints([], 50, 600, 20, 180)).toEqual([]);
    expect(closeLinePoints([{ date: "2026-05-26", close: 5 }], 50, 600, 20, 180)).toEqual([
      { x: 50, y: 110, date: "2026-05-26", close: 5 },
    ]);
  });

  test("dedupes and sorts forecast horizon markers", () => {
    expect(
      horizonMarkers([
        { horizonTradingDays: 10 },
        { horizonTradingDays: 5 },
        {},
        { horizonTradingDays: 10 },
        { horizonTradingDays: 0 },
      ]),
    ).toEqual([5, 10]);
    expect(horizonMarkers([])).toEqual([]);
  });

  test("builds TradingView symbols with exchange fallback", () => {
    expect(tradingViewSymbol(" aapl ")).toBe("AAPL");
    expect(tradingViewSymbol("nvda", "nasdaq")).toBe("NASDAQ:NVDA");
    expect(tradingViewUrl("BRK.B")).toBe("https://www.tradingview.com/chart/?symbol=BRK.B");
    expect(tradingViewUrl("nvda", "nasdaq")).toBe(
      "https://www.tradingview.com/chart/?symbol=NASDAQ%3ANVDA",
    );
  });
});

describe("forecast outcomes", () => {
  const report = {
    predictions: [
      { id: "p1", claim: "SPY closes higher.", probability: 0.6, sourceIds: [] },
      { id: "p2", claim: "VIX max above 20.", probability: 0.3, sourceIds: [] },
      { id: "p3", claim: "BTC closes higher.", probability: 0.55, sourceIds: [] },
    ],
    extras: {
      forecastDisagreement: {
        predictions: [
          {
            predictionId: "p1",
            meanProbability: 0.7,
            probabilityVariance: 0.01,
            probabilitySpread: 0.2,
            band: "high",
            participantCount: 2,
            missingParticipantCount: 0,
          },
          { predictionId: "p2", band: "broken" },
        ],
      },
    },
  };
  const score = {
    runId: "run-1",
    scores: [
      {
        predictionId: "p1",
        status: "resolved",
        resolved: true,
        outcome: "miss",
        observedAt: "2026-06-10T05:46:56Z",
        evidence: { close0: 742.74, closeN: 716.07 },
      },
      {
        predictionId: "p2",
        status: "pending",
        resolved: false,
        evidence: { reason: "horizon not yet elapsed" },
      },
      {
        predictionId: "orphan",
        resolved: true,
        outcome: "hit",
        evidence: {},
      },
    ],
  };
  const missAutopsy = {
    version: 1,
    autopsies: [
      {
        predictionId: "p1",
        cause: "source_gap",
        forecastError: "overpredicted",
        rationale: "Source coverage was incomplete.",
        supportingSignals: ["source gap"],
      },
      { predictionId: "p2", cause: 12 },
    ],
  };

  test("parses score entries defensively", () => {
    expect(predictionScores(score)).toEqual([
      {
        predictionId: "p1",
        status: "resolved",
        resolved: true,
        outcome: "miss",
        observedAt: "2026-06-10T05:46:56Z",
        close0: 742.74,
        closeN: 716.07,
        changePct: ((716.07 - 742.74) / 742.74) * 100,
      },
      {
        predictionId: "p2",
        status: "pending",
        resolved: false,
        pendingReason: "horizon not yet elapsed",
      },
      { predictionId: "orphan", status: "resolved", resolved: true, outcome: "hit" },
    ]);
  });

  const missingScore: Record<string, unknown> | undefined = undefined;

  test("ignores malformed score payloads and entries", () => {
    expect(predictionScores(missingScore)).toEqual([]);
    expect(predictionScores({ scores: "broken" })).toEqual([]);
    expect(
      predictionScores({
        scores: [null, 7, { resolved: true }, { predictionId: "p1", outcome: "draw" }],
      }),
    ).toEqual([{ predictionId: "p1", status: "pending", resolved: false }]);
  });

  test("omits evidence closes unless both are numbers", () => {
    const parsed = predictionScores({
      scores: [{ predictionId: "p1", resolved: true, outcome: "hit", evidence: { close0: 10 } }],
    });
    expect(parsed).toEqual([
      { predictionId: "p1", status: "resolved", resolved: true, outcome: "hit" },
    ]);
  });

  test("guards percent change against a zero origin close", () => {
    const parsed = predictionScores({
      scores: [
        { predictionId: "p1", resolved: true, outcome: "hit", evidence: { close0: 0, closeN: 5 } },
      ],
    });
    expect(parsed[0]?.changePct).toBeUndefined();
    expect(parsed[0]?.close0).toBe(0);
  });

  test("joins forecasts with score entries and leaves unmatched ones pending", () => {
    const joined = scoredForecasts(report, score, missAutopsy);
    expect(joined).toHaveLength(3);
    expect(joined[0]?.score?.outcome).toBe("miss");
    expect(joined[0]?.forecastDisagreement).toEqual({
      predictionId: "p1",
      meanProbability: 0.7,
      probabilityVariance: 0.01,
      probabilitySpread: 0.2,
      band: "high",
      participantCount: 2,
      missingParticipantCount: 0,
    });
    expect(joined[0]?.missAutopsy).toEqual({
      predictionId: "p1",
      cause: "source_gap",
      forecastError: "overpredicted",
      rationale: "Source coverage was incomplete.",
      supportingSignals: ["source gap"],
    });
    expect(joined[1]?.score?.resolved).toBe(false);
    expect(joined[1]?.score?.pendingReason).toBe("horizon not yet elapsed");
    expect(joined[1]?.forecastDisagreement).toBeUndefined();
    expect(joined[2]?.score).toBeUndefined();
  });

  test("parses forecast disagreement summaries defensively", () => {
    expect(forecastDisagreements(report)).toEqual([
      {
        predictionId: "p1",
        meanProbability: 0.7,
        probabilityVariance: 0.01,
        probabilitySpread: 0.2,
        band: "high",
        participantCount: 2,
        missingParticipantCount: 0,
      },
    ]);
    expect(forecastDisagreements({ extras: { forecastDisagreement: "broken" } })).toEqual([]);
  });

  test("joins to empty scores when score artifact is missing", () => {
    const joined = scoredForecasts(report, missingScore);
    expect(joined).toHaveLength(3);
    expect(joined.every((item) => item.score === undefined)).toBe(true);
  });

  test("formats closes with sensible precision", () => {
    expect(formatClose(742.739_990_234_375)).toBe("742.74");
    expect(formatClose(0.000_123_45)).toBe("0.0001234");
    expect(formatClose(1)).toBe("1.00");
  });

  test("rolls up scored forecast counts", () => {
    expect(forecastRollup(scoredForecasts(report, score))).toEqual({
      total: 3,
      resolved: 1,
      hits: 0,
      misses: 1,
      voided: 0,
      pending: 2,
    });
    expect(forecastRollup([])).toEqual({
      total: 0,
      resolved: 0,
      hits: 0,
      misses: 0,
      voided: 0,
      pending: 0,
    });
  });

  test("groups conditional forecasts by identical antecedent", () => {
    const conditionalReport = {
      predictions: [
        {
          id: "c1",
          kind: "conditional",
          claim: "",
          subject: "QQQ",
          measurableAs:
            "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
          probability: 0.62,
          sourceIds: [],
        },
        {
          id: "c2",
          kind: "conditional",
          claim: "",
          subject: "IWM",
          measurableAs:
            "if (close(SPY, +5) > close(SPY, 0)) then (close(IWM, +10) > close(IWM, 0))",
          probability: 0.58,
          sourceIds: [],
        },
      ],
    };
    const conditionalScore = {
      scores: [
        {
          predictionId: "c1",
          status: "active-pending",
          resolved: false,
          evidence: { reason: "condition met; consequent pending" },
        },
        {
          predictionId: "c2",
          status: "voided",
          resolved: true,
          evidence: { reason: "condition unmet" },
        },
      ],
    };

    const groups = forecastGroups(scoredForecasts(conditionalReport, conditionalScore));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.antecedent).toBe("close(SPY, +5) > close(SPY, 0)");
    expect(groups[0]?.forecasts.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect(groups[0]?.forecasts.map((item) => item.score?.status)).toEqual([
      "active-pending",
      "voided",
    ]);
  });
});

describe("report artifact parsers", () => {
  test("parses extended evidence items and drops malformed entries", () => {
    expect(extendedEvidenceItems()).toEqual([]);
    expect(extendedEvidenceItems({ extendedEvidence: "broken" })).toEqual([]);
    expect(
      extendedEvidenceItems({
        extendedEvidence: {
          items: [
            {
              category: "valuation",
              title: "AAPL Valuation Evidence",
              summary: "EV/annualized revenue 12.3x",
              sourceIds: ["s1"],
              metrics: { marketCap: 1_000_000_000, evToAnnualizedRevenue: 12.34 },
            },
            { category: "valuation", title: "missing summary" },
            null,
          ],
        },
      }),
    ).toEqual([
      {
        category: "valuation",
        title: "AAPL Valuation Evidence",
        summary: "EV/annualized revenue 12.3x",
        sourceIds: ["s1"],
        metrics: { marketCap: 1_000_000_000, evToAnnualizedRevenue: 12.34 },
      },
    ]);
  });

  test("splits prediction shortfall gaps from other data gaps", () => {
    expect(
      splitDataGaps(["predictionShortfall: emitted 2 of 3 target predictions", "Missing provider"]),
    ).toEqual({
      shortfalls: ["predictionShortfall: emitted 2 of 3 target predictions"],
      otherGaps: ["Missing provider"],
    });
    expect(formatShortfallGap("predictionShortfall: emitted 2 of 3 target predictions")).toBe(
      "emitted 2 of 3 target predictions",
    );
    expect(formatShortfallGap("Missing provider")).toBe("Missing provider");
  });

  test("reads prediction target health from analytics with report fallback", () => {
    expect(
      predictionTargetHealth({ predictions: { count: 2, targetCount: 3, targetMet: false } }),
    ).toEqual({ count: 2, target: 3, targetMet: false });

    expect(
      predictionTargetHealth(
        {},
        {
          predictions: [{ id: "p1" }, { id: "p2" }],
          extras: { depthProfile: { targetPredictions: 3 } },
        },
      ),
    ).toEqual({ count: 2, target: 3, targetMet: false });

    expect(predictionTargetHealth()).toBeUndefined();
  });

  test("formats valuation metric tiles for display", () => {
    expect(
      valuationMetricTiles({
        marketCap: 2_500_000_000,
        enterpriseValue: 2_700_000_000,
        annualizedRevenue: 500_000_000,
        evToAnnualizedRevenue: 5.4,
        revenuePeriodMonths: 12,
        corePeerCount: 3,
        peerMedianEvToAnnualizedRevenue: 4.2,
        peerP25EvToAnnualizedRevenue: 3.1,
        peerP75EvToAnnualizedRevenue: 5.6,
        valuationSupportability: "supported",
      }),
    ).toEqual([
      { label: "Market cap", value: "$2.5B" },
      { label: "Enterprise value", value: "$2.7B" },
      { label: "Annualized revenue", value: "$500.0M" },
      { label: "EV / annualized revenue", value: "5.4x" },
      { label: "Revenue period (months)", value: "12" },
      { label: "Core peers", value: "3" },
      { label: "Peer median EV / annualized revenue", value: "4.2x" },
      { label: "Peer P25 EV / annualized revenue", value: "3.1x" },
      { label: "Peer P75 EV / annualized revenue", value: "5.6x" },
      { label: "Supportability", value: "supported" },
    ]);
  });

  test("formats financial lens metric tiles dynamically from the artifact", () => {
    // Dynamic rendering: posture tile first per lens, then every metric the
    // Artifact carries, formatted by unit via the shared value-format module.
    // No hardcoded key list — every metric present renders, absent ones don't.
    expect(
      financialLensMetricTiles({
        version: 1,
        generatedAt: "2026-06-22T00:00:00.000Z",
        symbol: "AAPL",
        lenses: [
          {
            name: "Quality",
            posture: "criteria-supported",
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            metrics: [
              {
                key: "grossMargin",
                label: "Gross margin",
                value: 0.42,
                unit: "ratio-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
              {
                key: "netMargin",
                label: "Net margin",
                value: 0.18,
                unit: "ratio-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
              {
                key: "freeCashFlowProxy",
                label: "FCF proxy",
                value: 25_000_000,
                unit: "currency",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
            ],
          },
          {
            name: "Growth",
            posture: "criteria-mixed",
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            metrics: [
              {
                key: "revenueDeltaPercent",
                label: "Revenue YoY",
                value: 12,
                unit: "whole-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
              {
                key: "operatingIncomeDeltaPercent",
                label: "Operating income YoY",
                value: 8,
                unit: "whole-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
            ],
          },
          {
            name: "Financial Strength",
            posture: "criteria-supported",
            sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            metrics: [
              {
                key: "debtToMarketCap",
                label: "Debt/market cap",
                value: 0.02,
                unit: "ratio-percent",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
              {
                key: "currentRatio",
                label: "Current ratio",
                value: 2,
                unit: "ratio",
                sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              },
            ],
          },
          {
            name: "Value",
            posture: "insufficient-data",
            sourceIds: ["market-yahoo-equity-aapl"],
            metrics: [
              {
                key: "evToAnnualizedRevenue",
                label: "EV/revenue",
                value: 2.46,
                unit: "ratio",
                sourceIds: ["market-yahoo-equity-aapl"],
              },
              {
                key: "peRatio",
                label: "PE",
                value: 36.08,
                unit: "ratio",
                sourceIds: ["market-yahoo-equity-aapl"],
              },
            ],
          },
          {
            name: "Momentum",
            posture: "criteria-not-supported",
            sourceIds: ["verified-snapshot-AAPL"],
            metrics: [
              {
                key: "rsi14",
                label: "RSI14",
                value: 58,
                unit: "number",
                sourceIds: ["verified-snapshot-AAPL"],
              },
            ],
          },
        ],
        sourceIds: ["extended-sec-edgar-aapl-fundamentals", "market-yahoo-equity-aapl"],
      }),
    ).toEqual([
      { label: "Quality", value: "criteria supported" },
      { label: "Gross margin", value: "42.0%" },
      { label: "Net margin", value: "18.0%" },
      { label: "FCF proxy", value: "$25.0M" },
      { label: "Growth", value: "criteria mixed" },
      { label: "Revenue YoY", value: "12.0%" },
      { label: "Operating income YoY", value: "8.0%" },
      { label: "Financial Strength", value: "criteria supported" },
      { label: "Debt/market cap", value: "2.0%" },
      { label: "Current ratio", value: "2.00x" },
      { label: "Value", value: "insufficient data" },
      { label: "EV/revenue", value: "2.46x" },
      { label: "PE", value: "36.08x" },
      { label: "Momentum", value: "criteria not supported" },
      { label: "RSI14", value: "58.00" },
    ]);
  });

  test("parses business framework from report extras before sidecar fallback", () => {
    const artifact = {
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "AAPL",
      phase: "operating-leverage",
      sections: [
        {
          name: "Business",
          posture: "criteria-supported",
          summary: "Fallback summary.",
          metrics: [],
          sourceIds: ["sidecar-source"],
          gaps: [],
        },
      ],
      sourceIds: ["sidecar-source"],
      gaps: [],
    } as const;

    expect(
      businessFrameworkView(
        {
          extras: {
            businessFramework: {
              phase: "capital-return",
              sourceIds: ["report-source"],
              gaps: ["Management evidence unavailable"],
              sections: [
                {
                  name: "Business",
                  posture: "criteria-supported",
                  summary: "Deterministic summary.",
                  text: "Model-authored framework text.",
                  metrics: [
                    {
                      key: "grossMargin",
                      label: "Gross margin",
                      value: 0.42,
                      unit: "ratio-percent",
                      sourceIds: ["report-source"],
                    },
                  ],
                  sourceIds: ["report-source"],
                  gaps: ["Segment mix unavailable"],
                },
              ],
            },
          },
        },
        artifact,
      ),
    ).toEqual({
      phase: "capital-return",
      sourceIds: ["report-source"],
      gaps: ["Management evidence unavailable"],
      sections: [
        {
          name: "Business",
          posture: "criteria-supported",
          summary: "Deterministic summary.",
          text: "Model-authored framework text.",
          metrics: [
            {
              key: "grossMargin",
              label: "Gross margin",
              value: "42.0%",
              sourceIds: ["report-source"],
            },
          ],
          sourceIds: ["report-source"],
          gaps: ["Segment mix unavailable"],
        },
      ],
    });
  });

  test("falls back to business framework sidecar and rejects malformed phase", () => {
    const artifact = {
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "AAPL",
      phase: "hyper-growth",
      sections: [
        {
          name: "Growth",
          posture: "criteria-mixed",
          summary: "Growth criteria-mixed.",
          metrics: [
            {
              key: "revenueDeltaPercent",
              label: "Revenue YoY",
              value: 12,
              unit: "whole-percent",
              sourceIds: ["s"],
            },
          ],
          sourceIds: ["s"],
          gaps: [],
        },
      ],
      sourceIds: ["s"],
      gaps: [],
    } as const;

    expect(businessFrameworkView(undefined, artifact)?.sections[0]?.metrics[0]?.value).toBe(
      "12.0%",
    );
    expect(
      businessFrameworkView({
        extras: { businessFramework: { phase: "invalid", sections: [] } },
      }),
    ).toBeUndefined();
  });

  test("parses Web Subject Profile from report extras before sidecar fallback", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: ["report-source"] };
    const sidecarAnswer = { answer: "Fallback profile.", sourceIds: ["sidecar-source"] };

    expect(
      webSubjectProfileView(
        {
          extras: {
            webSubjectProfile: {
              subjectKind: "company",
              subjectId: "AAPL",
              subjectLabel: "Apple Inc.",
              generatedAt: "2026-06-22T00:00:00.000Z",
              sourceIds: ["report-source"],
              subjectSummary: answer,
              questions: {
                whatItDoes: answer,
                howItMakesMoney: answer,
                customers: answer,
                geography: answer,
                purchaseRecurrence: answer,
                pricingPower: answer,
                recessionCyclicality: answer,
              },
              recentMaterialEvents: [
                { claim: "Apple reports services revenue.", sourceIds: ["report-source"] },
              ],
              factLedger: [
                { claim: "Apple sells devices and services.", sourceIds: ["report-source"] },
              ],
              openGaps: ["Customer concentration not fully quantified."],
            },
          },
        },
        {
          version: 2,
          generatedAt: "2026-06-21T00:00:00.000Z",
          subjectKind: "company",
          subjectId: "AAPL",
          subjectLabel: "Apple Inc.",
          symbol: "AAPL",
          subjectSummary: sidecarAnswer,
          questions: {
            whatItDoes: sidecarAnswer,
            howItMakesMoney: sidecarAnswer,
            customers: sidecarAnswer,
            geography: sidecarAnswer,
            purchaseRecurrence: sidecarAnswer,
            pricingPower: sidecarAnswer,
            recessionCyclicality: sidecarAnswer,
          },
          recentMaterialEvents: [],
          factLedger: [{ claim: "Fallback fact.", sourceIds: ["sidecar-source"] }],
          openGaps: [],
          sourceIds: ["sidecar-source"],
        },
      ),
    ).toEqual({
      subjectKind: "company",
      subjectLabel: "Apple Inc.",
      subjectSummary: {
        key: "subjectSummary",
        label: "Summary",
        answer: "Apple sells devices and services.",
        sourceIds: ["report-source"],
      },
      generatedAt: "2026-06-22T00:00:00.000Z",
      sourceIds: ["report-source"],
      questions: [
        {
          key: "whatItDoes",
          label: "What it does",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "howItMakesMoney",
          label: "How it makes money",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "customers",
          label: "Customers",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "geography",
          label: "Geography",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "purchaseRecurrence",
          label: "Purchase recurrence",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "pricingPower",
          label: "Pricing power",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
        {
          key: "recessionCyclicality",
          label: "Recession cyclicality",
          answer: "Apple sells devices and services.",
          sourceIds: ["report-source"],
        },
      ],
      recentMaterialEvents: [
        { claim: "Apple reports services revenue.", sourceIds: ["report-source"] },
      ],
      factLedger: [{ claim: "Apple sells devices and services.", sourceIds: ["report-source"] }],
      openGaps: ["Customer concentration not fully quantified."],
    });
  });

  test("falls back to Web Subject Profile sidecar", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: ["sidecar-source"] };

    expect(
      webSubjectProfileView(undefined, {
        version: 2,
        generatedAt: "2026-06-22T00:00:00.000Z",
        subjectKind: "company",
        subjectId: "AAPL",
        subjectLabel: "Apple Inc.",
        symbol: "AAPL",
        subjectSummary: answer,
        questions: {
          whatItDoes: answer,
          howItMakesMoney: answer,
          customers: answer,
          geography: answer,
          purchaseRecurrence: answer,
          pricingPower: answer,
          recessionCyclicality: answer,
        },
        recentMaterialEvents: [],
        factLedger: [{ claim: "Apple sells devices and services.", sourceIds: ["sidecar-source"] }],
        openGaps: [],
        sourceIds: ["sidecar-source"],
      })?.questions[0],
    ).toEqual({
      key: "whatItDoes",
      label: "What it does",
      answer: "Apple sells devices and services.",
      sourceIds: ["sidecar-source"],
    });
    expect(
      webSubjectProfileView({ extras: { webSubjectProfile: { questions: {} } } }),
    ).toBeUndefined();
  });

  test("drops uncited Web Subject Profile answers and facts", () => {
    const sidecarAnswer = { answer: "Fallback profile.", sourceIds: ["sidecar-source"] };

    expect(
      webSubjectProfileView(
        {
          extras: {
            webSubjectProfile: {
              questions: {
                whatItDoes: { answer: "Uncited answer.", sourceIds: [] },
              },
              recentMaterialEvents: [{ claim: "Uncited event.", sourceIds: [] }],
              factLedger: [{ claim: "Uncited fact.", sourceIds: [] }],
            },
          },
        },
        {
          version: 2,
          generatedAt: "2026-06-22T00:00:00.000Z",
          subjectKind: "company",
          subjectId: "AAPL",
          subjectLabel: "Apple Inc.",
          symbol: "AAPL",
          subjectSummary: sidecarAnswer,
          questions: {
            whatItDoes: sidecarAnswer,
            howItMakesMoney: sidecarAnswer,
            customers: sidecarAnswer,
            geography: sidecarAnswer,
            purchaseRecurrence: sidecarAnswer,
            pricingPower: sidecarAnswer,
            recessionCyclicality: sidecarAnswer,
          },
          recentMaterialEvents: [],
          factLedger: [{ claim: "Fallback fact.", sourceIds: ["sidecar-source"] }],
          openGaps: [],
          sourceIds: ["sidecar-source"],
        },
      )?.sourceIds,
    ).toEqual(["sidecar-source"]);
  });

  test("assesses financial lens stats where standalone thresholds are meaningful", () => {
    const tiles = financialLensStatTiles({
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "AAPL",
      lenses: [
        {
          name: "Quality",
          posture: "criteria-supported",
          sourceIds: ["s"],
          metrics: [
            {
              key: "grossMargin",
              label: "Gross margin",
              value: 0.42,
              unit: "ratio-percent",
              sourceIds: ["s"],
            },
            {
              key: "operatingMargin",
              label: "Operating margin",
              value: 0.08,
              unit: "ratio-percent",
              sourceIds: ["s"],
            },
            {
              key: "netMargin",
              label: "Net margin",
              value: 0.07,
              unit: "ratio-percent",
              sourceIds: ["s"],
            },
          ],
        },
        {
          name: "Financial Strength",
          posture: "criteria-not-supported",
          sourceIds: ["s"],
          metrics: [
            {
              key: "debtToMarketCap",
              label: "Debt/market cap",
              value: 0.65,
              unit: "ratio-percent",
              sourceIds: ["s"],
            },
          ],
        },
        {
          name: "Momentum",
          posture: "criteria-supported",
          sourceIds: ["s"],
          metrics: [
            {
              key: "latestClose",
              label: "Latest close",
              value: 180,
              unit: "currency",
              sourceIds: ["s"],
            },
          ],
        },
      ],
      sourceIds: ["s"],
    });

    expect(tiles).toEqual([
      {
        key: "grossMargin",
        lens: "Quality",
        label: "Gross margin",
        value: "42.0%",
        tone: "strong",
        assessment: "Strong",
      },
      {
        key: "operatingMargin",
        lens: "Quality",
        label: "Operating margin",
        value: "8.0%",
        tone: "watch",
        assessment: "Watch",
      },
      {
        key: "netMargin",
        lens: "Quality",
        label: "Net margin",
        value: "7.0%",
        tone: "healthy",
        assessment: "Healthy",
      },
      {
        key: "debtToMarketCap",
        lens: "Financial Strength",
        label: "Debt/market cap",
        value: "65.0%",
        tone: "weak",
        assessment: "Weak",
      },
      {
        key: "latestClose",
        lens: "Momentum",
        label: "Latest close",
        value: "$180",
        tone: "neutral",
      },
    ]);
  });

  test("formats sub-1 percent values by convention, not by magnitude", () => {
    // Ratio convention: 0.005 -> 0.5%. Whole-percent convention: 0.5 -> 0.5%.
    const tiles = financialLensMetricTiles({
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "AAPL",
      lenses: [
        {
          name: "Quality",
          posture: "insufficient-data",
          sourceIds: ["s"],
          metrics: [
            {
              key: "grossMargin",
              label: "Gross margin",
              value: 0.005,
              unit: "ratio-percent",
              sourceIds: ["s"],
            },
            {
              key: "revenueDeltaPercent",
              label: "Revenue YoY",
              value: 0.5,
              unit: "whole-percent",
              sourceIds: ["s"],
            },
          ],
        },
      ],
      sourceIds: ["s"],
    });

    expect(tiles).toEqual([
      { label: "Quality", value: "insufficient data" },
      { label: "Gross margin", value: "0.5%" },
      { label: "Revenue YoY", value: "0.5%" },
    ]);
  });

  test("renders currency metrics with GBp pence suffix via shared value-format", () => {
    const tiles = financialLensMetricTiles({
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "RR.L",
      lenses: [
        {
          name: "Momentum",
          posture: "insufficient-data",
          sourceIds: ["market-yahoo-equity-rr"],
          metrics: [
            {
              key: "latestClose",
              label: "Latest close",
              value: 1411.8,
              unit: "currency",
              sourceIds: ["market-yahoo-equity-rr"],
              currency: "GBp",
            },
          ],
        },
      ],
      sourceIds: ["market-yahoo-equity-rr"],
    });

    expect(tiles).toContainEqual({ label: "Latest close", value: "1,411.8p" });
  });

  test("renders Yahoo dividendYield as whole-percent, never as a fraction (fixture guard)", () => {
    // Captured AAPL fixture: dividendYield 0.36 -> 0.4% (whole-percent). A wrong
    // Fraction unit (ratio-percent) would render 36.0% and silently 100x the tile.
    const tiles = financialLensMetricTiles({
      version: 1,
      generatedAt: "2026-06-22T00:00:00.000Z",
      symbol: "AAPL",
      lenses: [
        {
          name: "Financial Strength",
          posture: "insufficient-data",
          sourceIds: ["market-yahoo-equity-aapl"],
          metrics: [
            {
              key: "dividendYield",
              label: "Dividend yield",
              value: 0.36,
              unit: "whole-percent",
              sourceIds: ["market-yahoo-equity-aapl"],
            },
          ],
        },
      ],
      sourceIds: ["market-yahoo-equity-aapl"],
    });

    expect(tiles).toContainEqual({ label: "Dividend yield", value: "0.4%" });
    expect(tiles.find((tile) => tile.label === "Dividend yield")?.value).not.toContain("36");
  });

  test("returns no tiles when the artifact is absent (sparse rendering)", () => {
    expect(financialLensMetricTiles()).toEqual([]);
  });

  test("indexes extended evidence metrics in search candidates", () => {
    const candidates = reportSearchCandidates(
      {
        extendedEvidence: {
          items: [
            {
              category: "valuation",
              title: "AAPL Valuation Evidence",
              summary: "Valuation summary",
              sourceIds: ["s1"],
              metrics: { evToAnnualizedRevenue: 5.4 },
            },
          ],
        },
      },
      "console",
    );

    expect(candidates.some((candidate) => candidate.section === "extendedEvidence")).toBe(true);
    expect(
      candidates.find((candidate) => candidate.section === "extendedEvidence")?.text,
    ).toContain("5.4");
  });
});
