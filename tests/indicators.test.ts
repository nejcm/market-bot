import { describe, expect, test } from "bun:test";
import { computeIndicators, MIN_BARS_FOR_SNAPSHOT, SMA200_PERIOD } from "../src/sources/indicators";
import type { OhlcvBar } from "../src/domain/types";

function bar(date: string, close: number, opts?: Partial<OhlcvBar>): OhlcvBar {
  return {
    date,
    open: opts?.open ?? close,
    high: opts?.high ?? close + 1,
    low: opts?.low ?? close - 1,
    close,
    volume: opts?.volume ?? 1_000_000,
  };
}

function bars(count: number, startClose = 100, step = 0.1): readonly OhlcvBar[] {
  return Array.from({ length: count }, (_, i) => {
    const c = startClose + i * step;
    return bar(`2024-01-${String(i + 1).padStart(2, "0")}`, c);
  });
}

describe("computeIndicators", () => {
  test("returns all nulls for empty bars", () => {
    const result = computeIndicators([]);
    expect(result.ema10).toBeNull();
    expect(result.sma50).toBeNull();
    expect(result.sma200).toBeNull();
    expect(result.rsi14).toBeNull();
    expect(result.macd).toBeNull();
    expect(result.macdSignal).toBeNull();
    expect(result.macdHistogram).toBeNull();
    expect(result.bollUpper).toBeNull();
    expect(result.bollMiddle).toBeNull();
    expect(result.bollLower).toBeNull();
    expect(result.atr14).toBeNull();
  });

  test("returns all nulls for a single bar", () => {
    const result = computeIndicators([bar("2024-01-01", 100)]);
    expect(result.ema10).toBeNull();
    expect(result.sma200).toBeNull();
    expect(result.rsi14).toBeNull();
    expect(result.macd).toBeNull();
    expect(result.atr14).toBeNull();
  });

  test("returns non-null ema10 but null sma200 when bars >= 10 and < 200", () => {
    const result = computeIndicators(bars(50));
    expect(result.ema10).not.toBeNull();
    expect(result.sma50).not.toBeNull();
    expect(result.sma200).toBeNull();
  });

  test("threshold 59 bars: snapshot below MIN_BARS_FOR_SNAPSHOT boundary", () => {
    const result = computeIndicators(bars(59));
    expect(result.ema10).not.toBeNull();
    expect(result.sma50).not.toBeNull();
    expect(result.rsi14).not.toBeNull();
    expect(result.sma200).toBeNull();
  });

  test("threshold 60 bars: at MIN_BARS_FOR_SNAPSHOT, core indicators non-null", () => {
    const result = computeIndicators(bars(60));
    expect(result.ema10).not.toBeNull();
    expect(result.sma50).not.toBeNull();
    expect(result.rsi14).not.toBeNull();
    expect(result.sma200).toBeNull();
  });

  test("threshold 199 bars: sma200 still null below SMA200_PERIOD", () => {
    const result = computeIndicators(bars(199));
    expect(result.sma200).toBeNull();
  });

  test("threshold 200 bars: sma200 non-null at SMA200_PERIOD", () => {
    const result = computeIndicators(bars(200));
    expect(result.sma200).not.toBeNull();
  });

  test("sma50 equals simple average of last 50 closes", () => {
    // 60 bars at 100..159; last 50 closes are 110..159, average = 134.5
    const testBars = bars(60, 100, 1);
    const result = computeIndicators(testBars);
    expect(result.sma50).toBeCloseTo(134.5, 5);
  });

  test("sma200 equals simple average of last 200 closes", () => {
    // 200 bars at 1..200; average = 100.5
    const testBars = bars(200, 1, 1);
    const result = computeIndicators(testBars);
    expect(result.sma200).toBeCloseTo(100.5, 5);
  });

  test("RSI is 100 when all closes are rising (no down moves)", () => {
    // Strictly increasing closes — no down moves → RSI = 100
    const rising = bars(30, 100, 1);
    const result = computeIndicators(rising);
    expect(result.rsi14).toBeCloseTo(100, 1);
  });

  test("RSI is in [0, 100] range for a trending series", () => {
    const result = computeIndicators(bars(100, 100, 0.5));
    expect(result.rsi14).not.toBeNull();
    expect(result.rsi14!).toBeGreaterThanOrEqual(0);
    expect(result.rsi14!).toBeLessThanOrEqual(100);
  });

  test("bollinger bands: upper > middle > lower for a flat series", () => {
    const flatish = bars(30, 100, 0);
    const result = computeIndicators(flatish);
    expect(result.bollUpper).not.toBeNull();
    expect(result.bollMiddle).not.toBeNull();
    expect(result.bollLower).not.toBeNull();
    expect(result.bollMiddle!).toBeCloseTo(100, 5);
    expect(result.bollUpper!).toBeGreaterThanOrEqual(result.bollMiddle!);
    expect(result.bollLower!).toBeLessThanOrEqual(result.bollMiddle!);
  });

  test("bollinger bands: upper == lower == middle for perfectly flat closes", () => {
    const flat = Array.from({ length: 30 }, (_, i) =>
      bar(`2024-01-${String(i + 1).padStart(2, "0")}`, 100, { high: 101, low: 99 }),
    );
    const result = computeIndicators(flat);
    expect(result.bollUpper).toBeCloseTo(100, 5);
    expect(result.bollMiddle).toBeCloseTo(100, 5);
    expect(result.bollLower).toBeCloseTo(100, 5);
  });

  test("macd fields are all null when bars < 34 (26 + 9 - 1)", () => {
    const result = computeIndicators(bars(33));
    expect(result.macd).toBeNull();
    expect(result.macdSignal).toBeNull();
    expect(result.macdHistogram).toBeNull();
  });

  test("macd fields are non-null when bars >= 34", () => {
    const result = computeIndicators(bars(34, 100, 1));
    expect(result.macd).not.toBeNull();
    expect(result.macdSignal).not.toBeNull();
    expect(result.macdHistogram).not.toBeNull();
  });

  test("macd histogram = macd - signal", () => {
    const result = computeIndicators(bars(100, 100, 0.5));
    if (result.macd !== null && result.macdSignal !== null && result.macdHistogram !== null) {
      expect(result.macdHistogram).toBeCloseTo(result.macd - result.macdSignal, 8);
    }
  });

  test("atr14 is null when bars <= 14", () => {
    expect(computeIndicators(bars(14)).atr14).toBeNull();
    expect(computeIndicators(bars(15)).atr14).not.toBeNull();
  });

  test("atr14 is positive for bars with price movement", () => {
    const result = computeIndicators(bars(100, 100, 0.5));
    expect(result.atr14).not.toBeNull();
    expect(result.atr14!).toBeGreaterThan(0);
  });

  test("MIN_BARS_FOR_SNAPSHOT is 60", () => {
    expect(MIN_BARS_FOR_SNAPSHOT).toBe(60);
  });

  test("SMA200_PERIOD is 200", () => {
    expect(SMA200_PERIOD).toBe(200);
  });
});
