import { describe, expect, test } from "bun:test";
import { resolvePrediction } from "../src/scoring/resolver";
import { buildCalibrationSummary } from "../src/scoring/calibration";
import { renderCalibrationMarkdown } from "../src/scoring/calibration-markdown";
import type { Prediction } from "../src/domain/types";
import type { PredictionScore } from "../src/scoring/types";

const basePrediction: Prediction = {
  id: "pred-1",
  claim: "SPY closes higher over 5 trading days.",
  kind: "direction",
  subject: "SPY",
  measurableAs: "close(SPY, +5) > close(SPY, 0)",
  horizonTradingDays: 5,
  probability: 0.65,
  sourceIds: [],
};

describe("resolvePrediction", () => {
  describe("direction", () => {
    test("returns hit when close-N > close-0", () => {
      const result = resolvePrediction(basePrediction, [
        { symbol: "SPY", date: "2026-05-01", close: 500 },
        { symbol: "SPY", date: "2026-05-08", close: 510 },
      ]);
      expect(result?.outcome).toBe("hit");
      expect(result?.evidence).toMatchObject({ close0: 500, closeN: 510 });
    });

    test("returns miss when close-N <= close-0", () => {
      const result = resolvePrediction(basePrediction, [
        { symbol: "SPY", date: "2026-05-01", close: 510 },
        { symbol: "SPY", date: "2026-05-08", close: 500 },
      ]);
      expect(result?.outcome).toBe("miss");
    });

    test("returns undefined when close prices unavailable", () => {
      const result = resolvePrediction(basePrediction, []);
      expect(result).toBeUndefined();
    });
  });

  describe("relative", () => {
    const relPrediction: Prediction = {
      ...basePrediction,
      id: "pred-rel",
      kind: "relative",
      subject: "QQQ:SPY",
      measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
      claim: "QQQ outperforms SPY.",
    };

    test("returns hit when QQQ outperforms SPY", () => {
      const result = resolvePrediction(relPrediction, [
        { symbol: "QQQ", date: "2026-05-01", close: 400 },
        { symbol: "QQQ", date: "2026-05-08", close: 420 },
        { symbol: "SPY", date: "2026-05-01", close: 500 },
        { symbol: "SPY", date: "2026-05-08", close: 505 },
      ]);
      expect(result?.outcome).toBe("hit");
    });

    test("returns miss when SPY outperforms QQQ", () => {
      const result = resolvePrediction(relPrediction, [
        { symbol: "QQQ", date: "2026-05-01", close: 400 },
        { symbol: "QQQ", date: "2026-05-08", close: 401 },
        { symbol: "SPY", date: "2026-05-01", close: 500 },
        { symbol: "SPY", date: "2026-05-08", close: 510 },
      ]);
      expect(result?.outcome).toBe("miss");
    });
  });

  describe("volatility", () => {
    const volPrediction: Prediction = {
      ...basePrediction,
      id: "pred-vol",
      kind: "volatility",
      subject: "^VIX",
      measurableAs: "max(close(^VIX), 0..+5) > 20",
      claim: "VIX spikes above 20.",
    };

    test("returns hit when any close exceeds threshold", () => {
      const result = resolvePrediction(volPrediction, [
        { symbol: "^VIX", date: "2026-05-01", close: 18 },
        { symbol: "^VIX", date: "2026-05-03", close: 22 },
        { symbol: "^VIX", date: "2026-05-05", close: 19 },
      ]);
      expect(result?.outcome).toBe("hit");
    });

    test("returns miss when all closes stay below threshold", () => {
      const result = resolvePrediction(volPrediction, [
        { symbol: "^VIX", date: "2026-05-01", close: 15 },
        { symbol: "^VIX", date: "2026-05-05", close: 18 },
      ]);
      expect(result?.outcome).toBe("miss");
    });
  });

  describe("range", () => {
    const rangePrediction: Prediction = {
      ...basePrediction,
      id: "pred-range",
      kind: "range",
      subject: "BTC",
      measurableAs: "close(BTC, +7) outside [90000, 110000]",
      claim: "BTC breaks the 90k-110k band.",
    };

    test("returns hit when close-N is below lo", () => {
      const result = resolvePrediction(rangePrediction, [
        { symbol: "BTC", date: "2026-05-01", close: 100_000 },
        { symbol: "BTC", date: "2026-05-08", close: 85_000 },
      ]);
      expect(result?.outcome).toBe("hit");
    });

    test("returns hit when close-N is above hi", () => {
      const result = resolvePrediction(rangePrediction, [
        { symbol: "BTC", date: "2026-05-01", close: 100_000 },
        { symbol: "BTC", date: "2026-05-08", close: 115_000 },
      ]);
      expect(result?.outcome).toBe("hit");
    });

    test("returns miss when close-N is within range", () => {
      const result = resolvePrediction(rangePrediction, [
        { symbol: "BTC", date: "2026-05-01", close: 100_000 },
        { symbol: "BTC", date: "2026-05-08", close: 102_000 },
      ]);
      expect(result?.outcome).toBe("miss");
    });
  });
});

