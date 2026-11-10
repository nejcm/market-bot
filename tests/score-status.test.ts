import { describe, expect, test } from "bun:test";
import { hasOutcome, isTerminal } from "../src/scoring/score-status";
import type { PredictionScore, PredictionScoreStatus } from "../src/scoring/types";
import { predictionScore } from "./support/fixtures";

const pending = (status: PredictionScoreStatus): PredictionScore =>
  predictionScore("hit", { status, resolved: false, outcome: undefined, observedAt: undefined });

const rows: readonly PredictionScore[] = [
  predictionScore("hit", { status: "resolved" }),
  predictionScore("miss", { status: "resolved" }),
  predictionScore("hit", { status: "voided", outcome: undefined }),
  predictionScore("hit", { status: "abandoned", outcome: undefined }),
  pending("pending"),
  pending("pending-condition"),
  pending("active-pending"),
];

describe("score status", () => {
  test("terminal covers resolved, voided and abandoned only", () => {
    expect(rows.map((row) => row.status !== undefined && isTerminal(row.status))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
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
    const { status: _status, ...statusless } = predictionScore("hit");
    expect(hasOutcome(statusless)).toBe(false);
    expect(hasOutcome(predictionScore("hit", { status: "resolved", outcome: undefined }))).toBe(
      false,
    );
  });

  test("hit + miss + voided + abandoned = terminal", () => {
    const count = (predicate: (row: PredictionScore) => boolean) =>
      rows.filter((row) => predicate(row)).length;
    const terminal = count((row) => row.status !== undefined && isTerminal(row.status));
    expect(
      count((row) => hasOutcome(row) && row.outcome === "hit") +
        count((row) => hasOutcome(row) && row.outcome === "miss") +
        count((row) => row.status === "voided") +
        count((row) => row.status === "abandoned"),
    ).toBe(terminal);
  });
});
