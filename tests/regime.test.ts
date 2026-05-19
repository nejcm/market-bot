import { describe, expect, test } from "bun:test";
import type { MarketSnapshot } from "../src/domain/types";
import { summarizeMarketRegime } from "../src/research/regime";

function snapshot(symbol: string, changePercent24h: number, price = 100): MarketSnapshot {
  return {
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass: symbol === "BTC" || symbol === "ETH" ? "crypto" : "equity",
    symbol,
    price,
    changePercent24h,
    volume: 1_000_000,
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
});
