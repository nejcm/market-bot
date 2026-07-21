import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../app/types";
import { buildRunWorkspaceView, type RunWorkspaceView } from "../app/client/run-workspace-view";
import { VERIFIED_SNAPSHOT_PATH } from "../app/client/view-model";
import type { VerifiedMarketSnapshot } from "../src/domain/types";

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    findingCount: 0,
    predictionCount: 0,
    sourceCount: 0,
    dataGapCount: 0,
    hasScore: false,
    availableFiles: [],
    ...overrides,
  };
}

function snapshot(): VerifiedMarketSnapshot {
  return {
    symbol: "AAPL",
    assetClass: "equity",
    analysisDate: "2026-07-04",
    fetchedAt: "2026-07-04T12:00:00.000Z",
    latestSessionDate: "2026-07-03",
    ohlcv: {
      date: "2026-07-03",
      open: 208,
      high: 212,
      low: 207,
      close: 211,
      volume: 1000,
    },
    indicators: {
      ema10: 209,
      sma50: 205,
      sma200: 190,
      rsi14: 58,
      macd: 2,
      macdSignal: 1.5,
      macdHistogram: 0.5,
      bollUpper: 216,
      bollMiddle: 207,
      bollLower: 198,
      atr14: 4,
    },
    recentCloses: [
      { date: "2026-07-02", close: 209 },
      { date: "2026-07-03", close: 211 },
    ],
  };
}

function tocKeys(view: RunWorkspaceView): readonly string[] {
  return view.tableOfContents.map((entry) => entry.key);
}

