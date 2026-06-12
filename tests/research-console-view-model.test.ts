import { describe, expect, test } from "bun:test";
import {
  dashboardMetrics,
  filterRuns,
  forecastRollup,
  formatClose,
  predictionScores,
  scoredForecasts,
  groupedRunsByType,
  groupedSearchResults,
  matchesQuery,
  predictions,
  providerHealthRows,
  recentRunSummaries,
  runCountsLabel,
  runIdFromPathname,
  runLabel,
  runPath,
  runTrend,
  sources,
  textItems,
} from "../app/client/view-model";

describe("research console app view model", () => {
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

describe("forecast outcomes", () => {
  const report = {
    predictions: [
      { id: "p1", claim: "SPY closes higher.", probability: 0.6, sourceIds: [] },
      { id: "p2", claim: "VIX max above 20.", probability: 0.3, sourceIds: [] },
      { id: "p3", claim: "BTC closes higher.", probability: 0.55, sourceIds: [] },
    ],
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
    const joined = scoredForecasts(report, score);
    expect(joined).toHaveLength(3);
    expect(joined[0]?.score?.outcome).toBe("miss");
    expect(joined[1]?.score?.resolved).toBe(false);
    expect(joined[1]?.score?.pendingReason).toBe("horizon not yet elapsed");
    expect(joined[2]?.score).toBeUndefined();
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
