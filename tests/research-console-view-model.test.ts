import { describe, expect, test } from "bun:test";
import {
  dashboardMetrics,
  groupedSearchResults,
  matchesQuery,
  predictions,
  runLabel,
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
