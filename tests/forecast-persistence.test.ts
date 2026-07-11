import { describe, expect, test } from "bun:test";
import { buildForecastPersistence } from "../src/research/forecast-persistence";
import { prediction, researchReport } from "./support/fixtures";

describe("buildForecastPersistence", () => {
  test("returns undefined when no baseline run exists", () => {
    const report = researchReport({ predictions: [prediction()] });

    expect(buildForecastPersistence({ report, baseline: undefined })).toBeUndefined();
  });

  test("counts repeated claims and unchanged probabilities", () => {
    const report = researchReport({
      predictions: [
        // Repeated claim, same probability.
        prediction({
          id: "pred-1",
          measurableAs: "close(SPY, +5) > close(SPY, 0)",
          probability: 0.65,
        }),
        // Repeated claim, revised probability.
        prediction({
          id: "pred-2",
          measurableAs: "close(QQQ, +10) > close(QQQ, 0)",
          probability: 0.7,
        }),
        // New claim.
        prediction({
          id: "pred-3",
          measurableAs: "close(IWM, +5) > close(IWM, 0)",
          probability: 0.55,
        }),
      ],
    });

    expect(
      buildForecastPersistence({
        report,
        baseline: {
          runId: "baseline-run",
          predictions: [
            { measurableAs: "close(SPY, +5) > close(SPY, 0)", probability: 0.65 },
            { measurableAs: "close(QQQ, +10) > close(QQQ, 0)", probability: 0.6 },
            { measurableAs: "close(XLE, +5) > close(XLE, 0)", probability: 0.5 },
          ],
        },
      }),
    ).toEqual({
      baselineRunId: "baseline-run",
      repeatedClaimCount: 2,
      unchangedProbabilityCount: 1,
    });
  });

  test("matches claims through canonical measurableAs despite formatting drift", () => {
    const report = researchReport({
      predictions: [prediction({ measurableAs: "close(SPY,+5)>close(SPY,0)", probability: 0.65 })],
    });

    expect(
      buildForecastPersistence({
        report,
        baseline: {
          runId: "baseline-run",
          predictions: [{ measurableAs: "close(SPY, +5) > close(SPY, 0)", probability: 0.65 }],
        },
      }),
    ).toEqual({
      baselineRunId: "baseline-run",
      repeatedClaimCount: 1,
      unchangedProbabilityCount: 1,
    });
  });

  test("falls back to collapsed lowercase text for pre-DSL measurableAs", () => {
    const report = researchReport({
      predictions: [
        prediction({ measurableAs: "  Custom METRIC  stays above threshold ", probability: 0.6 }),
      ],
    });

    expect(
      buildForecastPersistence({
        report,
        baseline: {
          runId: "baseline-run",
          predictions: [{ measurableAs: "custom metric stays above threshold", probability: 0.55 }],
        },
      }),
    ).toEqual({
      baselineRunId: "baseline-run",
      repeatedClaimCount: 1,
      unchangedProbabilityCount: 0,
    });
  });

  test("yields zero repeats against a zero-prediction baseline", () => {
    const report = researchReport({ predictions: [prediction()] });

    expect(
      buildForecastPersistence({
        report,
        baseline: { runId: "baseline-run", predictions: [] },
      }),
    ).toEqual({
      baselineRunId: "baseline-run",
      repeatedClaimCount: 0,
      unchangedProbabilityCount: 0,
    });
  });
});
