import { describe, expect, test } from "bun:test";
import {
  derivePredictionShortfall,
  normalizePredictionShortfall,
  predictionShortfallCompactText,
  predictionShortfallMaterialGap,
  predictionShortfallMaterialGaps,
  rederivePredictionShortfallAfterPruning,
  validatePredictionShortfall,
  withoutPredictionShortfallProtocolGaps,
} from "../src/report/prediction-shortfall";

describe("prediction shortfall", () => {
  test("derives partial and zero-emission shortfalls but omits met and zero targets", () => {
    expect(derivePredictionShortfall(2, 5)).toEqual({
      emittedCount: 2,
      targetCount: 5,
      missingCount: 3,
    });
    expect(derivePredictionShortfall(0, 3)).toEqual({
      emittedCount: 0,
      targetCount: 3,
      missingCount: 3,
    });
    expect(derivePredictionShortfall(3, 3)).toBeUndefined();
    expect(derivePredictionShortfall(1, 0)).toBeUndefined();
    expect(derivePredictionShortfall(0, 0)).toBeUndefined();
  });

  test("re-derives stale and newly created shortfalls from post-prune counts", () => {
    expect(
      rederivePredictionShortfallAfterPruning(
        { emittedCount: 2, targetCount: 5, missingCount: 3 },
        undefined,
        1,
      ),
    ).toEqual({ emittedCount: 1, targetCount: 5, missingCount: 4 });
    expect(
      rederivePredictionShortfallAfterPruning(
        undefined,
        { depthProfile: { targetPredictions: 2 } },
        1,
      ),
    ).toEqual({ emittedCount: 1, targetCount: 2, missingCount: 1 });
    expect(
      rederivePredictionShortfallAfterPruning(
        { emittedCount: 1, targetCount: 2, missingCount: 1 },
        undefined,
        2,
      ),
    ).toBeUndefined();
  });

  test.each([
    { emittedCount: -1, targetCount: 3, missingCount: 4 },
    { emittedCount: 1.5, targetCount: 3, missingCount: 1.5 },
    { emittedCount: 1, targetCount: -3, missingCount: -4 },
    { emittedCount: 1, targetCount: 3, missingCount: -2 },
    { emittedCount: 1, targetCount: 3, missingCount: 1 },
    { emittedCount: 3, targetCount: 3, missingCount: 0 },
    { emittedCount: 4, targetCount: 3, missingCount: -1 },
  ])("rejects invalid counts %#", (candidate) => {
    expect(() => validatePredictionShortfall(candidate)).toThrow(
      "missingCount === targetCount - emittedCount > 0",
    );
  });

  test("canonicalizes anchored legacy forms and removes them from data gaps", () => {
    const compact = normalizePredictionShortfall(undefined, [
      "predictionShortfall: emitted 1 of 3",
      "Missing provider evidence",
    ]);
    const historical = normalizePredictionShortfall(undefined, [
      "predictionShortfall: emitted 1 of 3 target predictions; evidence did not support more",
    ]);

    expect(compact).toEqual({
      predictionShortfall: { emittedCount: 1, targetCount: 3, missingCount: 2 },
      dataGaps: ["Missing provider evidence"],
    });
    expect(historical).toEqual({
      predictionShortfall: { emittedCount: 1, targetCount: 3, missingCount: 2 },
      dataGaps: [],
    });
    expect(predictionShortfallMaterialGap(compact.predictionShortfall!)).toBe(
      "emitted 1 of 3 target predictions; evidence did not support more",
    );
    expect(predictionShortfallCompactText(compact.predictionShortfall!)).toBe("emitted 1 of 3");
  });

  test("keeps unparseable and non-legacy protocols visible", () => {
    const gaps = [
      "predictionShortfall: required 3, received 1",
      "prefix predictionShortfall: emitted 1 of 3",
      "predictionShortfall: emitted 1 of 3 trailing words",
      "predictionShortfall: emitted 3 of 3",
    ];

    expect(normalizePredictionShortfall(undefined, gaps)).toEqual({ dataGaps: gaps });
    expect(withoutPredictionShortfallProtocolGaps(gaps)).toEqual([
      "prefix predictionShortfall: emitted 1 of 3",
    ]);
  });

  test("gives a valid structured field precedence and retains a conflicting legacy entry", () => {
    const structured = { emittedCount: 2, targetCount: 5, missingCount: 3 };
    const conflict = "emitted 1 of 5 target predictions; evidence did not support more";

    expect(
      normalizePredictionShortfall(structured, [
        "predictionShortfall: emitted 2 of 5",
        "predictionShortfall: emitted 1 of 5",
      ]),
    ).toEqual({
      predictionShortfall: structured,
      dataGaps: [conflict],
    });
    expect(
      predictionShortfallMaterialGaps(structured, ["predictionShortfall: emitted 1 of 5"]),
    ).toEqual([conflict, "emitted 2 of 5 target predictions; evidence did not support more"]);
  });
});
