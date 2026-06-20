import { describe, expect, test } from "bun:test";
import { buildRunChatContext } from "../app/chat-context";
import type { RunDetail, RunSummary } from "../app/types";
import type { VerifiedMarketSnapshot } from "../src/domain/types";

function testSnapshot(overrides: Partial<VerifiedMarketSnapshot> = {}): VerifiedMarketSnapshot {
  return {
    symbol: "X",
    assetClass: "equity",
    analysisDate: "2026-01-01",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    latestSessionDate: "2026-01-01",
    ohlcv: { date: "2026-01-01", open: 1, high: 1, low: 1, close: 1, volume: 1 },
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
    recentCloses: [],
    ...overrides,
  };
}

function minimalSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    findingCount: 0,
    predictionCount: 0,
    sourceCount: 0,
    dataGapCount: 0,
    hasScore: false,
    availableFiles: [],
    ...overrides,
  };
}

function minimalDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    summary: minimalSummary(),
    ...overrides,
  };
}

describe("buildRunChatContext", () => {
  test("includes report markdown as highest priority", () => {
    const detail = minimalDetail({ markdown: "# My Report\n\nSummary text here." });
    const context = buildRunChatContext(detail);

    expect(context).toContain("## Report (markdown)");
    expect(context).toContain("# My Report");
    expect(context).toContain("Summary text here.");
  });

  test("includes score outcomes when present", () => {
    const detail = minimalDetail({
      score: {
        scores: [
          {
            predictionId: "p1",
            outcome: "hit",
            resolved: true,
            observedAt: "2026-06-10T00:00:00.000Z",
            evidence: { close0: 100, closeN: 110 },
          },
        ],
      },
    });
    const context = buildRunChatContext(detail);

    expect(context).toContain("## Forecast score outcomes");
    expect(context).toContain("p1: hit (resolved)");
    expect(context).toContain("close 100 → 110");
    expect(context).toContain("observed 2026-06-10T00:00:00.000Z");
  });

  test("includes structured report fields (predictions, sources, dataGaps)", () => {
    const detail = minimalDetail({
      report: {
        predictions: [
          {
            claim: "SPY goes up",
            probability: 0.65,
            horizonTradingDays: 5,
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
          },
        ],
        sources: [{ id: "src-1", title: "Yahoo Finance", kind: "market-data" }],
        dataGaps: ["Missing crypto volume data"],
      },
    });
    const context = buildRunChatContext(detail);

    expect(context).toContain("## Structured report data");
    expect(context).toContain("SPY goes up");
    expect(context).toContain("p=0.65");
    expect(context).toContain("[5td]");
    expect(context).toContain("close(SPY, +5) > close(SPY, 0)");
    expect(context).toContain("src-1: Yahoo Finance [market-data]");
    expect(context).toContain("Missing crypto volume data");
  });

  test("includes verified market snapshot when present", () => {
    const detail = minimalDetail({
      verifiedMarketSnapshot: testSnapshot({
        symbol: "AAPL",
        analysisDate: "2026-06-05",
        fetchedAt: "2026-06-05T00:00:00.000Z",
        latestSessionDate: "2026-06-04",
        ohlcv: {
          date: "2026-06-04",
          open: 190,
          high: 195,
          low: 189,
          close: 193,
          volume: 50_000_000,
        },
        recentCloses: [
          { date: "2026-06-03", close: 191 },
          { date: "2026-06-04", close: 193 },
        ],
      }),
    });
    const context = buildRunChatContext(detail);

    expect(context).toContain("## Verified market snapshot");
    expect(context).toContain("Symbol: AAPL");
    expect(context).toContain("Analysis date: 2026-06-05");
    expect(context).toContain("open=190");
    expect(context).toContain("close=193");
    expect(context).toContain("2026-06-03: 191");
  });

  test("includes normalized sidecar listing when present", () => {
    const detail = minimalDetail({
      summary: minimalSummary({
        availableFiles: [
          "report.json",
          "normalized/source-gaps.json",
          "normalized/movers.json",
          "normalized/verified-market-snapshot.json",
        ],
      }),
    });
    const context = buildRunChatContext(detail);

    expect(context).toContain("## Normalized sidecars");
    expect(context).toContain("normalized/source-gaps.json");
    expect(context).toContain("normalized/movers.json");
    // Verified-market-snapshot is excluded (already shown as its own section)
    expect(context).not.toContain("normalized/verified-market-snapshot.json");
  });

  test("excludes trace.json from context (large, redundant)", () => {
    const detail = minimalDetail({
      markdown: "# Report",
      trace: { stages: [{ name: "synthesis", tokens: 5000 }] },
    });
    const context = buildRunChatContext(detail);

    expect(context).not.toContain("trace");
    expect(context).not.toContain("synthesis");
  });

  test("priority order: markdown > score > report fields > snapshot > sidecars", () => {
    const detail = minimalDetail({
      markdown: "# Report Markdown",
      score: { scores: [{ predictionId: "p1", outcome: "hit", resolved: true }] },
      report: { predictions: [{ claim: "Up", probability: 0.7 }], sources: [], dataGaps: [] },
      verifiedMarketSnapshot: testSnapshot(),
      summary: minimalSummary({ availableFiles: ["normalized/movers.json"] }),
    });
    const context = buildRunChatContext(detail);

    const markdownPos = context.indexOf("## Report (markdown)");
    const scorePos = context.indexOf("## Forecast score outcomes");
    const reportPos = context.indexOf("## Structured report data");
    const snapshotPos = context.indexOf("## Verified market snapshot");
    const sidecarPos = context.indexOf("## Normalized sidecars");

    expect(markdownPos).toBeGreaterThanOrEqual(0);
    expect(scorePos).toBeGreaterThan(markdownPos);
    expect(reportPos).toBeGreaterThan(scorePos);
    expect(snapshotPos).toBeGreaterThan(reportPos);
    expect(sidecarPos).toBeGreaterThan(snapshotPos);
  });

  test("drops lowest-priority sections when over budget", () => {
    const longMarkdown = "A".repeat(500);
    const detail = minimalDetail({
      markdown: longMarkdown,
      score: { scores: [{ predictionId: "p1", outcome: "hit", resolved: true }] },
      report: {
        predictions: [{ claim: "Test claim", probability: 0.5 }],
        sources: [],
        dataGaps: [],
      },
      summary: minimalSummary({ availableFiles: ["normalized/movers.json"] }),
    });

    // Budget only enough for markdown + score
    const context = buildRunChatContext(detail, 600);

    expect(context).toContain("## Report (markdown)");
    expect(context).toContain("## Forecast score outcomes");
    expect(context).not.toContain("## Structured report data");
    expect(context).toContain("[context truncated:");
    expect(context).toContain("section(s) omitted]");
  });

  test("truncation marker reports correct omission count", () => {
    const detail = minimalDetail({
      markdown: "A".repeat(400),
      score: { scores: [{ predictionId: "p1", outcome: "hit", resolved: true }] },
      report: { predictions: [{ claim: "C", probability: 0.5 }], sources: [], dataGaps: [] },
      verifiedMarketSnapshot: testSnapshot(),
      summary: minimalSummary({ availableFiles: ["normalized/movers.json"] }),
    });

    // Very tight budget — only fits markdown
    const context = buildRunChatContext(detail, 450);

    expect(context).toContain("[context truncated: 4 section(s) omitted]");
  });

  test("returns empty string for empty detail", () => {
    const detail = minimalDetail();
    const context = buildRunChatContext(detail);

    expect(context).toBe("");
  });

  test("skips empty markdown", () => {
    const detail = minimalDetail({ markdown: "   " });
    const context = buildRunChatContext(detail);

    expect(context).not.toContain("Report (markdown)");
  });

  test("handles score with no scores array gracefully", () => {
    const detail = minimalDetail({ score: {} });
    const context = buildRunChatContext(detail);

    expect(context).not.toContain("Forecast score outcomes");
  });

  test("handles pending (unresolved) scores", () => {
    const detail = minimalDetail({
      score: {
        scores: [{ predictionId: "p1", outcome: "pending", resolved: false }],
      },
    });
    const context = buildRunChatContext(detail);

    expect(context).toContain("p1: pending (pending)");
  });
});
