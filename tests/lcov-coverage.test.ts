import { describe, expect, test } from "bun:test";
import { aggregateLcov, coveragePercent, evaluateCoverage } from "../scripts/lcov-coverage";

const THRESHOLDS = { minLinePercent: 80, minFunctionPercent: 80 } as const;

describe("aggregateLcov", () => {
  test("sums LF/LH and FNF/FNH across multiple file sections", () => {
    const lcov = [
      "SF:src/a.ts",
      "FNF:4",
      "FNH:4",
      "LF:10",
      "LH:9",
      "end_of_record",
      "SF:src/b.ts",
      "FNF:6",
      "FNH:3",
      "LF:20",
      "LH:11",
      "end_of_record",
    ].join("\n");

    expect(aggregateLcov(lcov)).toEqual({
      linesFound: 30,
      linesHit: 20,
      functionsFound: 10,
      functionsHit: 7,
    });
  });

  test("treats missing function records as zero found and zero hit", () => {
    const lcov = ["SF:src/a.ts", "LF:10", "LH:10", "end_of_record"].join("\n");

    expect(aggregateLcov(lcov)).toEqual({
      linesFound: 10,
      linesHit: 10,
      functionsFound: 0,
      functionsHit: 0,
    });
  });

  test("returns zeroed totals for an empty report", () => {
    expect(aggregateLcov("")).toEqual({
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    });
  });

  test("does not confuse FN: definition records with FNF/FNH counters", () => {
    const lcov = [
      "SF:src/a.ts",
      "FN:5,doThing",
      "FNF:1",
      "FNH:1",
      "LF:2",
      "LH:2",
      "end_of_record",
    ].join("\n");

    expect(aggregateLcov(lcov)).toEqual({
      linesFound: 2,
      linesHit: 2,
      functionsFound: 1,
      functionsHit: 1,
    });
  });
});

describe("coveragePercent", () => {
  test("computes a normal ratio", () => {
    expect(coveragePercent(9, 10)).toBe(90);
  });

  test("treats a zero denominator as 0% rather than NaN", () => {
    expect(coveragePercent(0, 0)).toBe(0);
  });
});

describe("evaluateCoverage", () => {
  test("passes when both metrics meet the threshold", () => {
    const evaluation = evaluateCoverage(
      { linesFound: 100, linesHit: 85, functionsFound: 50, functionsHit: 45 },
      THRESHOLDS,
    );
    expect(evaluation.linePercent).toBe(85);
    expect(evaluation.functionPercent).toBe(90);
    expect(evaluation.failures).toEqual([]);
  });

  test("reports a line failure when line coverage is below threshold", () => {
    const evaluation = evaluateCoverage(
      { linesFound: 100, linesHit: 70, functionsFound: 50, functionsHit: 45 },
      THRESHOLDS,
    );
    expect(evaluation.failures).toEqual(["Line coverage 70.00% is below 80%"]);
  });

  test("reports a function failure when only function coverage is below threshold", () => {
    const evaluation = evaluateCoverage(
      { linesFound: 100, linesHit: 95, functionsFound: 50, functionsHit: 20 },
      THRESHOLDS,
    );
    expect(evaluation.failures).toEqual(["Function coverage 40.00% is below 80%"]);
  });

  test("reports both failures and fails on zeroed totals from an empty report", () => {
    const evaluation = evaluateCoverage(aggregateLcov(""), THRESHOLDS);
    expect(evaluation.linePercent).toBe(0);
    expect(evaluation.functionPercent).toBe(0);
    expect(evaluation.failures).toEqual([
      "Line coverage 0.00% is below 80%",
      "Function coverage 0.00% is below 80%",
    ]);
  });

  test("fails when functions are missing entirely even though lines are fully covered", () => {
    const evaluation = evaluateCoverage(
      aggregateLcov(["SF:src/a.ts", "LF:10", "LH:10", "end_of_record"].join("\n")),
      THRESHOLDS,
    );
    expect(evaluation.linePercent).toBe(100);
    expect(evaluation.functionPercent).toBe(0);
    expect(evaluation.failures).toEqual(["Function coverage 0.00% is below 80%"]);
  });
});
