import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../app/types";
import { buildRunWorkspaceView, type RunWorkspaceView } from "../app/client/run-workspace-view";
import { VERIFIED_SNAPSHOT_PATH } from "../app/client/view-model";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../src/domain/types";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";

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

function marketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    sourceId: "market-yahoo-equity-aapl",
    assetClass: "equity",
    symbol: "AAPL",
    name: "Apple",
    identity: { displayName: "Apple Inc.", quoteCurrency: "USD" },
    price: 211.25,
    changePercent24h: 1.4,
    volume: 62_000_000,
    marketCap: 3_000_000_000_000,
    fundamentals: {
      trailingPE: 31,
      forwardPE: 28,
      dividendYield: 0.36,
      sharesOutstanding: 15_000_000_000,
    },
    observedAt: "2026-07-04T12:00:00.000Z",
    ...overrides,
  };
}

function fundamentalHistoryAnnualFacts(values: readonly number[]) {
  return values.map((val, index) => {
    const fy = 2022 + index;
    return {
      val,
      form: "10-K",
      fp: "FY",
      fy,
      filed: `${String(fy)}-11-01`,
      start: `${String(fy - 1)}-10-01`,
      end: `${String(fy)}-09-30`,
    };
  });
}

function fundamentalHistoryFixture(epsValues: readonly number[] = [2, 2.5, 6.13]) {
  return deriveFundamentalHistory(
    {
      facts: {
        "us-gaap": {
          Revenues: { units: { USD: fundamentalHistoryAnnualFacts([100, 120, 150]) } },
          GrossProfit: { units: { USD: fundamentalHistoryAnnualFacts([40, 50, 66]) } },
          OperatingIncomeLoss: {
            units: { USD: fundamentalHistoryAnnualFacts([25, 32, 42]) },
          },
          NetIncomeLoss: { units: { USD: fundamentalHistoryAnnualFacts([20, 25, 33]) } },
          EarningsPerShareDiluted: {
            units: { "USD/shares": fundamentalHistoryAnnualFacts(epsValues) },
          },
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: fundamentalHistoryAnnualFacts([30, 36, 45]) },
          },
          PaymentsToAcquirePropertyPlantAndEquipment: {
            units: { USD: fundamentalHistoryAnnualFacts([8, 9, 10]) },
          },
        },
      },
    },
    {
      symbol: "AAPL",
      generatedAt: "2025-08-01T00:00:00.000Z",
      analysisAsOf: "2025-08-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

function tocKeys(view: RunWorkspaceView): readonly string[] {
  return view.tableOfContents.map((entry) => entry.key);
}

describe("run workspace view", () => {
  test("projects fundamental history into pre-scaled sparkline cards", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryFixture(),
    });
    const subDollarView = buildRunWorkspaceView({
      summary: summary(),
      fundamentalHistory: fundamentalHistoryFixture([2, 1, 0.5]),
    });

    expect(view.fundamentalHistory?.cards.map((card) => card.key)).toEqual([
      "revenue",
      "freeCashFlowProxy",
      "dilutedEps",
      "grossMargin",
      "operatingMargin",
      "netMargin",
    ]);
    expect(view.fundamentalHistory?.cards[0]).toMatchObject({
      value: "$150",
      trendLabel: expect.stringContaining("CAGR"),
      periodRange: "FY 2022–FY 2024 · 2022-09-30 to 2024-09-30",
      sourceCaption: "SEC EDGAR · companyfacts",
    });
    expect(view.fundamentalHistory?.cards.find((card) => card.key === "dilutedEps")?.value).toBe(
      "$6.13",
    );
    expect(
      subDollarView.fundamentalHistory?.cards.find((card) => card.key === "dilutedEps")?.value,
    ).toBe("$0.50");
    expect(
      view.fundamentalHistory?.cards.every(
        (card) =>
          card.geometry.baseline >= 0 &&
          card.geometry.baseline <= 1 &&
          card.geometry.bars.every(
            (bar) =>
              bar.x >= 0 &&
              bar.x <= 1 &&
              bar.y >= 0 &&
              bar.y <= 1 &&
              bar.width >= 0 &&
              bar.width <= 1 &&
              bar.height >= 0 &&
              bar.height <= 1,
          ),
      ),
    ).toBe(true);
    expect(tocKeys(view)).toContain("fundamentalHistory");
  });

  test("omits the fundamental-history projection for old runs without the sidecar", () => {
    const view = buildRunWorkspaceView({ summary: summary() });

    expect(view.fundamentalHistory).toBeUndefined();
    expect(tocKeys(view)).not.toContain("fundamentalHistory");
  });

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

  test("projects a matching equity snapshot into an unassessed header", () => {
    const view = buildRunWorkspaceView({
      summary: summary(),
      marketSnapshots: [marketSnapshot()],
    });

    expect(view.equityHeader).toEqual({
      displayName: "Apple Inc.",
      symbol: "AAPL",
      price: "$211",
      quoteCurrency: "USD",
      dailyChange: "+1.4%",
      changeDirection: "positive",
      asOf: "Yahoo quote · 2026-07-04T12:00:00.000Z",
      financials: [
        {
          key: "marketCap",
          label: "Market cap",
          value: "$3000.0B",
          caption: "Yahoo quote · point in time · 2026-07-04T12:00:00.000Z",
        },
        {
          key: "trailingPE",
          label: "Trailing P/E",
          value: "31.00x",
          caption: "Yahoo quote · trailing 12M · 2026-07-04T12:00:00.000Z",
        },
        {
          key: "forwardPE",
          label: "Forward P/E",
          value: "28.00x",
          caption: "Yahoo quote · forward · 2026-07-04T12:00:00.000Z",
        },
        {
          key: "dividendYield",
          label: "Dividend yield",
          value: "0.4%",
          caption: "Yahoo quote · quote snapshot · 2026-07-04T12:00:00.000Z",
        },
        {
          key: "sharesOutstanding",
          label: "Shares outstanding",
          value: "15.0B",
          caption: "Yahoo quote · point in time · 2026-07-04T12:00:00.000Z",
        },
      ],
    });
  });

  test("passes through GBp quote currency formatting", () => {
    const {
      marketCap: _marketCap,
      fundamentals: _fundamentals,
      ...gbpSnapshot
    } = marketSnapshot({
      symbol: "rr.l",
      identity: { displayName: "Rolls-Royce Holdings", quoteCurrency: "GBp" },
      price: 912.4,
    });
    const view = buildRunWorkspaceView({
      summary: summary({ symbol: "RR.L" }),
      marketSnapshots: [gbpSnapshot],
    });

    expect(view.equityHeader).toMatchObject({ price: "912.4p", quoteCurrency: "GBp" });
  });

  test("omits the equity header without snapshots or without an asset and symbol match", () => {
    expect(buildRunWorkspaceView({ summary: summary() }).equityHeader).toBeUndefined();

    const researchView = buildRunWorkspaceView({
      summary: summary({ jobType: "research", assetClass: "research", symbol: "AI" }),
      marketSnapshots: [marketSnapshot()],
    });
    expect(researchView.equityHeader).toBeUndefined();

    const mismatchedView = buildRunWorkspaceView({
      summary: summary(),
      marketSnapshots: [marketSnapshot({ symbol: "MSFT" })],
    });
    expect(mismatchedView.equityHeader).toBeUndefined();
  });

  test("falls back from identity display name to snapshot name and symbol", () => {
    const named = buildRunWorkspaceView({
      summary: summary(),
      marketSnapshots: [marketSnapshot({ identity: { quoteCurrency: "USD" } })],
    });
    const { name: _name, ...unnamedSnapshot } = marketSnapshot({
      identity: { quoteCurrency: "USD" },
    });
    const symbolOnly = buildRunWorkspaceView({
      summary: summary(),
      marketSnapshots: [unnamedSnapshot],
    });

    expect(named.equityHeader?.displayName).toBe("Apple");
    expect(symbolOnly.equityHeader?.displayName).toBe("AAPL");
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
