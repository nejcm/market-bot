import { describe, expect, test } from "bun:test";
import {
  ACTIONABLE_CALIBRATION_Z,
  applicableCalibrationSlices,
  applicableKindSlices,
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
        byAssetClass: { equity: actionableMetric, crypto: actionableMetric },
        byJobType: {
          equity: { ...actionableMetric, count: 29 },
          crypto: actionableMetric,
        },
        byHorizonBucket: { "1-5d": actionableMetric, "6-10d": actionableMetric },
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

  test("distinguishes single-cell prediction horizons from empty market-update horizons", () => {
    const metric = {
      brierScore: 0.2658,
      count: 83,
      runCount: 22,
      brierStandardError: 0.01,
    };
    const keys = {
      assetClass: "equity",
      jobType: "equity",
      predictionHorizon: "1-5d",
      marketRegime: "mixed",
    } as const;

    const instrumentHorizon = applicableCalibrationSlices(
      { byHorizonBucket: { "1-5d": metric } },
      keys,
    ).find(({ dimension }) => dimension === "predictionHorizon");
    const marketUpdateHorizon = applicableCalibrationSlices(
      { byMarketUpdateHorizonBucket: {} },
      { ...keys, jobType: "market-overview" },
    ).find(({ dimension }) => dimension === "predictionHorizon");

    expect(instrumentHorizon).toMatchObject({
      dimension: "predictionHorizon",
      key: "1-5d",
      actionable: false,
      reason: "single-cell-dimension",
    });
    expect(marketUpdateHorizon).toEqual({
      dimension: "predictionHorizon",
      key: "1-5d",
      actionable: false,
      reason: "empty-dimension",
    });
  });

  test("keeps single-cell telemetry without gating actionability", () => {
    const metric = {
      brierScore: 0.4,
      count: 30,
      runCount: 10,
      brierStandardError: 0.05,
    };
    const assetClass = applicableCalibrationSlices(
      { byAssetClass: { equity: metric } },
      {
        assetClass: "equity",
        jobType: "equity",
        predictionHorizon: "2-5d",
        marketRegime: "mixed",
      },
    ).find(({ dimension }) => dimension === "assetClass");

    expect(assetClass).toMatchObject({
      actionable: true,
      reason: "single-cell-dimension",
      metric,
    });
  });
});

describe("applicableKindSlices", () => {
  test("assesses every prediction kind independently", () => {
    const slices = applicableKindSlices({
      byKind: {
        direction: {
          brierScore: 0.4,
          count: 30,
          runCount: 10,
          brierStandardError: 0.05,
        },
        range: {
          brierScore: 0.4,
          count: 29,
          runCount: 10,
          brierStandardError: 0.05,
        },
      },
    });

    expect(
      slices.map(({ dimension, key, actionable, reason }) => ({
        dimension,
        key,
        actionable,
        reason,
      })),
    ).toEqual([
      {
        dimension: "predictionKind",
        key: "direction",
        actionable: true,
        reason: "actionable-negative",
      },
      {
        dimension: "predictionKind",
        key: "range",
        actionable: false,
        reason: "below-outcome-floor",
      },
    ]);
  });
});
