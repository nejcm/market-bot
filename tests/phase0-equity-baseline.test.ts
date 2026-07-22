import { expect, test } from "bun:test";
import { measureFixtureBaselines, readPhase0Baseline } from "./support/phase0-equity-baseline";

test("Phase 0 deep-equity telemetry matches the committed baseline", async () => {
  const baseline = await readPhase0Baseline();

  expect(await measureFixtureBaselines()).toEqual(baseline.fixtureRuns);
  expect(
    baseline.fixtureRuns.reduce((count, fixture) => count + fixture.earningsPredictionCount, 0),
  ).toBeGreaterThan(0);
  expect(baseline.historicalArtifacts.status).toBe("measured");
  expect(baseline.historicalArtifacts.providerEndpointAvailability.status).toBe("unmeasured");
});