describe("run workspace view", () => {
  test("builds populated report, forecast, evidence, gap, source, and snapshot sections", () => {
    const detail: RunDetail = {
      summary: summary({
        availableFiles: [VERIFIED_SNAPSHOT_PATH, "score.json"],
        hasScore: true,
      }),
      report: {
        summary: "Apple research summary.",
        keyFindings: [{ text: "Demand remains durable.", sourceIds: ["source-1"] }],
        bullCase: [{ text: "Margins expand.", sourceIds: ["source-1"] }],
        scenarios: [
          {
            name: "Base",
            description: "Steady demand.",
            sourceIds: ["source-1"],
          },
        ],
        predictions: [
          {
            id: "prediction-1",
            claim: "AAPL rises.",
            kind: "direction",
            subject: "AAPL",
            measurableAs: "AAPL close > 211",
            probability: 0.6,
            horizonTradingDays: 5,
            sourceIds: ["source-1"],
          },
        ],
        dataGaps: ["predictionShortfall: emitted 1 of 3", "No channel inventory data."],
        sources: [
          {
            id: "source-1",
            title: "Market data",
            kind: "market-data",
            provider: "test",
            url: "https://example.com/market",
          },
        ],
        extendedEvidence: {
          items: [
            {
              category: "valuation",
              title: "Valuation",
              summary: "Multiples remain elevated.",
              sourceIds: ["source-1"],
            },
          ],
        },
      },
      score: {
        scores: [
          {
            predictionId: "prediction-1",
            resolved: true,
            outcome: "hit",
            evidence: { close0: 211, closeN: 215 },
          },
        ],
      },
      analytics: {
        predictions: { count: 1, targetCount: 3, targetMet: false },
      },
      verifiedMarketSnapshot: snapshot(),
    };

    const view = buildRunWorkspaceView(detail);

    expect(view.report.summary).toBe("Apple research summary.");
    expect(view.report.findings).toEqual([
      { text: "Demand remains durable.", sourceIds: ["source-1"] },
    ]);
    expect(view.report.cases[0]?.title).toBe("Bull case");
    expect(view.report.scenarios[0]?.name).toBe("Base");
    expect(view.forecasts.items[0]?.score?.outcome).toBe("hit");
    expect(view.forecasts.stats).toMatchObject({ total: 1, resolved: 1, hits: 1 });
    expect(view.forecasts.targetHealth).toEqual({ count: 1, target: 3, targetMet: false });
    expect(view.evidence.extendedItems[0]?.title).toBe("Valuation");
    expect(view.gaps).toMatchObject({
      shortfalls: ["predictionShortfall: emitted 1 of 3"],
      otherGaps: ["No channel inventory data."],
      visible: true,
    });
    expect(view.sources.items[0]?.id).toBe("source-1");
    expect(view.snapshot?.value.symbol).toBe("AAPL");
    expect(view.snapshot?.tradingViewUrl).toContain("AAPL");
    expect(tocKeys(view)).toEqual([
      "summary",
      "findings",
      "cases",
      "scenarios",
      "snapshot",
      "extendedEvidence",
      "forecasts",
      "gaps",
    ]);
  });

  test("ignores sparse or malformed optional artifacts", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      report: {
        summary: 42,
        keyFindings: "broken",
        scenarios: [null, { name: "Incomplete" }],
        predictions: "broken",
        dataGaps: [null, 42],
        sources: [{ id: "missing-title" }],
        extendedEvidence: "broken",
      },
      analytics: { predictions: "broken" },
      trace: { historicalContext: "broken" },
      score: { scores: "broken" },
      missAutopsy: { autopsies: "broken" },
    });

    expect(view.report).toMatchObject({
      summary: "",
      findings: [],
      cases: [],
      scenarios: [],
    });
    expect(view.forecasts).toMatchObject({ items: [], groups: [], visible: false });
    expect(view.evidence.extendedItems).toEqual([]);
    expect(view.gaps).toMatchObject({ shortfalls: [], otherGaps: [], visible: false });
    expect(view.sources.items).toEqual([]);
    expect(view.snapshot).toBeUndefined();
    expect(view.tableOfContents).toEqual([]);
  });

  test("shows forecasts and table-of-contents entries for a disclosed forecast shortfall", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      report: {
        dataGaps: ["predictionShortfall: emitted 0 of 3"],
      },
    });

    expect(view.forecasts.visible).toBe(true);
    expect(view.forecasts.items).toEqual([]);
    expect(tocKeys(view)).toEqual(["forecasts", "gaps"]);
  });

  test("groups legacy financial lens metrics by lens and retains posture", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      financialLenses: {
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
            ],
          },
          {
            name: "Momentum",
            posture: "criteria-mixed",
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
        sourceIds: ["extended-sec-edgar-aapl-fundamentals", "verified-snapshot-AAPL"],
      },
    });

    expect(view.report.financialLensGroups).toEqual([
      {
        lens: "Quality",
        posture: "criteria-supported",
        tiles: [expect.objectContaining({ key: "grossMargin", lens: "Quality", tone: "strong" })],
      },
      {
        lens: "Momentum",
        posture: "criteria-mixed",
        tiles: [expect.objectContaining({ key: "rsi14", lens: "Momentum", tone: "strong" })],
      },
    ]);
    expect(tocKeys(view)).toEqual(["financialLensStats"]);
  });

  test("requires snapshot job type, file availability, and valid content", () => {
    const eligible: RunDetail = {
      summary: summary({ availableFiles: [VERIFIED_SNAPSHOT_PATH] }),
      verifiedMarketSnapshot: snapshot(),
    };
    expect(buildRunWorkspaceView(eligible).snapshot?.value.symbol).toBe("AAPL");

    expect(
      buildRunWorkspaceView({
        ...eligible,
        summary: summary({
          jobType: "market-overview",
          availableFiles: [VERIFIED_SNAPSHOT_PATH],
        }),
      }).snapshot,
    ).toBeUndefined();

    expect(
      buildRunWorkspaceView({
        ...eligible,
        summary: summary({ availableFiles: [] }),
      }).snapshot,
    ).toBeUndefined();

    expect(
      buildRunWorkspaceView({
        ...eligible,
        verifiedMarketSnapshot: {
          ...snapshot(),
          recentCloses: [{ date: "2026-07-03", close: 211 }],
        },
      }).snapshot,
    ).toBeUndefined();
  });
});
