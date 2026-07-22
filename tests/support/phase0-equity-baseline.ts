import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../src/guards";
import { runFixture, type RunFixtureResult } from "./run-fixtures";

export const PHASE0_BASELINE_PATH = join(
  import.meta.dir,
  "..",
  "baselines",
  "equity-deep-phase0.json",
);

const FIXTURES = [
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
] as const;

interface EndpointAvailability {
  readonly status: "available" | "missing-credential" | "unsupported" | "unmeasured";
  readonly evidence: readonly string[];
  readonly reason?: string;
}

interface FixtureBaseline {
  readonly fixture: string;
  readonly earningsSetupCount: number;
  readonly earningsPredictionCount: number;
  readonly eventDateStatus: "provider-estimated" | "not-present";
  readonly populatedFinancialHistoryCount: number;
  readonly providerEndpointAvailability: Readonly<Record<string, EndpointAvailability>>;
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
  readonly providerEndpointAvailability: EndpointAvailability;
  readonly reason?: string;
}

export interface Phase0EquityBaseline {
  readonly version: 1;
  readonly description: string;
  readonly fixtureRuns: readonly FixtureBaseline[];
  readonly historicalArtifacts: HistoricalArtifactsBaseline;
}

function available(evidence: readonly string[]): EndpointAvailability {
  return { status: "available", evidence };
}

function unavailable(
  status: "missing-credential" | "unsupported" | "unmeasured",
  reason: string,
  evidence: readonly string[] = [],
): EndpointAvailability {
  return { status, evidence, reason };
}

function endpointAvailability(
  result: RunFixtureResult,
  adapters: readonly string[],
  gapSources: readonly string[],
): EndpointAvailability {
  const observedAdapters = [
    ...new Set(
      result.collectedSources.rawSnapshots
        .map((snapshot) => snapshot.adapter)
        .filter((adapter) => adapters.some((candidate) => adapter.startsWith(candidate))),
    ),
  ].toSorted();
  if (observedAdapters.length > 0) {
    return available(observedAdapters);
  }
  const gaps = result.collectedSources.sourceGaps.filter((gap) => gapSources.includes(gap.source));
  const missingCredential = gaps.find((gap) => gap.cause === "missing-credential");
  if (missingCredential !== undefined) {
    return unavailable("missing-credential", missingCredential.message, gapSources);
  }
  const unsupported = gaps.find((gap) => gap.cause === "unsupported-coverage");
  if (unsupported !== undefined) {
    return unavailable("unsupported", unsupported.message, gapSources);
  }
  return unavailable(
    "unmeasured",
    `No request or normalized availability gap for ${gapSources.join(", ")}`,
  );
}

function measureFixtureResult(fixture: string, result: RunFixtureResult): FixtureBaseline {
  const setup = result.collectedSources.earningsSetup;
  const eventDateStatus = (
    setup?.event as { readonly dateStatus?: "provider-estimated" } | undefined
  )?.dateStatus;
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
    providerEndpointAvailability: {
      yahooQuote: endpointAvailability(result, ["yahoo-ticker"], ["yahoo-ticker"]),
      yahooNews: endpointAvailability(result, ["yahoo-news"], ["yahoo-news"]),
      secCompanyTickers: endpointAvailability(result, ["sec-tickers"], ["sec-edgar"]),
      secCompanyFacts: endpointAvailability(result, ["sec-companyfacts"], ["sec-edgar"]),
      secSubmissions: endpointAvailability(result, ["sec-submissions"], ["sec-edgar"]),
      finnhubNews: endpointAvailability(result, ["finnhub-news"], ["finnhub-news"]),
      finnhubEvents: endpointAvailability(result, ["finnhub-events"], ["finnhub-events"]),
      tradierOptions: endpointAvailability(result, ["tradier-options"], ["tradier-options"]),
      tradierEarningsImpliedMove:
        setup?.impliedMove !== undefined
          ? available(["earningsSetup.impliedMove"])
          : endpointAvailability(
              result,
              ["tradier-earnings"],
              ["earnings-setup-implied-move", "tradier-options"],
            ),
      fredMacro: endpointAvailability(result, ["fred-"], ["fred-macro"]),
      marketauxNews: endpointAvailability(result, ["marketaux-news"], ["marketaux-news"]),
    },
  };
}

export async function measureFixtureBaselines(): Promise<readonly FixtureBaseline[]> {
  const baselines: FixtureBaseline[] = [];
  for (const fixture of FIXTURES) {
    const result = await runFixture(fixture, { llm: "replay" });
    try {
      baselines.push(measureFixtureResult(fixture, result));
    } finally {
      await result.cleanup();
    }
  }
  return baselines;
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
      providerEndpointAvailability: unavailable(
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
    providerEndpointAvailability: unavailable(
      "unmeasured",
      "Historical report artifacts do not persist a stable endpoint availability matrix",
    ),
  };
}

export async function readPhase0Baseline(): Promise<Phase0EquityBaseline> {
  return JSON.parse(await readFile(PHASE0_BASELINE_PATH, "utf8")) as Phase0EquityBaseline;
}
