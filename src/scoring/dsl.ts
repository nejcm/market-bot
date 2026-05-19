import type { PredictionKind } from "../domain/types";

export interface ParsedDirection {
  readonly kind: "direction";
  readonly subject: string;
  readonly horizonN: number;
}

export interface ParsedRelative {
  readonly kind: "relative";
  readonly subjectA: string;
  readonly subjectB: string;
  readonly horizonN: number;
}

export interface ParsedVolatility {
  readonly kind: "volatility";
  readonly subject: string;
  readonly horizonN: number;
  readonly threshold: number;
}

export interface ParsedRange {
  readonly kind: "range";
  readonly subject: string;
  readonly horizonN: number;
  readonly lo: number;
  readonly hi: number;
}

export type ParsedMeasurable = ParsedDirection | ParsedRelative | ParsedVolatility | ParsedRange;

const SYMBOL = String.raw`([\w\^]+(?::[.\w]+)*)`;
const N = String.raw`(\d+)`;
const NUM = String.raw`(-?[\d.]+)`;

// Close(SUBJECT, +N) > close(SUBJECT, 0)
const DIRECTION_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s*>\s*close\(\1,\s*0\)$`,
  "u",
);

// Close(A, +N) / close(A, 0) > close(B, +N) / close(B, 0)
const RELATIVE_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s*/\s*close\(\1,\s*0\)\s*>\s*close\(${SYMBOL},\s*\+\2\)\s*/\s*close\(\3,\s*0\)$`,
  "u",
);

// Max(close(^VIX), 0..+N) > T
const VOLATILITY_RE = new RegExp(
  String.raw`^max\(close\(${SYMBOL}\),\s*0\.\.\+${N}\)\s*>\s*${NUM}$`,
  "u",
);

// Close(SUBJECT, +N) outside [Lo, Hi]
const RANGE_RE = new RegExp(
  String.raw`^close\(${SYMBOL},\s*\+${N}\)\s+outside\s+\[${NUM},\s*${NUM}\]$`,
  "u",
);

export function parseMeasurableAs(expr: string): ParsedMeasurable {
  const s = expr.trim();

  const dir = DIRECTION_RE.exec(s);
  if (dir !== null) {
    return { kind: "direction", subject: dir[1] as string, horizonN: Number(dir[2]) };
  }

  const rel = RELATIVE_RE.exec(s);
  if (rel !== null) {
    return {
      kind: "relative",
      subjectA: rel[1] as string,
      subjectB: rel[3] as string,
      horizonN: Number(rel[2]),
    };
  }

  const vol = VOLATILITY_RE.exec(s);
  if (vol !== null) {
    return {
      kind: "volatility",
      subject: vol[1] as string,
      horizonN: Number(vol[2]),
      threshold: Number(vol[3]),
    };
  }

  const range = RANGE_RE.exec(s);
  if (range !== null) {
    return {
      kind: "range",
      subject: range[1] as string,
      horizonN: Number(range[2]),
      lo: Number(range[3]),
      hi: Number(range[4]),
    };
  }

  throw new Error(`Cannot parse measurableAs: "${expr}"`);
}

export function measurableKind(expr: string): PredictionKind {
  return parseMeasurableAs(expr).kind;
}
