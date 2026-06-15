import { describe, expect, test } from "bun:test";
import { reportSearchCandidates } from "../app/report-artifact-view";
import {
  calibrationAutopsyCauses,
  calibrationHeadline,
  calibrationSampleWarning,
  calibrationSlices,
  closeLinePoints,
  dashboardMetrics,
  extendedEvidenceItems,
  forecastDisagreements,
  filterRuns,
  forecastRollup,
  formatClose,
  horizonMarkers,
  predictionScores,
  predictionTargetHealth,
  scoredForecasts,
  groupedRunsByType,
  groupedSearchResults,
  matchesQuery,
  predictions,
  providerHealthRows,
  recentRunSummaries,
  reliabilityBins,
  runCountsLabel,
  runIdFromPathname,
  runLabel,
  runPath,
  runTrend,
  sources,
  formatShortfallGap,
  splitDataGaps,
  textItems,
  valuationMetricTiles,
  verifiedSnapshotView,
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
      jobType: "ticker",
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
    expect(runLabel(run)).toBe("ticker / AAPL");
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
      { ...baseRun, runId: "ticker-aapl", jobType: "ticker", symbol: "AAPL" },
      { ...baseRun, runId: "ticker-msft", jobType: "ticker", symbol: "MSFT" },
      { ...baseRun, runId: "daily-1", jobType: "daily" },
      { ...baseRun, runId: "untyped-1" },
    ];

    expect(filterRuns(runs, "all", "")).toEqual(runs);
    expect(filterRuns(runs, "ticker", "").map((run) => run.runId)).toEqual([
      "ticker-aapl",
      "ticker-msft",
    ]);
    expect(filterRuns(runs, "ticker", "aapl").map((run) => run.runId)).toEqual(["ticker-aapl"]);
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
        { ...baseRun, runId: "ticker-1", jobType: "ticker" },
        { ...baseRun, runId: "daily-1", jobType: "daily" },
        { ...baseRun, runId: "weekly-1", jobType: "weekly" },
        { ...baseRun, runId: "ticker-2", jobType: "ticker" },
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
        type: "ticker",
        runs: [
          { ...baseRun, runId: "ticker-1", jobType: "ticker" },
          { ...baseRun, runId: "ticker-2", jobType: "ticker" },
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
        resolved: true,
        outcome: "miss",
        observedAt: "2026-06-10T05:46:56Z",
        evidence: { close0: 742.74, closeN: 716.07 },
      },
      {
        predictionId: "p2",
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
        resolved: true,
        outcome: "miss",
        observedAt: "2026-06-10T05:46:56Z",
        close0: 742.74,
        closeN: 716.07,
        changePct: ((716.07 - 742.74) / 742.74) * 100,
      },
      {
        predictionId: "p2",
        resolved: false,
        pendingReason: "horizon not yet elapsed",
      },
      { predictionId: "orphan", resolved: true, outcome: "hit" },
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
    ).toEqual([{ predictionId: "p1", resolved: false }]);
  });

  test("omits evidence closes unless both are numbers", () => {
    const parsed = predictionScores({
      scores: [{ predictionId: "p1", resolved: true, outcome: "hit", evidence: { close0: 10 } }],
    });
    expect(parsed).toEqual([{ predictionId: "p1", resolved: true, outcome: "hit" }]);
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
      pending: 2,
    });
    expect(forecastRollup([])).toEqual({
      total: 0,
      resolved: 0,
      hits: 0,
      misses: 0,
      pending: 0,
    });
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
      }),
    ).toEqual([
      { label: "Market cap", value: "$2.5B" },
      { label: "Enterprise value", value: "$2.7B" },
      { label: "Annualized revenue", value: "$500.0M" },
      { label: "EV / annualized revenue", value: "5.4x" },
      { label: "Revenue period (months)", value: "12" },
    ]);
  });

  test("indexes extended evidence metrics in search candidates", () => {
    const candidates = reportSearchCandidates({
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
    });

    expect(candidates.some((candidate) => candidate.section === "extendedEvidence")).toBe(true);
    expect(
      candidates.find((candidate) => candidate.section === "extendedEvidence")?.text,
    ).toContain("5.4");
  });
});
