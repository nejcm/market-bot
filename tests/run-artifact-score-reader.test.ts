import { describe, expect, test } from "bun:test";
import { readScoreRows } from "../src/run-artifact-score-reader";

const row = (fields: Record<string, unknown>) => ({
  predictionId: "p1",
  runId: "r1",
  attemptCount: 1,
  evidence: {},
  ...fields,
});

const read = (
  value: unknown,
): { readonly scores: unknown; readonly malformed: unknown } | undefined => {
  const rows = readScoreRows(value);
  return rows && { scores: rows.scores, malformed: rows.malformed };
};
const readOne = (fields: Record<string, unknown>) => read({ scores: [row(fields)] });

describe("readScoreRows", () => {
  test("parses a legacy resolved row and drops its redundant resolved key", () => {
    expect(
      readOne({ status: "resolved", resolved: true, outcome: "hit", observedAt: "2026-05-01" }),
    ).toEqual({
      scores: [row({ status: "resolved", outcome: "hit", observedAt: "2026-05-01" })],
      malformed: [],
    });
  });

  test("ignores a persisted resolved key that contradicts the status", () => {
    expect(readOne({ status: "pending", resolved: true })?.scores).toEqual([
      row({ status: "pending" }),
    ]);
  });

  test.each([
    [{ resolved: true, outcome: "hit", observedAt: "2026-05-01" }, "missing status"],
    [{ status: "done" }, "unknown status"],
    [{ status: "resolved", observedAt: "2026-05-01" }, "resolved without outcome and observedAt"],
    [
      { status: "resolved", outcome: "push", observedAt: "2026-05-01" },
      "resolved without outcome and observedAt",
    ],
    [{ status: "resolved", outcome: "hit" }, "resolved without outcome and observedAt"],
    [{ status: "voided" }, "voided without observedAt"],
    [{ status: "abandoned" }, "abandoned without abandonedAt"],
  ])("sets %j aside as malformed: %s", (fields, reason) => {
    expect(readOne(fields)).toEqual({
      scores: [],
      malformed: [{ predictionId: "p1", reason, raw: row(fields) }],
    });
  });

  test("keeps a row with an id but missing structure as malformed", () => {
    const raw = { predictionId: "p1", status: "pending" };
    expect(read({ scores: [raw] })?.malformed).toEqual([
      { predictionId: "p1", reason: "missing runId, attemptCount, or evidence", raw },
    ]);
  });

  test("maps a legacy abandoned observedAt to abandonedAt", () => {
    expect(
      readOne({ status: "abandoned", resolved: true, observedAt: "2026-05-01" })?.scores,
    ).toEqual([row({ status: "abandoned", abandonedAt: "2026-05-01" })]);
    expect(readOne({ status: "abandoned", abandonedAt: "2026-05-02" })?.scores).toEqual([
      row({ status: "abandoned", abandonedAt: "2026-05-02" }),
    ]);
  });

  test("keeps only the fields each lifecycle arm carries", () => {
    expect(
      readOne({
        status: "pending",
        nextAttemptAt: "2026-05-03",
        outcome: "hit",
        observedAt: "2026-05-01",
        forecastOrigin: "2026-05-01",
      })?.scores,
    ).toEqual([row({ status: "pending", nextAttemptAt: "2026-05-03" })]);
    expect(
      readOne({ status: "voided", observedAt: "2026-05-01", forecastOrigin: "o", outcome: "hit" })
        ?.scores,
    ).toEqual([row({ status: "voided", observedAt: "2026-05-01", forecastOrigin: "o" })]);
  });

  test("keeps rows without a prediction id aside and an empty file distinct from an unreadable one", () => {
    expect(readScoreRows({ scores: [null, 7, { status: "pending" }] })).toEqual({
      scores: [],
      malformed: [],
      unidentified: [null, 7, { status: "pending" }],
    });
    expect(readScoreRows({ scores: "nope" })).toBeUndefined();
    expect(readScoreRows(undefined)).toBeUndefined();
  });
});
