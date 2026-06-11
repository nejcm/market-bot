/**
 * Pure deterministic indicator compute (ADR 0019).
 *
 * Input: sorted daily OHLCV bars (oldest → newest).
 * Output: canonical key map with null for insufficient-bar or compute-error cases.
 *
 * Canonical key schema (locked in ADR 0019):
 *   ema10, sma50, sma200, rsi14, macd, macdSignal, macdHistogram,
 *   bollUpper, bollMiddle, bollLower, atr14
 *
 * Policy: per-indicator failure → null for that key, never a dropped snapshot.
 */

import type { OhlcvBar } from "../domain/types";

export interface IndicatorMap {
  readonly ema10: number | null;
  readonly sma50: number | null;
  readonly sma200: number | null;
  readonly rsi14: number | null;
  readonly macd: number | null;
  readonly macdSignal: number | null;
  readonly macdHistogram: number | null;
  readonly bollUpper: number | null;
  readonly bollMiddle: number | null;
  readonly bollLower: number | null;
  readonly atr14: number | null;
}

// ---------------------------------------------------------------------------
// SMA — Simple Moving Average over the last N closes
// ---------------------------------------------------------------------------

function sma(closes: readonly number[], period: number): number | null {
  if (closes.length < period) {
    return null;
  }
  const window = closes.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}

// ---------------------------------------------------------------------------
// EMA — Exponential Moving Average (seeded from SMA of first `period` bars)
// ---------------------------------------------------------------------------

function emaFromCloses(closes: readonly number[], period: number): number | null {
  if (closes.length < period) {
    return null;
  }
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
  }
  return ema;
}

// Return a full EMA series (length = closes.length - period + 1) for MACD use.
function emaSeriesFromCloses(closes: readonly number[], period: number): readonly number[] | null {
  if (closes.length < period) {
    return null;
  }
  const k = 2 / (period + 1);
  const series: number[] = [];
  let ema = closes.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  series.push(ema);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

// ---------------------------------------------------------------------------
// RSI(14) — Wilder smoothed relative strength index
// ---------------------------------------------------------------------------

function rsi14(closes: readonly number[]): number | null {
  const period = 14;
  if (closes.length <= period) {
    // Need at least period + 1 values to compute one change
    return null;
  }
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i]! - closes[i - 1]!);
  }
  // Seed with SMA of first `period` gains/losses
  let avgGain = changes.slice(0, period).reduce((sum, c) => sum + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((sum, c) => sum + Math.max(-c, 0), 0) / period;

  for (let i = period; i < changes.length; i++) {
    const gain = Math.max(changes[i]!, 0);
    const loss = Math.max(-changes[i]!, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// MACD(12, 26, 9) — MACD line, signal, histogram
// ---------------------------------------------------------------------------

interface MacdResult {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}

function macd1226_9(closes: readonly number[]): MacdResult | null {
  // Need >=26 bars for the first MACD value, then >=9 more for the signal
  const minBars = 26 + 9 - 1;
  if (closes.length < minBars) {
    return null;
  }
  const ema12 = emaSeriesFromCloses(closes, 12);
  const ema26 = emaSeriesFromCloses(closes, 26);
  if (ema12 === null || ema26 === null) {
    return null;
  }
  // Align: ema26 has (closes.length - 26 + 1) values; ema12 has (closes.length - 12 + 1)
  // The last ema26 aligns with the last ema12 (both anchor to closes[-1])
  const macdLine: number[] = [];
  for (let i = 0; i < ema26.length; i++) {
    const ema12Idx = ema12.length - ema26.length + i;
    macdLine.push(ema12[ema12Idx]! - ema26[i]!);
  }
  if (macdLine.length < 9) {
    return null;
  }
  const signal = emaSeriesFromCloses(macdLine, 9);
  if (signal === null) {
    return null;
  }
  const latestMacd = macdLine.at(-1) as number;
  const latestSignal = signal.at(-1) as number;
  return {
    macd: latestMacd,
    signal: latestSignal,
    histogram: latestMacd - latestSignal,
  };
}

// ---------------------------------------------------------------------------
// Bollinger Bands(20, 2) — SMA20 ± 2 * population std dev
// ---------------------------------------------------------------------------

interface BollingerResult {
  readonly upper: number;
  readonly middle: number;
  readonly lower: number;
}

function bollinger20_2(closes: readonly number[]): BollingerResult | null {
  const period = 20;
  if (closes.length < period) {
    return null;
  }
  const window = closes.slice(-period);
  const middle = window.reduce((sum, v) => sum + v, 0) / period;
  const variance = window.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: middle + 2 * std,
    middle,
    lower: middle - 2 * std,
  };
}

// ---------------------------------------------------------------------------
// ATR(14) — Wilder smoothed Average True Range
// ---------------------------------------------------------------------------

function atr14(bars: readonly OhlcvBar[]): number | null {
  const period = 14;
  if (bars.length <= period) {
    return null;
  }
  const trValues: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const curr = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trValues.push(tr);
  }
  // Seed with SMA of first `period` TRs
  let atr = trValues.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]!) / period;
  }
  return atr;
}

// ---------------------------------------------------------------------------
// Public compute entry-point
// ---------------------------------------------------------------------------

function tryCompute<T>(fn: () => T | null): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

// Compute all canonical indicators from sorted daily OHLCV bars.
// Per-indicator failure → null for that key; the whole snapshot is never dropped.
// Never throws.
export function computeIndicators(bars: readonly OhlcvBar[]): IndicatorMap {
  const closes = bars.map((b) => b.close);

  const macdResult = tryCompute(() => macd1226_9(closes));
  const bollResult = tryCompute(() => bollinger20_2(closes));

  return {
    ema10: tryCompute(() => emaFromCloses(closes, 10)),
    sma50: tryCompute(() => sma(closes, 50)),
    sma200: tryCompute(() => sma(closes, 200)),
    rsi14: tryCompute(() => rsi14(closes)),
    macd: macdResult?.macd ?? null,
    macdSignal: macdResult?.signal ?? null,
    macdHistogram: macdResult?.histogram ?? null,
    bollUpper: bollResult?.upper ?? null,
    bollMiddle: bollResult?.middle ?? null,
    bollLower: bollResult?.lower ?? null,
    atr14: tryCompute(() => atr14(bars)),
  };
}

/** Minimum bar count to emit a snapshot at all (core indicators). */
export const MIN_BARS_FOR_SNAPSHOT = 60;

/** Bar count below which sma200 is always null. */
export const MIN_BARS_FOR_SMA200 = 200;
