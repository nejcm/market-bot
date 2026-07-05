import { describe, expect, test } from "bun:test";
import { estimateAnthropicCost, estimateOpenAICost, sumKnownCosts } from "../src/model/pricing";

describe("model cost aggregation", () => {
  test("prices cached input, long context, and web-search calls", () => {
    expect(estimateOpenAICost("gpt-5.4", 100, 10, 40, 1)?.costEstimateUsd).toBeCloseTo(
      0.010_31,
      12,
    );
    expect(estimateOpenAICost("gpt-5.4", 272_001, 10)?.costEstimateUsd).toBeCloseTo(1.360_23, 12);
    expect(estimateAnthropicCost("claude-opus-4-8", 3, 4, 2)?.costEstimateUsd).toBeCloseTo(
      0.020_115,
      12,
    );
  });

  test("sums all-known stage costs exactly", () => {
    expect(sumKnownCosts([8e-5, 1.15e-4])).toBeCloseTo(1.95e-4, 12);
  });

  test("leaves the run total unknown when any stage cost is unknown", () => {
    expect(sumKnownCosts([8e-5, undefined, 1.15e-4])).toBeUndefined();
  });
});
