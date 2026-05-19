import type { Prediction } from "../domain/types";
import { parseMeasurableAs } from "./dsl";
import type { ScoreOutcome } from "./types";

export interface CloseAtDate {
  readonly symbol: string;
  readonly date: string;
  readonly close: number;
}

export interface ResolveResult {
  readonly outcome: ScoreOutcome;
  readonly evidence: Record<string, unknown>;
}

function resolveDirection(subjectClose0: number, subjectCloseN: number): ResolveResult {
  const outcome: ScoreOutcome = subjectCloseN > subjectClose0 ? "hit" : "miss";
  return {
    outcome,
    evidence: { close0: subjectClose0, closeN: subjectCloseN },
  };
}

function resolveRelative(
  closeA0: number,
  closeAN: number,
  closeB0: number,
  closeBN: number,
): ResolveResult {
  const returnA = closeAN / closeA0;
  const returnB = closeBN / closeB0;
  const outcome: ScoreOutcome = returnA > returnB ? "hit" : "miss";
  return {
    outcome,
    evidence: { returnA, returnB },
  };
}

function resolveVolatility(closings: readonly number[], threshold: number): ResolveResult {
  const maxClose = Math.max(...closings);
  const outcome: ScoreOutcome = maxClose > threshold ? "hit" : "miss";
  return {
    outcome,
    evidence: { maxClose, threshold },
  };
}

function resolveRange(closeN: number, lo: number, hi: number): ResolveResult {
  const outcome: ScoreOutcome = closeN < lo || closeN > hi ? "hit" : "miss";
  return {
    outcome,
    evidence: { closeN, lo, hi },
  };
}

export function resolvePrediction(
  prediction: Prediction,
  closePrices: readonly CloseAtDate[],
): ResolveResult | undefined {
  const parsed = parseMeasurableAs(prediction.measurableAs);
  const byKey = new Map(closePrices.map((c) => [`${c.symbol}:${c.date}`, c.close]));

  function getClose(symbol: string, offset: 0 | "N"): number | undefined {
    if (offset === 0) {
      const entry = closePrices.find((c) => c.symbol === symbol);
      return entry !== undefined ? byKey.get(`${symbol}:${entry.date}`) : undefined;
    }
    const sorted = closePrices
      .filter((c) => c.symbol === symbol)
      .toSorted((a, b) => a.date.localeCompare(b.date));
    return sorted.at(-1)?.close;
  }

  function getFirstClose(symbol: string): number | undefined {
    const sorted = closePrices
      .filter((c) => c.symbol === symbol)
      .toSorted((a, b) => a.date.localeCompare(b.date));
    return sorted[0]?.close;
  }

  function getLastClose(symbol: string): number | undefined {
    const sorted = closePrices
      .filter((c) => c.symbol === symbol)
      .toSorted((a, b) => a.date.localeCompare(b.date));
    return sorted.at(-1)?.close;
  }

  function getAllCloses(symbol: string): readonly number[] {
    return closePrices.filter((c) => c.symbol === symbol).map((c) => c.close);
  }

  if (parsed.kind === "direction") {
    const close0 = getFirstClose(parsed.subject);
    const closeN = getLastClose(parsed.subject);
    if (close0 === undefined || closeN === undefined) {
      return undefined;
    }
    return resolveDirection(close0, closeN);
  }

  if (parsed.kind === "relative") {
    const closeA0 = getFirstClose(parsed.subjectA);
    const closeAN = getLastClose(parsed.subjectA);
    const closeB0 = getFirstClose(parsed.subjectB);
    const closeBN = getLastClose(parsed.subjectB);
    if (
      closeA0 === undefined ||
      closeAN === undefined ||
      closeB0 === undefined ||
      closeBN === undefined
    ) {
      return undefined;
    }
    return resolveRelative(closeA0, closeAN, closeB0, closeBN);
  }

  if (parsed.kind === "volatility") {
    const closings = getAllCloses(parsed.subject);
    if (closings.length === 0) {
      return undefined;
    }
    return resolveVolatility(closings, parsed.threshold);
  }

  if (parsed.kind === "range") {
    const closeN = getLastClose(parsed.subject);
    if (closeN === undefined) {
      return undefined;
    }
    return resolveRange(closeN, parsed.lo, parsed.hi);
  }

  // GetClose suppresses TS "unused" error for the helper; it's not needed after exhaustive checks
  void getClose;
  return undefined;
}
