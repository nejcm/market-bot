import { describe, expect, test } from "bun:test";
import {
  DEEP_EQUITY_ACQUISITION_RECIPE,
  deepEquityAcquisitionTasksForPhase,
} from "../src/deep-equity/acquisition-recipe";

describe("deep-equity acquisition recipe", () => {
  test("provides the ordered parallel-provider dispatch set", () => {
    expect(
      deepEquityAcquisitionTasksForPhase("parallel-provider").map((task) => task.execute),
    ).toEqual([
      "supplemental-market",
      "news",
      "verified-price-history",
      "sec-target-packet",
      "finnhub-packet",
      "fred-packet",
      "tradier-packet",
    ]);
  });

  test("assigns every task to exactly one declared phase", () => {
    const phasedTaskIds = ["target", "parallel-provider", "dependent", "derive"].flatMap((phase) =>
      deepEquityAcquisitionTasksForPhase(
        phase as Parameters<typeof deepEquityAcquisitionTasksForPhase>[0],
      ).map((task) => task.id),
    );
    expect(phasedTaskIds).toHaveLength(DEEP_EQUITY_ACQUISITION_RECIPE.length);
    expect(new Set(phasedTaskIds).size).toBe(DEEP_EQUITY_ACQUISITION_RECIPE.length);
  });
});
