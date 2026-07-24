import { expect, test } from "bun:test";
import {
  measurePhase4EarningsCoverageComparison,
  readPhase0Baseline,
  readPhase4EarningsCoverageComparison,
} from "./support/phase0-equity-baseline";

test("Phase 4 reports confirmed and suppressed earnings paths against Phase 0", async () => {
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
      earningsSetupCount: 2,
      earningsPredictionCount: 4,
      calibrationEligiblePredictionCount: 4,
    },
    phase4: {
      earningsSetupCount: 2,
      earningsPredictionCount: 2,
      calibrationEligiblePredictionCount: 2,
      eligiblePredictionCount: 2,
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
    eventDateStatus: "issuer-confirmed",
    grammarEligible: true,
    predictionCountDelta: 0,
    calibrationCoverageDelta: 0,
    suppressedPredictionCount: 0,
  });
  expect(
    measuredComparison.fixtureRuns.find(
      (fixture) => fixture.fixture === "equity-analysis-estimated-suppressed",
    ),
  ).toMatchObject({
    eventDateStatus: "provider-estimated",
    grammarEligible: false,
    predictionCountDelta: -2,
    calibrationCoverageDelta: -2,
    eligiblePredictionCount: 0,
    suppressedPredictionCount: 2,
  });
});
