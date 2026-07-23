import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/guards";
import {
  deriveProviderEndpointAvailability,
  unavailableEndpoint,
  type ProviderEndpointAvailability,
} from "../../src/sources/provider-endpoint-availability";
import { runFixture, type RunFixtureResult } from "./run-fixtures";

export const PHASE0_BASELINE_PATH = join(
  import.meta.dir,
  "..",
  "baselines",
  "equity-deep-phase0.json",
);

export const PHASE4_EARNINGS_COMPARISON_PATH = join(
  import.meta.dir,
  "..",
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

export interface HistoricalArtifactsBaseline {
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

function measureFixtureResult(fixture: string, result: RunFixtureResult): FixtureBaseline {
  const setup = result.collectedSources.earningsSetup;
  const eventDateStatus = setup?.event.eventDateStatus ?? setup?.event.dateStatus;
  return {
    fixture,
    earningsSetupCount: setup === undefined ? 0 : 1,
    earningsPredictionCount: result.report.predictions.filter((prediction) =>
      prediction.kind.startsWith("earnings-"),
    ).length,
    eventDateStatus: eventDateStatus ?? "not-present",
    populatedFinancialHistoryCount: Object.values(
      result.collectedSources.fundamentalHistory?.series ?? {},
    ).filter((series) => series.annual.length > 0 || series.ttm !== undefined).length,
    providerEndpointAvailability: deriveProviderEndpointAvailability(
      result.collectedSources.rawSnapshots,
      result.collectedSources.sourceGaps,
    ),
  };
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

export async function measureFixtureBaselines(): Promise<readonly FixtureBaseline[]> {
  const baselines: FixtureBaseline[] = [];
  for (const fixture of PHASE0_FIXTURES) {
    const result = await runFixture(fixture, { llm: "replay" });
    try {
      baselines.push(measureFixtureResult(fixture, result));
    } finally {
      await result.cleanup();
    }
  }
  return baselines;
}

async function measurePhase4FixtureEarningsCoverageRuns(): Promise<
  readonly (Phase4FixtureEarningsCoverage & { readonly phase0Fixture: string })[]
> {
  const coverage: (Phase4FixtureEarningsCoverage & { readonly phase0Fixture: string })[] = [];
  for (const { fixture, phase0Fixture } of PHASE4_FIXTURES) {
    const result = await runFixture(fixture, { llm: "replay" });
    try {
      coverage.push({ ...measurePhase4FixtureEarningsCoverage(fixture, result), phase0Fixture });
    } finally {
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

function stringValue(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function arrayValue(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function populatedSeriesCount(value: unknown): number | undefined {
  if (!isRecord(value) || !isRecord(value.series)) {
    return;
  }
  return Object.values(value.series).filter(
    (series) =>
      isRecord(series) && (arrayValue(series, "annual").length > 0 || isRecord(series.ttm)),
  ).length;
}

export async function measureHistoricalArtifacts(
  dataRoot = join(import.meta.dir, "..", "..", "data", "runs"),
): Promise<HistoricalArtifactsBaseline> {
  let runDirs: readonly string[] = [];
  try {
    runDirs = await readdir(dataRoot);
  } catch {
    return {
      status: "unmeasured",
      source: "data/runs",
      providerEndpointAvailability: unavailableEndpoint(
        "unmeasured",
        "Local gitignored data/runs artifacts are absent",
      ),
      reason: "Local gitignored data/runs artifacts are absent",
    };
  }

  let inspectedRunCount = 0;
  let deepEquityRunCount = 0;
  let earningsSetupCount = 0;
  let earningsPredictionCount = 0;
  let providerEstimated = 0;
  let legacyUnstamped = 0;
  let notPresent = 0;
  let measuredFinancialHistory = 0;
  let populatedFinancialSeries = 0;

  for (const runDir of runDirs.toSorted()) {
    let report: unknown = undefined;
    try {
      report = JSON.parse(await readFile(join(dataRoot, runDir, "report.json"), "utf8")) as unknown;
    } catch {
      continue;
    }
    inspectedRunCount += 1;
    if (!isRecord(report) || report.jobType !== "equity" || !isRecord(report.extras)) {
      continue;
    }
    if (report.extras.depth !== "deep") {
      continue;
    }
    deepEquityRunCount += 1;
    const setup = isRecord(report.extras.earningsSetup) ? report.extras.earningsSetup : undefined;
    if (setup === undefined) {
      notPresent += 1;
    } else {
      earningsSetupCount += 1;
      const status = isRecord(setup.event) ? stringValue(setup.event, "dateStatus") : undefined;
      if (status === "provider-estimated") {
        providerEstimated += 1;
      } else {
        legacyUnstamped += 1;
      }
    }
    earningsPredictionCount += arrayValue(report, "predictions").filter(
      (prediction) =>
        isRecord(prediction) &&
        typeof prediction.kind === "string" &&
        prediction.kind.startsWith("earnings-"),
    ).length;
    try {
      const history = JSON.parse(
        await readFile(join(dataRoot, runDir, "normalized", "fundamental-history.json"), "utf8"),
      ) as unknown;
      const count = populatedSeriesCount(history);
      if (count !== undefined) {
        measuredFinancialHistory += 1;
        populatedFinancialSeries += count;
      }
    } catch {
      // Historical artifacts predate the sidecar; absence is measured below.
    }
  }

  return {
    status: "measured",
    source: "local gitignored data/runs snapshot",
    inspectedRunCount,
    deepEquityRunCount,
    earningsSetupCount,
    earningsPredictionCount,
    eventDateStatus: { providerEstimated, legacyUnstamped, notPresent },
    financialHistory: {
      measuredRunCount: measuredFinancialHistory,
      unmeasuredRunCount: deepEquityRunCount - measuredFinancialHistory,
      populatedSeriesCount: populatedFinancialSeries,
    },
    providerEndpointAvailability: unavailableEndpoint(
      "unmeasured",
      "Historical report artifacts do not persist a stable endpoint availability matrix",
    ),
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
