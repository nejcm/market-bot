import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoricalResearchContext } from "../src/research/historical-context";
import {
  buildSpotlightCandidates,
  loadAlphaWatchlistForSpotlights,
  parseAlphaWatchlistForSpotlights,
  parseSpotlightSelection,
} from "../src/research/spotlights";
import { marketSnapshot } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function historyContext(): HistoricalResearchContext {
  return {
    generatedAt: "2026-06-04T00:00:00.000Z",
    recentDays: 90,
    anchorMonths: [3],
    runs: [
      {
        runId: "ticker-aapl",
        sourceId: "history-report-ticker-aapl",
        jobType: "ticker",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-20T00:00:00.000Z",
        selectionReasons: ["recent"],
        summary: "Prior AAPL ticker run.",
        confidence: "medium",
        keyFindings: [],
        risks: [],
        catalysts: [],
        dataGaps: [],
        predictions: [],
        scoreSummary: { total: 0, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
        marketSnapshots: [],
      },
      {
        runId: "daily-equity",
        sourceId: "history-report-daily-equity",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-18T00:00:00.000Z",
        selectionReasons: ["recent"],
        summary: "Prior market run.",
        confidence: "medium",
        keyFindings: [],
        risks: [],
        catalysts: [],
        dataGaps: [],
        predictions: [],
        scoreSummary: { total: 0, resolved: 0, hit: 0, miss: 0, unresolved: 0 },
        marketSnapshots: [
          {
            symbol: "AAPL",
            price: 190,
            changePercent24h: 2,
            volume: 1_000_000,
            observedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      },
    ],
    sources: [],
    gaps: [],
    audit: {
      scannedRunCount: 2,
      malformedRunCount: 0,
      malformedScoreCount: 0,
      candidateRunCount: 2,
      selectedRunCount: 2,
      recentSelectedCount: 2,
      anchorSelectedCount: 0,
      sameSymbolSelectedCount: 0,
      spotlightSymbolSelectedCount: 0,
      sameHorizonSelectedCount: 0,
      crossHorizonSelectedCount: 0,
      resolvedMissRunCount: 0,
      missCorrectionSelectedCount: 0,
      gapCount: 0,
    },
    artifactDeltas: [],
  };
}

describe("spotlight candidates", () => {
  test("builds candidates from current snapshots and only enriches matching alpha entries", () => {
    const watchlist = parseAlphaWatchlistForSpotlights({
      generatedAt: "2026-06-04T00:00:00.000Z",
      candidates: [
        {
          symbol: "AAPL",
          seenCount: 2,
          lastSeenAt: "2026-06-03T00:00:00.000Z",
          latestProfile: {
            sourceGroup: "apewisdom-only",
            discoverySources: ["apewisdom"],
            socialRank: 3,
            socialMomentumScore: 42,
          },
          latestValidation: [{ status: "resolved", horizonTradingDays: 5 }],
        },
        {
          symbol: "MSFT",
          seenCount: 1,
          lastSeenAt: "2026-06-03T00:00:00.000Z",
          latestProfile: { discoverySources: ["apewisdom"] },
          latestValidation: [],
        },
      ],
    });

    expect(watchlist).toBeDefined();
    const candidates = buildSpotlightCandidates({
      marketSnapshots: [
        marketSnapshot({
          symbol: "AAPL",
          name: "Apple Inc.",
          changePercent24h: 5,
          volume: 2_000_000,
          benchmark: {
            sourceId: "bench-spy",
            symbol: "SPY",
            basis: "broad-index",
            changePercent24h: 1,
            observedAt: "2026-06-04T00:00:00.000Z",
          },
        }),
      ],
      historicalContext: historyContext(),
      ...(watchlist !== undefined ? { alphaWatchlist: watchlist } : {}),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      symbol: "AAPL",
      sourceIds: ["market-aapl", "bench-spy"],
      history: {
        tickerRunIds: ["ticker-aapl"],
        marketRunIds: ["daily-equity"],
      },
      alpha: {
        seenCount: 2,
        sourceGroup: "apewisdom-only",
        latestValidation: ["5d:resolved"],
      },
    });
  });

  test("caps candidates to the top-ranked movers when candidateLimit is set", () => {
    const snapshots = [
      marketSnapshot({
        sourceId: "market-a",
        symbol: "AAA",
        changePercent24h: 10,
        volume: 2_000_000,
      }),
      marketSnapshot({
        sourceId: "market-b",
        symbol: "BBB",
        changePercent24h: 8,
        volume: 2_000_000,
      }),
      marketSnapshot({
        sourceId: "market-c",
        symbol: "CCC",
        changePercent24h: 6,
        volume: 2_000_000,
      }),
      marketSnapshot({
        sourceId: "market-d",
        symbol: "DDD",
        changePercent24h: 4,
        volume: 2_000_000,
      }),
      marketSnapshot({
        sourceId: "market-e",
        symbol: "EEE",
        changePercent24h: 2,
        volume: 2_000_000,
      }),
    ];

    const uncapped = buildSpotlightCandidates({ marketSnapshots: snapshots });
    expect(uncapped).toHaveLength(5);

    const capped = buildSpotlightCandidates({ marketSnapshots: snapshots, candidateLimit: 3 });
    expect(capped.map((candidate) => candidate.symbol)).toEqual(
      uncapped.slice(0, 3).map((candidate) => candidate.symbol),
    );
    expect(capped).toHaveLength(3);
  });

  test("parses selector output with duplicate, unknown, and cap-overflow audit failures", () => {
    const candidates = buildSpotlightCandidates({
      marketSnapshots: [
        marketSnapshot({ symbol: "AAPL", changePercent24h: 5, volume: 2_000_000 }),
        marketSnapshot({
          sourceId: "market-nvda",
          symbol: "NVDA",
          changePercent24h: 4,
          volume: 2_000_000,
        }),
      ],
    });

    const result = parseSpotlightSelection(
      JSON.stringify({
        rationale: "Select the most important current movers.",
        selections: [
          { symbol: "AAPL", rationale: "Large liquid move.", sourceIds: ["market-aapl"] },
          { symbol: "AAPL", rationale: "Duplicate.", sourceIds: ["market-aapl"] },
          { symbol: "MSFT", rationale: "Unknown.", sourceIds: ["market-msft"] },
          { symbol: "NVDA", rationale: "Second valid.", sourceIds: ["market-nvda"] },
        ],
      }),
      candidates,
      1,
    );

    expect(result.selected.map((selection) => selection.symbol)).toEqual(["AAPL"]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "duplicate-symbol",
      "unknown-symbol",
      "cap-overflow",
    ]);
    expect(result.audit).toMatchObject({
      cap: 1,
      selectedCount: 1,
      rejectedCount: 3,
      malformed: false,
    });
  });

  test("rejects malformed selector JSON and unknown source IDs", () => {
    const candidates = buildSpotlightCandidates({
      marketSnapshots: [marketSnapshot({ symbol: "AAPL", changePercent24h: 5, volume: 2_000_000 })],
    });

    expect(parseSpotlightSelection("{bad", candidates, 2).audit).toMatchObject({
      malformed: true,
      selectedCount: 0,
    });
    expect(
      parseSpotlightSelection(
        JSON.stringify({
          selections: [{ symbol: "AAPL", sourceIds: ["not-current"] }],
        }),
        candidates,
        2,
      ).rejected[0],
    ).toMatchObject({
      reason: "unknown-source-id",
      symbol: "AAPL",
    });
  });

  test("loads alpha watchlist from the sibling alpha-search artifact directory", async () => {
    const dataRoot = join(
      tmpdir(),
      `market-bot-spotlights-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    tmpDirs.push(dataRoot);
    const dataDir = join(dataRoot, "runs");
    await mkdir(join(dataRoot, "alpha-search"), { recursive: true });
    await writeFile(
      join(dataRoot, "alpha-search", "watchlist.json"),
      JSON.stringify({
        generatedAt: "2026-06-04T00:00:00.000Z",
        candidates: [
          {
            symbol: "AAPL",
            seenCount: 1,
            lastSeenAt: "2026-06-04T00:00:00.000Z",
            latestProfile: { discoverySources: ["apewisdom"] },
            latestValidation: [],
          },
        ],
      }),
      "utf8",
    );

    const result = await loadAlphaWatchlistForSpotlights(dataDir);

    expect(result.gap).toBeUndefined();
    expect(result.watchlist?.candidates.map((candidate) => candidate.symbol)).toEqual(["AAPL"]);
  });
});
