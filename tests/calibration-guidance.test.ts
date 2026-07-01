import { describe, expect, test } from "bun:test";
import {
  ACTIONABLE_CALIBRATION_Z,
  applicableCalibrationSlices,
  assessNegativeCalibration,
} from "../src/research/calibration-guidance";

describe("assessNegativeCalibration", () => {
  test.each([
    ["missing slice", undefined, "slice-unavailable"],
    [
      "fewer than 30 outcomes",
      { brierScore: 0.5, count: 29, runCount: 10, brierStandardError: 0 },
      "below-outcome-floor",
    ],
    ["legacy metric", { brierScore: 0.5, count: 30 }, "uncertainty-unavailable"],
    [
      "fewer than 10 runs",
      { brierScore: 0.5, count: 30, runCount: 9, brierStandardError: 0 },
      "below-run-floor",
    ],
    [
      "positive calibration",
      { brierScore: 0.2, count: 30, runCount: 10, brierStandardError: 0 },
      "not-negative-with-confidence",
    ],
  ] as const)("classifies %s deterministically", (_name, metric, reason) => {
    expect(assessNegativeCalibration(metric)).toMatchObject({ actionable: false, reason });
  });

  test("is actionable at exactly 30 outcomes and 10 runs when confidence clears baseline", () => {
    expect(
      assessNegativeCalibration({
        brierScore: 0.4,
        count: 30,
        runCount: 10,
        brierStandardError: 0.05,
      }),
    ).toMatchObject({ actionable: true, reason: "actionable-negative" });
  });

  test("reports a calculable bound even when a sample gate fails", () => {
    expect(
      assessNegativeCalibration({
        brierScore: 0.4,
        count: 29,
        runCount: 10,
        brierStandardError: 0.05,
      }).lowerConfidenceBound,
    ).toBeCloseTo(0.287_93);
  });

  test("is non-actionable when the lower bound equals 0.25", () => {
    const standardError = 0.05;
    expect(
      assessNegativeCalibration({
        brierScore: 0.25 + ACTIONABLE_CALIBRATION_Z * standardError,
        count: 30,
        runCount: 10,
        brierStandardError: standardError,
      }),
    ).toMatchObject({ actionable: false, reason: "not-negative-with-confidence" });
  });
});

describe("applicableCalibrationSlices", () => {
  test("assesses all four applicable slices independently", () => {
    const actionableMetric = {
      brierScore: 0.4,
      count: 30,
      runCount: 10,
      brierStandardError: 0.05,
    };
    const slices = applicableCalibrationSlices(
      {
        byAssetClass: { equity: actionableMetric },
        byJobType: { equity: { ...actionableMetric, count: 29 } },
        byHorizonBucket: { "1-5d": actionableMetric },
      },
      {
        assetClass: "equity",
        jobType: "equity",
        predictionHorizon: "1-5d",
        marketRegime: "mixed",
      },
    );

    expect(
      slices.map(({ dimension, actionable, reason }) => ({ dimension, actionable, reason })),
    ).toEqual([
      { dimension: "assetClass", actionable: true, reason: "actionable-negative" },
      { dimension: "jobType", actionable: false, reason: "below-outcome-floor" },
      { dimension: "predictionHorizon", actionable: true, reason: "actionable-negative" },
      { dimension: "marketRegime", actionable: false, reason: "slice-unavailable" },
    ]);
  });
});
