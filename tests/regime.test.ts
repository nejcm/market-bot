import { describe, expect, test } from "bun:test";
import type { MarketContext, MarketRegimeSummary, MarketSnapshot } from "../src/domain/types";
import { addMarketContextToRegime, summarizeMarketRegime } from "../src/research/regime";

function snapshot(
  symbol: string,
  changePercent24h: number,
  price = 100,
  fiftyDayAverage?: number,
): MarketSnapshot {
  return {
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass: symbol === "BTC" || symbol === "ETH" ? "crypto" : "equity",
    symbol,
    price,
    changePercent24h,
    volume: 1_000_000,
    ...(fiftyDayAverage !== undefined ? { fiftyDayAverage } : {}),
    observedAt: "2026-05-19T00:00:00.000Z",
  };
}

describe("summarizeMarketRegime", () => {
  test("classifies equity regime from breadth proxies and volatility", () => {
    const summary = summarizeMarketRegime("equity", [
      snapshot("SPY", -1.2),
      snapshot("QQQ", -1.5),
      snapshot("IWM", -2.1),
      snapshot("^VIX", 12, 29),
    ]);

    expect(summary).toMatchObject({
      assetClass: "equity",
      label: "risk-off",
      proxyCount: 4,
    });
    expect(summary.sourceIds).toEqual(["market-spy", "market-qqq", "market-iwm", "market-^vix"]);
    expect(summary.drivers).toContain("equity breadth proxies negative: 3/3");
    expect(summary.drivers).toContain("VIX elevated at 29");
  });

  test("classifies crypto regime from major asset breadth", () => {
    const summary = summarizeMarketRegime("crypto", [
      snapshot("BTC", 2),
      snapshot("ETH", 3),
      snapshot("SOL", -1),
    ]);

    expect(summary).toMatchObject({
      assetClass: "crypto",
      label: "risk-on",
      proxyCount: 2,
    });
    expect(summary.drivers).toContain("major crypto proxies positive: 2/2");
  });

  test("uses elevated VIX as an explicit equity risk-off driver without breadth", () => {
    const summary = summarizeMarketRegime("equity", [
      {
        ...snapshot("^VIX", 0, 28),
        assetClass: "crypto",
      },
    ]);

    expect(summary).toMatchObject({
      assetClass: "equity",
      label: "risk-off",
      proxyCount: 1,
    });
    expect(summary.drivers).toEqual(["equity breadth proxies unavailable", "VIX elevated at 28"]);
  });

  test("reports zero-change breadth as mixed without dropping proxy coverage", () => {
    const summary = summarizeMarketRegime("equity", [snapshot("SPY", 0), snapshot("QQQ", 0)]);

    expect(summary).toMatchObject({
      label: "mixed",
      proxyCount: 2,
    });
    expect(summary.drivers).toEqual(["equity breadth proxies mixed: 0/2"]);
  });

  test("ignores VIX when summarizing crypto regime", () => {
    const summary = summarizeMarketRegime("crypto", [snapshot("BTC", 2), snapshot("^VIX", 0, 40)]);

    expect(summary).toMatchObject({
      assetClass: "crypto",
      label: "risk-on",
      proxyCount: 1,
    });
    expect(summary.sourceIds).toEqual(["market-btc"]);
    expect(summary.drivers).toEqual(["major crypto proxies positive: 1/1"]);
  });

  test("classifies risk-on from agreeing breadth and trend with calm term structure", () => {
    const summary = summarizeMarketRegime("equity", [
      snapshot("SPY", 0.8, 105, 100),
      snapshot("QQQ", 1.1, 210, 200),
      snapshot("IWM", 0.5, 102, 100),
      snapshot("DIA", 0.3, 101, 100),
      snapshot("^VIX", -3, 16),
      snapshot("^VIX3M", -1, 18),
    ]);

    expect(summary).toMatchObject({ assetClass: "equity", label: "risk-on", proxyCount: 6 });
    expect(summary.drivers).toContain("equity breadth proxies positive: 4/4");
    expect(summary.drivers).toContain("trend positive: 4/4 proxies above 50-day average");
    expect(summary.drivers).toContain("VIX term structure contango: VIX 16.00 vs VIX3M 18.00");
    expect(summary.sourceIds).toContain("market-^vix3m");
  });

  test("treats VIX backwardation as risk-off without the elevated-VIX override", () => {
    const summary = summarizeMarketRegime("equity", [
      snapshot("SPY", 1, 101, 100),
      snapshot("QQQ", -1, 99, 100),
      snapshot("^VIX", 5, 22),
      snapshot("^VIX3M", 1, 20),
    ]);

    expect(summary.label).toBe("risk-off");
    expect(summary.drivers).toContain("VIX term structure backwardation: VIX 22.00 vs VIX3M 20.00");
    expect(summary.drivers).not.toContain("VIX elevated at 22");
  });

  test("reports mixed when breadth and trend drivers disagree", () => {
    const summary = summarizeMarketRegime("equity", [
      snapshot("SPY", 0.9, 95, 100),
      snapshot("QQQ", 1.2, 190, 200),
      snapshot("IWM", 0.4, 96, 100),
      snapshot("DIA", 0.6, 97, 100),
      snapshot("^VIX", -2, 15),
      snapshot("^VIX3M", -1, 17),
    ]);

    expect(summary.label).toBe("mixed");
    expect(summary.drivers).toContain("equity breadth proxies positive: 4/4");
    expect(summary.drivers).toContain("trend negative: 4/4 proxies below 50-day average");
  });

  test("falls back to insufficient-data when no driver has inputs", () => {
    const summary = summarizeMarketRegime("equity", [snapshot("AAPL", 1.5)]);

    expect(summary.label).toBe("insufficient-data");
    expect(summary.label).not.toBe("risk-on");
    expect(summary.drivers).toEqual(["equity breadth proxies unavailable"]);
    expect(summary.proxyCount).toBe(0);
  });
});

