import { describe, expect, test } from "bun:test";
import type { MarketSnapshot } from "../src/domain/types";
import { rankMovers } from "../src/movers/ranking";

function snapshot(
  symbol: string,
  changePercent24h: number,
  volume: number,
  overrides: Partial<MarketSnapshot> = {},
): MarketSnapshot {
  return {
    sourceId: `src-${symbol}`,
    assetClass: "equity",
    symbol,
    price: 100,
    changePercent24h,
    volume,
    observedAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
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
    expect(ranked[0]?.features).toMatchObject({
      movementMagnitude: 8,
      liquidityLog: 6,
      baseScore: 48,
      unusualVolumeBoost: 0,
      gapBoost: 0,
      finalMultiplier: 1,
      reasons: ["8% absolute 24h move", "log10 volume 6"],
    });
  });

  test("uses symbol ordering as deterministic final tie breaker", () => {
    const ranked = rankMovers([snapshot("BBB", 5, 1_000_000), snapshot("AAA", -5, 1_000_000)], 2);

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["AAA", "BBB"]);
  });

  test("adds benchmark-relative context without changing absolute-move ranking", () => {
    const ranked = rankMovers(
      [
        snapshot("ABS", 8, 1_000_000, {
          benchmark: {
            sourceId: "market-yahoo-equity-spy",
            symbol: "SPY",
            basis: "broad-index",
            changePercent24h: 7,
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        }),
        snapshot("REL", 5, 1_000_000, {
          benchmark: {
            sourceId: "market-yahoo-equity-xlk",
            symbol: "XLK",
            basis: "sector-etf",
            sector: "Technology",
            changePercent24h: -4,
            observedAt: "2026-05-19T00:00:00.000Z",
          },
        }),
      ],
      2,
    );

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["ABS", "REL"]);
    expect(ranked[1]?.features).toMatchObject({
      benchmarkSymbol: "XLK",
      benchmarkChangePercent24h: -4,
      relativeChangePercent24h: 9,
      relativeMovementMagnitude: 9,
      baseScore: 30,
    });
    expect(ranked[1]?.features.reasons).toContain("9pp move vs XLK");
  });

  test("boosts unusual volume without replacing the baseline score", () => {
    const ranked = rankMovers(
      [snapshot("AAA", 5, 1_000_000), snapshot("ZZZ", 5, 1_000_000, { averageVolume: 500_000 })],
      2,
    );

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["ZZZ", "AAA"]);
    expect(ranked[0]?.features.unusualVolumeRatio).toBe(2);
    expect(ranked[0]?.features.unusualVolumeBoost).toBe(0.125);
    expect(ranked[0]?.features.finalMultiplier).toBe(1.125);
    expect(ranked[0]?.features.reasons).toContain("volume 2x average");
  });

  test("boosts absolute gap size symmetrically", () => {
    const ranked = rankMovers(
      [
        snapshot("AAA", 5, 1_000_000),
        snapshot("ZZZ", -5, 1_000_000, { open: 95, previousClose: 100 }),
      ],
      2,
    );

    expect(ranked.map((mover) => mover.snapshot.symbol)).toEqual(["ZZZ", "AAA"]);
    expect(ranked[0]?.features.gapPercent).toBe(-5);
    expect(ranked[0]?.features.gapBoost).toBe(0.1);
    expect(ranked[0]?.features.finalMultiplier).toBe(1.1);
    expect(ranked[0]?.features.reasons).toContain("5% absolute opening gap");
  });

  test("caps optional mover feature boosts", () => {
    const [ranked] = rankMovers(
      [
        snapshot("CAP", 5, 1_000_000, {
          averageVolume: 1000,
          open: 150,
          previousClose: 100,
        }),
      ],
      1,
    );

    expect(ranked?.features.unusualVolumeBoost).toBe(0.25);
    expect(ranked?.features.gapBoost).toBe(0.2);
    expect(ranked?.features.finalMultiplier).toBe(1.45);
  });

  test("ignores invalid optional mover feature fields", () => {
    const [ranked] = rankMovers(
      [
        snapshot("BAD", 5, 1_000_000, {
          averageVolume: 0,
          open: Number.NaN,
          previousClose: 100,
        }),
      ],
      1,
    );

    expect(ranked?.features.unusualVolumeRatio).toBeUndefined();
    expect(ranked?.features.gapPercent).toBeUndefined();
    expect(ranked?.features.unusualVolumeBoost).toBe(0);
    expect(ranked?.features.gapBoost).toBe(0);
  });
});
