import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCalibrationContext, parseCalibrationContext } from "../src/research/research-context";
import type { CalibrationSummary } from "../src/scoring/types";

async function writeSummary(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "calibration-"));
  const dataDir = join(root, "runs");
  mkdirSync(join(root, "calibration"), { recursive: true });
  writeFileSync(
    join(root, "calibration", "summary.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return dataDir;
}

function validSummary(): CalibrationSummary {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    resolvedCount: 2,
    brierScore: 0.25,
    brierSkillScore: 0,
    bins: [{ pLow: 0.6, pHigh: 0.7, label: "0.6-0.7", hitCount: 1, totalCount: 2, hitRate: 0.5 }],
    byKind: { direction: { brierScore: 0.25, count: 2 } },
    byAssetClass: { equity: { brierScore: 0.25, count: 2 } },
    byJobType: { daily: { brierScore: 0.25, count: 2 } },
    byMarketUpdateCadence: { daily: { brierScore: 0.25, count: 2 } },
    byHorizonBucket: { "1-5": { brierScore: 0.25, count: 2 } },
  };
}

describe("parseCalibrationContext", () => {
  test("returns undefined for non-record inputs", () => {
    expect(parseCalibrationContext(null)).toBeUndefined();
    expect(parseCalibrationContext("summary")).toBeUndefined();
    expect(parseCalibrationContext(42)).toBeUndefined();
    expect(parseCalibrationContext([{ brierScore: 0.25 }])).toBeUndefined();
  });

  test("passes a well-formed summary through intact", () => {
    const summary = validSummary();

    const parsed = parseCalibrationContext(structuredClone(summary) as unknown);

    expect(parsed).toEqual(summary);
  });

  test("drops fields with the wrong primitive type instead of trusting them", () => {
    const parsed = parseCalibrationContext({
      generatedAt: 12_345,
      resolvedCount: "two",
      brierScore: "high",
    });

    expect(parsed).toEqual({});
  });

  test("rejects non-finite numeric fields", () => {
    const parsed = parseCalibrationContext({
      resolvedCount: Number.NaN,
      brierScore: Number.POSITIVE_INFINITY,
    });

    expect(parsed).toEqual({});
  });

  test("filters out malformed bins but keeps well-formed ones", () => {
    const parsed = parseCalibrationContext({
      bins: [
        { pLow: 0.6, pHigh: 0.7, label: "0.6-0.7", hitCount: 1, totalCount: 2, hitRate: 0.5 },
        { pLow: 0.7, label: "broken", hitRate: "lots" },
        "not-a-bin",
      ],
    });

    expect(parsed?.bins).toEqual([
      { pLow: 0.6, pHigh: 0.7, label: "0.6-0.7", hitCount: 1, totalCount: 2, hitRate: 0.5 },
    ]);
  });

  test("filters out malformed metric-map entries", () => {
    const parsed = parseCalibrationContext({
      byKind: {
        direction: { brierScore: 0.25, count: 2 },
        relative: { brierScore: "nope" },
        range: "not-a-metric",
      },
    });

    expect(parsed?.byKind).toEqual({ direction: { brierScore: 0.25, count: 2 } });
  });

  test("ignores a malformed bins value that is not an array", () => {
    const parsed = parseCalibrationContext({ brierScore: 0.25, bins: "many" });

    expect(parsed).toEqual({ brierScore: 0.25 });
  });

  test("rejects domain-invalid top-level fields", () => {
    const parsed = parseCalibrationContext({
      resolvedCount: 2.5,
      brierScore: 1.5,
    });

    expect(parsed).toEqual({});
  });

  test("rejects a Brier skill score outside the achievable [-3, 1] range", () => {
    expect(parseCalibrationContext({ brierScore: 0.25, brierSkillScore: 5 })).toEqual({
      brierScore: 0.25,
    });
    expect(parseCalibrationContext({ brierScore: 0.25, brierSkillScore: -10 })).toEqual({
      brierScore: 0.25,
    });
  });

  test("rejects bins with out-of-range probabilities or impossible counts", () => {
    const valid = {
      pLow: 0.6,
      pHigh: 0.7,
      label: "0.6-0.7",
      hitCount: 1,
      totalCount: 2,
      hitRate: 0.5,
    };
    const parsed = parseCalibrationContext({
      bins: [
        valid,
        { pLow: 0.6, pHigh: 0.7, label: "bad-rate", hitCount: 1, totalCount: 2, hitRate: 1.5 },
        { pLow: -0.1, pHigh: 0.2, label: "bad-low", hitCount: 1, totalCount: 2, hitRate: 0.5 },
        { pLow: 0.7, pHigh: 0.6, label: "inverted", hitCount: 1, totalCount: 2, hitRate: 0.5 },
        { pLow: 0.6, pHigh: 0.7, label: "hits>total", hitCount: 3, totalCount: 2, hitRate: 0.5 },
        { pLow: 0.6, pHigh: 0.7, label: "frac-count", hitCount: 1.5, totalCount: 2, hitRate: 0.5 },
        { pLow: 0.6, pHigh: 0.7, label: "empty-bin", hitCount: 0, totalCount: 0, hitRate: 0 },
      ],
    });

    expect(parsed?.bins).toEqual([valid]);
  });

  test("rejects metric entries with out-of-range brier or non-positive counts", () => {
    const parsed = parseCalibrationContext({
      byKind: {
        direction: { brierScore: 0.25, count: 2 },
        overUnit: { brierScore: 1.4, count: 2 },
        zeroCount: { brierScore: 0.25, count: 0 },
        fracCount: { brierScore: 0.25, count: 1.5 },
      },
    });

    expect(parsed?.byKind).toEqual({ direction: { brierScore: 0.25, count: 2 } });
  });
});

describe("loadCalibrationContext", () => {
  test("returns undefined when the summary file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "calibration-"));

    const context = await loadCalibrationContext(join(root, "runs"));

    expect(context).toBeUndefined();
  });

  test("returns undefined for invalid JSON on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "calibration-"));
    const dataDir = join(root, "runs");
    mkdirSync(join(root, "calibration"), { recursive: true });
    writeFileSync(join(root, "calibration", "summary.json"), "{not json", "utf8");

    const context = await loadCalibrationContext(dataDir);

    expect(context).toBeUndefined();
  });

  test("loads and sanitizes a real summary written to disk", async () => {
    const dataDir = await writeSummary(validSummary());

    const context = await loadCalibrationContext(dataDir);

    expect(context).toEqual(validSummary());
  });

  test("strips poisoned fields rather than passing them to the prompt", async () => {
    const dataDir = await writeSummary({
      ...validSummary(),
      brierScore: "definitely-a-number",
      bins: [{ label: "broken" }],
    });

    const context = await loadCalibrationContext(dataDir);

    expect(context?.brierScore).toBeUndefined();
    expect(context?.bins).toEqual([]);
    // Untouched valid fields still load.
    expect(context?.resolvedCount).toBe(2);
    expect(context?.byKind).toEqual({ direction: { brierScore: 0.25, count: 2 } });
  });
});
