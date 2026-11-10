import { describe, expect, test } from "bun:test";
import { hasOutcome, isPendingScore, isTerminal } from "../src/scoring/score-status";
import type { PredictionScore } from "../src/scoring/types";
import { predictionScore, scoreWithStatus } from "./support/fixtures";

const rows: readonly PredictionScore[] = [
  predictionScore("hit"),
  predictionScore("miss"),
  scoreWithStatus("voided"),
  scoreWithStatus("abandoned"),
  scoreWithStatus("pending"),
  scoreWithStatus("pending-condition"),
  scoreWithStatus("active-pending"),
];

describe("score status", () => {
  test("terminal covers resolved, voided and abandoned only", () => {
    expect(rows.map((row) => isTerminal(row.status))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(rows.map((row) => isPendingScore(row))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
  });

  test("only resolved rows with an outcome have one", () => {
    expect(rows.map((row) => hasOutcome(row))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(hasOutcome({ outcome: "hit" })).toBe(false);
    expect(hasOutcome({ status: "resolved" })).toBe(false);
  });

  test("hit + miss + voided + abandoned = terminal", () => {
    const count = (predicate: (row: PredictionScore) => boolean) =>
      rows.filter((row) => predicate(row)).length;
    const terminal = count((row) => isTerminal(row.status));
    expect(
      count((row) => hasOutcome(row) && row.outcome === "hit") +
        count((row) => hasOutcome(row) && row.outcome === "miss") +
        count((row) => row.status === "voided") +
        count((row) => row.status === "abandoned"),
    ).toBe(terminal);
  });
});
