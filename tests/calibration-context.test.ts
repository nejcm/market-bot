import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCalibrationBlock,
  loadCalibrationContext,
  parseCalibrationContext,
} from "../src/research/calibration-context";
import type { ResearchContext } from "../src/research/research-context-types";
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
    hitRate: 0.5,
    missAutopsyCount: 1,
    brierScore: 0.25,
    brierSkillScore: 0,
    bins: [{ pLow: 0.6, pHigh: 0.7, label: "0.6-0.7", hitCount: 1, totalCount: 2, hitRate: 0.5 }],
    byKind: { direction: { brierScore: 0.25, count: 2 } },
    byAssetClass: { equity: { brierScore: 0.25, count: 2 } },
    byJobType: { "market-overview": { brierScore: 0.25, count: 2 } },
    byMarketUpdateHorizonBucket: { "1-5d": { brierScore: 0.25, count: 2 } },
    byHorizonBucket: { "1-5": { brierScore: 0.25, count: 2 } },
    byMarketRegime: { mixed: { brierScore: 0.2, count: 5 } },
    marketRegimeCoverage: { mixed: 5, unknown: 1 },
    byMissAutopsyCause: { source_gap: 1 },
    conditionalPredictions: { activatedCount: 0, voidedCount: 0 },
  };
}

const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
} as const;

function calibrationRunContext(
  defaultPredictionHorizon = 5,
): Pick<ResearchContext, "depthProfile" | "marketRegime"> {
  return {
    depthProfile: {
      depth: "deep",
      analystStyle: "fuller analyst-style",
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      targetPredictions: 4,
      defaultPredictionHorizon,
      predictionSubjects: ["AAPL"],
      focus: ["ticker research"],
      targetKindMix: { favored: ["relative", "range"], minNonDirection: 1 },
    },
    marketRegime: {
      assetClass: "equity",
      label: "mixed",
      proxyCount: 1,
      drivers: [],
      sourceIds: [],
    },
  };
}

describe("buildCalibrationBlock", () => {
  const actionableMetric = {
    brierScore: 0.4,
    count: 30,
    runCount: 10,
    brierStandardError: 0.05,
  };

  test.each([
    ["asset class", "asset class equity", { byAssetClass: { equity: actionableMetric } }],
    ["job type", "job type equity", { byJobType: { equity: actionableMetric } }],
    ["default horizon", "default horizon 1-5d", { byHorizonBucket: { "1-5d": actionableMetric } }],
    ["current regime", "current regime mixed", { byMarketRegime: { mixed: actionableMetric } }],
  ])(
    "adds probability guidance for an actionable negative %s slice",
    (_name, triggerLabel, calibration) => {
      const block = buildCalibrationBlock(calibration, command, calibrationRunContext());
      expect(block).toContain(`${triggerLabel}: skill -0.60 (Brier 0.400, n=30, runs=10`);
      expect(block).toContain("only to discipline probability confidence");
      expect(block).toContain("must not suppress prediction count");
      expect(block).toContain("reject forecast shapes");
      expect(block).toContain("change evidence-support requirements");
    },
  );

  test.each([
    ["below outcome floor", { byAssetClass: { equity: { ...actionableMetric, count: 29 } } }],
    ["below run floor", { byJobType: { equity: { ...actionableMetric, runCount: 9 } } }],
    [
      "statistically inconclusive",
      {
        byHorizonBucket: {
          "1-5d": { ...actionableMetric, brierScore: 0.3, brierStandardError: 0.03 },
        },
      },
    ],
    ["legacy", { byAssetClass: { equity: { brierScore: 0.4, count: 30 } } }],
    ["non-applicable", { byAssetClass: { crypto: actionableMetric } }],
  ])("omits calibration entirely for a %s slice", (_name, calibration) => {
    expect(buildCalibrationBlock(calibration, command, calibrationRunContext())).toBeUndefined();
  });

  test("uses the depth profile default forecast horizon", () => {
    const block = buildCalibrationBlock(
      { byHorizonBucket: { "11-15d": actionableMetric } },
      command,
      calibrationRunContext(15),
    );

    expect(block).toContain("default horizon 11-15d");
  });

  test("includes only qualifying applicable slices", () => {
    const block = buildCalibrationBlock(
      {
        byAssetClass: { equity: actionableMetric },
        byJobType: { equity: { ...actionableMetric, count: 29 } },
        byHorizonBucket: { "1-5d": actionableMetric, "6-10d": actionableMetric },
      },
      command,
      calibrationRunContext(),
    );

    expect(block).toContain("asset class equity");
    expect(block).toContain("default horizon 1-5d");
    expect(block).not.toContain("job type equity");
    expect(block).not.toContain("6-10d");
  });
});

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

  test("filters malformed miss-autopsy cause counts", () => {
    const parsed = parseCalibrationContext({
      missAutopsyCount: 2,
      byMissAutopsyCause: {
        source_gap: 1,
        bad: -1,
        broken: "many",
      },
    });

    expect(parsed?.missAutopsyCount).toBe(2);
    expect(parsed?.byMissAutopsyCause).toEqual({ source_gap: 1 });
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

  test("reads valid uncertainty fields and drops malformed optional fields", () => {
    const parsed = parseCalibrationContext({
      byAssetClass: {
        equity: {
          brierScore: 0.3,
          count: 30,
          runCount: 10,
          brierStandardError: 0.02,
        },
        crypto: {
          brierScore: 0.3,
          count: 30,
          runCount: 31,
          brierStandardError: -0.1,
        },
      },
    });

    expect(parsed?.byAssetClass?.equity).toEqual({
      brierScore: 0.3,
      count: 30,
      runCount: 10,
      brierStandardError: 0.02,
    });
    expect(parsed?.byAssetClass?.crypto).toEqual({ brierScore: 0.3, count: 30 });
  });

  test("filters malformed market-regime slices and coverage counts", () => {
    const parsed = parseCalibrationContext({
      byMarketRegime: {
        mixed: { brierScore: 0.2, count: 5 },
        euphoric: { brierScore: 0.1, count: 8 },
        "risk-off": { brierScore: 0.25, count: 0 },
      },
      marketRegimeCoverage: {
        mixed: 5,
        unknown: 2,
        euphoric: 3,
        "risk-on": -1,
      },
    });

    expect(parsed?.byMarketRegime).toEqual({ mixed: { brierScore: 0.2, count: 5 } });
    expect(parsed?.marketRegimeCoverage).toEqual({ mixed: 5, unknown: 2 });
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
