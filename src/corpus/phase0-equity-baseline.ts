import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderEndpointAvailability } from "../sources/provider-endpoint-availability";
import { runFixture, type RunFixtureResult } from "../replay/fixture-run";

const PHASE0_BASELINE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "baselines",
  "equity-deep-phase0.json",
);

export const PHASE4_EARNINGS_COMPARISON_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "tests",
  "baselines",
  "equity-deep-phase4-earnings-comparison.json",
);

const PHASE0_FIXTURES = [
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
] as const;

const PHASE4_FIXTURES = [
  ...PHASE0_FIXTURES.map((fixture) => ({ fixture, phase0Fixture: fixture })),
  {
    fixture: "equity-analysis-estimated-suppressed",
    phase0Fixture: "equity-analysis-comprehensive",
  },
] as const;

interface FixtureBaseline {
  readonly fixture: string;
  readonly earningsSetupCount: number;
  readonly earningsPredictionCount: number;
  readonly eventDateStatus:
    | "provider-estimated"
    | "issuer-confirmed"
    | "exchange-confirmed"
    | "not-present";
  readonly populatedFinancialHistoryCount: number;
  readonly providerEndpointAvailability: Readonly<Record<string, ProviderEndpointAvailability>>;
}

interface Phase4FixtureEarningsCoverage {
  readonly fixture: string;
  readonly earningsSetupCount: number;
  readonly earningsPredictionCount: number;
  readonly calibrationEligiblePredictionCount: number;
  readonly eventDateStatus:
    | "provider-estimated"
    | "issuer-confirmed"
    | "exchange-confirmed"
    | "not-present";
  readonly grammarEligible: boolean;
  readonly eligiblePredictionCount: number;
  readonly suppressedPredictionCount: number;
}

interface EarningsCoverageTotals {
  readonly earningsSetupCount: number;
  readonly earningsPredictionCount: number;
  readonly calibrationEligiblePredictionCount: number;
}

export interface Phase4EarningsCoverageComparison {
  readonly version: 1;
  readonly description: string;
  readonly calibrationCoverageDefinition: string;
  readonly phase0BaselinePath: string;
  readonly fixtureRuns: readonly {
    readonly fixture: string;
    readonly eventDateStatus: Phase4FixtureEarningsCoverage["eventDateStatus"];
    readonly phase0EarningsSetupCount: number;
    readonly phase4EarningsSetupCount: number;
    readonly phase0EarningsPredictionCount: number;
    readonly phase4EarningsPredictionCount: number;
    readonly predictionCountDelta: number;
    readonly phase0CalibrationEligiblePredictionCount: number;
    readonly phase4CalibrationEligiblePredictionCount: number;
    readonly calibrationCoverageDelta: number;
    readonly grammarEligible: boolean;
    readonly eligiblePredictionCount: number;
    readonly suppressedPredictionCount: number;
  }[];
  readonly totals: {
    readonly phase0: EarningsCoverageTotals;
    readonly phase4: EarningsCoverageTotals & {
      readonly eligiblePredictionCount: number;
      readonly suppressedPredictionCount: number;
    };
    readonly delta: EarningsCoverageTotals;
  };
  readonly historicalPhase0Reference: {
    readonly status: "reference-only-not-replayed";
    readonly deepEquityRunCount: number;
    readonly earningsSetupCount: number;
    readonly earningsPredictionCount: number;
  };
}

interface HistoricalArtifactsBaseline {
  readonly status: "measured" | "unmeasured";
  readonly source: string;
  readonly inspectedRunCount?: number;
  readonly deepEquityRunCount?: number;
  readonly earningsSetupCount?: number;
  readonly earningsPredictionCount?: number;
  readonly eventDateStatus?: {
    readonly providerEstimated: number;
    readonly legacyUnstamped: number;
    readonly notPresent: number;
  };
  readonly financialHistory?: {
    readonly measuredRunCount: number;
    readonly unmeasuredRunCount: number;
    readonly populatedSeriesCount: number;
  };
  readonly providerEndpointAvailability: ProviderEndpointAvailability;
  readonly reason?: string;
}

export interface Phase0EquityBaseline {
  readonly version: 1;
  readonly description: string;
  readonly fixtureRuns: readonly FixtureBaseline[];
  readonly historicalArtifacts: HistoricalArtifactsBaseline;
}

function measurePhase4FixtureEarningsCoverage(
  fixture: string,
  result: RunFixtureResult,
): Phase4FixtureEarningsCoverage {
  const telemetry = result.analytics.earningsForecasts;
  if (telemetry === undefined) {
    throw new Error(`${fixture}: earnings forecast telemetry is missing`);
  }
  const earningsPredictionCount = result.report.predictions.filter((prediction) =>
    prediction.kind.startsWith("earnings-"),
  ).length;
  return {
    fixture,
    earningsSetupCount: result.collectedSources.earningsSetup === undefined ? 0 : 1,
    earningsPredictionCount,
    calibrationEligiblePredictionCount: earningsPredictionCount,
    eventDateStatus: telemetry.eventDateStatus,
    grammarEligible: telemetry.grammarEligible,
    eligiblePredictionCount: telemetry.eligiblePredictionCount,
    suppressedPredictionCount: telemetry.suppressedPredictionCount,
  };
}

async function measurePhase4FixtureEarningsCoverageRuns(): Promise<
  readonly (Phase4FixtureEarningsCoverage & { readonly phase0Fixture: string })[]