function makeScore(outcome: "hit" | "miss"): PredictionScore {
  return {
    predictionId: "p",
    runId: "r",
    resolved: true,
    outcome,
    observedAt: "2026-05-19T00:00:00.000Z",
    attemptCount: 1,
    evidence: {},
  };
}

describe("buildCalibrationSummary", () => {
  test("computes Brier score for a perfectly calibrated set", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 0 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.brierScore).toBe(0);
  });

  test("computes Brier score for worst-case predictions", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 0 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.brierScore).toBe(1);
  });

  test("returns zero for empty input", () => {
    const summary = buildCalibrationSummary([], new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.resolvedCount).toBe(0);
    expect(summary.brierScore).toBe(0);
    expect(summary.bins).toHaveLength(0);
  });

  test("groups results by kind and assetClass", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, kind: "direction" as const, probability: 0.7 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, kind: "volatility" as const, probability: 0.4 },
        score: makeScore("miss"),
        assetClass: "crypto" as const,
        jobType: "ticker" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.byKind["direction"]).toBeDefined();
    expect(summary.byKind["volatility"]).toBeDefined();
    expect(summary.byAssetClass["equity"]).toBeDefined();
    expect(summary.byAssetClass["crypto"]).toBeDefined();
  });

  test("groups calibration by job type, market cadence, and horizon bucket", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, horizonTradingDays: 5 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        marketUpdateCadence: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, horizonTradingDays: 15 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "weekly" as const,
        marketUpdateCadence: "weekly" as const,
        runId: "r2",
      },
      {
        prediction: { ...basePrediction, horizonTradingDays: 20 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "ticker" as const,
        runId: "r3",
      },
    ];

    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));

    expect(summary.byJobType["daily"]?.count).toBe(1);
    expect(summary.byJobType["weekly"]?.count).toBe(1);
    expect(summary.byJobType["ticker"]?.count).toBe(1);
    expect(summary.byMarketUpdateCadence["daily"]?.count).toBe(1);
    expect(summary.byMarketUpdateCadence["weekly"]?.count).toBe(1);
    expect(summary.byHorizonBucket["1-5d"]?.count).toBe(1);
    expect(summary.byHorizonBucket["11-15d"]?.count).toBe(1);
    expect(summary.byHorizonBucket["16-20d"]?.count).toBe(1);
  });

  test("renders empty market cadence section when only ticker predictions resolved", () => {
    const summary = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, horizonTradingDays: 5 },
          score: makeScore("hit"),
          assetClass: "equity" as const,
          jobType: "ticker" as const,
          runId: "r1",
        },
      ],
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(renderCalibrationMarkdown(summary)).toContain(
      "_No resolved market-update predictions yet._",
    );
  });

  test("includes probability=1 in the top bin", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    const topBin = summary.bins.find((bn) => bn.pHigh === 1);
    expect(topBin?.totalCount).toBe(2);
    expect(topBin?.hitCount).toBe(1);
  });

  test("builds reliability bins", () => {
    const pairs = Array.from({ length: 10 }, (_, idx) => ({
      prediction: { ...basePrediction, probability: 0.65 },
      score: makeScore(idx < 7 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: `r${String(idx)}`,
    }));
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    const bin = summary.bins.find((b) => b.pLow === 0.6);
    expect(bin).toBeDefined();
    expect(bin?.hitRate).toBeCloseTo(0.7, 2);
  });
});
