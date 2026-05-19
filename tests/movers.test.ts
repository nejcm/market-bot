import { describe, expect, test } from "bun:test";
import type { MarketSnapshot } from "../src/domain/types";
import { rankMovers } from "../src/movers/ranking";

function snapshot(symbol: string, changePercent24h: number, volume: number): MarketSnapshot {
  return {
    sourceId: `src-${symbol}`,
    assetClass: "equity",
    symbol,
    price: 100,
    changePercent24h,
    volume,
    observedAt: "2026-05-19T00:00:00.000Z",
  };
}

describe("rankMovers", () => {
  test("ranks by movement magnitude plus liquidity", () => {
    const ranked = rankMovers(
      [snapshot("SLOW", 2, 5_000_000), snapshot("FAST", -8, 1_000_000), snapshot("THIN", 20, 1000)],
      2,
    );

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["FAST", "SLOW"]);
    expect(ranked.map((mover) => mover.rank)).toEqual([1, 2]);
  });

  test("uses symbol ordering as deterministic final tie breaker", () => {
    const ranked = rankMovers([snapshot("BBB", 5, 1_000_000), snapshot("AAA", -5, 1_000_000)], 2);

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["AAA", "BBB"]);
  });
});