> {
  const coverage: (Phase4FixtureEarningsCoverage & { readonly phase0Fixture: string })[] = [];
  for (const { fixture, phase0Fixture } of PHASE4_FIXTURES) {
    // eslint-disable-next-line no-await-in-loop -- each replay is cleaned up before the next starts
    const result = await runFixture(fixture, { llm: "replay" });
    try {
      coverage.push({ ...measurePhase4FixtureEarningsCoverage(fixture, result), phase0Fixture });
    } finally {
      // eslint-disable-next-line no-await-in-loop -- cleanup before the next replay
      await result.cleanup();
    }
  }
  return coverage;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function requiredHistoricalCount(
  baseline: Phase0EquityBaseline,
  key: "deepEquityRunCount" | "earningsSetupCount" | "earningsPredictionCount",
): number {
  const value = baseline.historicalArtifacts[key];
  if (baseline.historicalArtifacts.status !== "measured" || value === undefined) {
    throw new Error(`Phase 0 historical ${key} is not measured`);
  }
  return value;
}

export async function measurePhase4EarningsCoverageComparison(): Promise<Phase4EarningsCoverageComparison> {
  const [baseline, phase4Coverage] = await Promise.all([
    readPhase0Baseline(),
    measurePhase4FixtureEarningsCoverageRuns(),
  ]);
  const phase0ByFixture = new Map(
    baseline.fixtureRuns.map((fixture) => [fixture.fixture, fixture]),
  );
  const fixtureRuns = phase4Coverage.map((current) => {
    const phase0 = phase0ByFixture.get(current.phase0Fixture);
    if (phase0 === undefined) {
      throw new Error(`${current.phase0Fixture}: missing from Phase 0 baseline`);
    }
    return {
      fixture: current.fixture,
      eventDateStatus: current.eventDateStatus,
      phase0EarningsSetupCount: phase0.earningsSetupCount,
      phase4EarningsSetupCount: current.earningsSetupCount,
      phase0EarningsPredictionCount: phase0.earningsPredictionCount,
      phase4EarningsPredictionCount: current.earningsPredictionCount,
      predictionCountDelta: current.earningsPredictionCount - phase0.earningsPredictionCount,
      phase0CalibrationEligiblePredictionCount: phase0.earningsPredictionCount,
      phase4CalibrationEligiblePredictionCount: current.calibrationEligiblePredictionCount,
      calibrationCoverageDelta:
        current.calibrationEligiblePredictionCount - phase0.earningsPredictionCount,
      grammarEligible: current.grammarEligible,
      eligiblePredictionCount: current.eligiblePredictionCount,
      suppressedPredictionCount: current.suppressedPredictionCount,
    };
  });
  const phase0Totals: EarningsCoverageTotals = {
    earningsSetupCount: sum(fixtureRuns.map((fixture) => fixture.phase0EarningsSetupCount)),
    earningsPredictionCount: sum(
      fixtureRuns.map((fixture) => fixture.phase0EarningsPredictionCount),
    ),
    calibrationEligiblePredictionCount: sum(
      fixtureRuns.map((fixture) => fixture.phase0CalibrationEligiblePredictionCount),
    ),
  };
  const phase4Totals = {
    earningsSetupCount: sum(fixtureRuns.map((fixture) => fixture.phase4EarningsSetupCount)),
    earningsPredictionCount: sum(
      fixtureRuns.map((fixture) => fixture.phase4EarningsPredictionCount),
    ),
    calibrationEligiblePredictionCount: sum(
      fixtureRuns.map((fixture) => fixture.phase4CalibrationEligiblePredictionCount),
    ),
    eligiblePredictionCount: sum(fixtureRuns.map((fixture) => fixture.eligiblePredictionCount)),
    suppressedPredictionCount: sum(fixtureRuns.map((fixture) => fixture.suppressedPredictionCount)),
  };
  return {
    version: 1,
    description:
      "Phase 4 earnings-date gating compared with the immutable Phase 0 deep-equity fixture baseline",
    calibrationCoverageDefinition:
      "Emitted observable earnings predictions eligible to enter scoring and calibration once resolved; replay fixtures contain no resolved outcomes.",
    phase0BaselinePath: "tests/baselines/equity-deep-phase0.json",
    fixtureRuns,
    totals: {
      phase0: phase0Totals,
      phase4: phase4Totals,
      delta: {
        earningsSetupCount: phase4Totals.earningsSetupCount - phase0Totals.earningsSetupCount,
        earningsPredictionCount:
          phase4Totals.earningsPredictionCount - phase0Totals.earningsPredictionCount,
        calibrationEligiblePredictionCount:
          phase4Totals.calibrationEligiblePredictionCount -
          phase0Totals.calibrationEligiblePredictionCount,
      },
    },
    historicalPhase0Reference: {
      status: "reference-only-not-replayed",
      deepEquityRunCount: requiredHistoricalCount(baseline, "deepEquityRunCount"),
      earningsSetupCount: requiredHistoricalCount(baseline, "earningsSetupCount"),
      earningsPredictionCount: requiredHistoricalCount(baseline, "earningsPredictionCount"),
    },
  };
}

export async function readPhase0Baseline(): Promise<Phase0EquityBaseline> {
  return JSON.parse(await readFile(PHASE0_BASELINE_PATH, "utf8")) as Phase0EquityBaseline;
}

export async function readPhase4EarningsCoverageComparison(): Promise<Phase4EarningsCoverageComparison> {
  return JSON.parse(
    await readFile(PHASE4_EARNINGS_COMPARISON_PATH, "utf8"),
  ) as Phase4EarningsCoverageComparison;
}