describe("addMarketContextToRegime", () => {
  const regime: MarketRegimeSummary = {
    assetClass: "equity",
    label: "risk-on",
    proxyCount: 2,
    drivers: ["equity breadth proxies positive: 2/2"],
    sourceIds: ["market-spy"],
  };

  test("leaves regime unchanged without market context", () => {
    const missingContext: MarketContext | undefined = undefined;

    expect(addMarketContextToRegime(regime, missingContext)).toBe(regime);
    expect(addMarketContextToRegime(regime, { assetClass: "equity", items: [], gaps: [] })).toBe(
      regime,
    );
  });

  test("adds explicit DGS10 macro driver and deduplicates source ids", () => {
    const context: MarketContext = {
      assetClass: "equity",
      gaps: [],
      items: [
        {
          category: "fred-macro",
          title: "FRED macro Market Context",
          summary: "Macro context",
          sourceIds: ["market-spy", "market-context-fred-macro"],
          observedAt: "2026-05-19T00:00:00.000Z",
          metrics: {
            DGS2: 3.9,
            DGS10: 4.25,
            DGS10Change: 0.1,
            DGS10Date: "2026-05-18",
            DGS10Prior: 4.15,
            DGS10PriorDate: "2026-05-17",
          },
        },
      ],
    };

    const summary = addMarketContextToRegime(regime, context);

    expect(summary.label).toBe("risk-on");
    expect(summary.drivers).toEqual([
      "equity breadth proxies positive: 2/2",
      "FRED macro context: DGS10 4.25",
    ]);
    expect(summary.sourceIds).toEqual(["market-spy", "market-context-fred-macro"]);
  });

  test("skips macro driver when context has no base numeric metric", () => {
    const context: MarketContext = {
      assetClass: "equity",
      gaps: [],
      items: [
        {
          category: "fred-macro",
          title: "FRED macro Market Context",
          summary: "Macro context",
          sourceIds: ["market-context-fred-macro"],
          observedAt: "2026-05-19T00:00:00.000Z",
          metrics: {
            DGS10Change: 0.1,
            DGS10Date: "2026-05-18",
          },
        },
      ],
    };

    const summary = addMarketContextToRegime(regime, context);

    expect(summary.drivers).toEqual(regime.drivers);
    expect(summary.sourceIds).toEqual(["market-spy", "market-context-fred-macro"]);
  });
});
