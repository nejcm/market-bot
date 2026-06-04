import { describe, expect, test } from "bun:test";
import {
  groupedSearchResults,
  matchesQuery,
  predictions,
  runLabel,
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
});
