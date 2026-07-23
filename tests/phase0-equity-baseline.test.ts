import { expect, test } from "bun:test";
import {
  measurePhase4EarningsCoverageComparison,
  readPhase0Baseline,
  readPhase4EarningsCoverageComparison,
} from "./support/phase0-equity-baseline";

test("Phase 4 reports earnings coverage loss against the immutable Phase 0 baseline", async () => {
  const baseline = await readPhase0Baseline();
  const committedComparison = await readPhase4EarningsCoverageComparison();
  const measuredComparison = await measurePhase4EarningsCoverageComparison();

  expect(
    baseline.fixtureRuns.reduce((count, fixture) => count + fixture.earningsPredictionCount, 0),
  ).toBe(2);
  expect(baseline.historicalArtifacts.status).toBe("measured");
  expect(baseline.historicalArtifacts.providerEndpointAvailability.status).toBe("unmeasured");
  expect(measuredComparison).toEqual(committedComparison);
  expect(measuredComparison.totals).toMatchObject({
    phase0: {
      earningsSetupCount: 1,
      earningsPredictionCount: 2,
      calibrationEligiblePredictionCount: 2,
    },
    phase4: {
      earningsSetupCount: 1,
      earningsPredictionCount: 0,
      calibrationEligiblePredictionCount: 0,
      eligiblePredictionCount: 0,
      suppressedPredictionCount: 2,
    },
    delta: {
      earningsSetupCount: 0,
      earningsPredictionCount: -2,
      calibrationEligiblePredictionCount: -2,
    },
  });
  expect(
    measuredComparison.fixtureRuns.find(
      (fixture) => fixture.fixture === "equity-analysis-comprehensive",
    ),
  ).toMatchObject({
    eventDateStatus: "provider-estimated",
    grammarEligible: false,
    predictionCountDelta: -2,
    calibrationCoverageDelta: -2,
    suppressedPredictionCount: 2,
  });
});
