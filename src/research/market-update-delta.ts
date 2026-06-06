import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  type AssetClass,
  type JobType,
  type MarketRegimeLabel,
  type MarketRegimeSummary,
  type MarketSnapshot,
  type Mover,
} from "../domain/types";
import { rankMovers } from "../movers/ranking";
import { isRecord, readNumber, readString } from "../sources/guards";
import type { ScoreOutcome } from "../scoring/types";

// ---------------------------------------------------------------------------
// Market Update Delta — a compact, deterministic "what changed since the last
// Same-cadence run" summary promoted into daily/weekly market-update reports.
//
// Distinct from the instrument-scoped Research Thesis Delta (history thesis-delta):
// This is market-update-scoped, automatic, and never calls the model. It is
// Descriptive only — research-only, no trade/sizing/execution language (ADR 0001).
// ---------------------------------------------------------------------------

const MAX_MOVER_DIFF = 8;
const MAX_RESOLVED_SINCE = 8;

export interface MarketUpdateDeltaResolvedPrediction {
  readonly runId: string;
  readonly predictionId: string;
  readonly claim: string;
  readonly probability: number;
  readonly outcome: ScoreOutcome;
  readonly observedAt: string;
}

export interface MarketUpdateDelta {
  readonly hasBaseline: boolean;
  readonly currentRegime: MarketRegimeLabel;
  readonly baselineRunId?: string;
  readonly baselineGeneratedAt?: string;
  readonly priorRegime?: MarketRegimeLabel;
  readonly regimeChanged: boolean;
  readonly flippedDrivers: readonly string[];
  readonly moversEntered: readonly string[];
  readonly moversExited: readonly string[];
  readonly resolvedSince: readonly MarketUpdateDeltaResolvedPrediction[];
}

export interface BuildMarketUpdateDeltaInput {
  readonly dataDir: string;
  readonly command: ResearchCommand;
  readonly now: Date;
  readonly currentMovers: readonly Mover[];
  readonly currentRegime: MarketRegimeSummary;
  readonly moverLimit: number;
}

// A run directory's report.json reduced to the fields the delta needs.
interface ScannedRun {
  readonly dir: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly extras: Record<string, unknown> | undefined;
  readonly predictions: ReadonlyMap<
    string,
    { readonly claim: string; readonly probability: number }
  >;
}

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isJobType(value: unknown): value is JobType {
  return value === "daily" || value === "weekly" || value === "ticker" || value === "alpha-search";
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

// Parse an ISO timestamp to epoch ms for ordering, tolerating malformed values
// (generatedAt/observedAt are read from disk without format validation).
function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readPredictionMap(
  value: unknown,
): ReadonlyMap<string, { readonly claim: string; readonly probability: number }> {
  const map = new Map<string, { readonly claim: string; readonly probability: number }>();
  if (!Array.isArray(value)) {
    return map;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = readString(item, "id");
    const claim = readString(item, "claim");
    const probability = readNumber(item, "probability");
    if (id === undefined || claim === undefined || probability === undefined) {
      continue;
    }
    map.set(id, { claim, probability });
  }
  return map;
}

async function loadScannedRun(dir: string): Promise<ScannedRun | undefined> {
  const report = await readJson(join(dir, "report.json"));
  if (!isRecord(report)) {
    return undefined;
  }
  const runId = readString(report, "runId");
  const generatedAt = readString(report, "generatedAt");
  if (
    runId === undefined ||
    generatedAt === undefined ||
    !isJobType(report.jobType) ||
    !isAssetClass(report.assetClass)
  ) {
    return undefined;
  }
  return {
    dir,
    runId,
    generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    extras: isRecord(report.extras) ? report.extras : undefined,
    predictions: readPredictionMap(report.predictions),
  };
}

async function scanRuns(dataDir: string): Promise<readonly ScannedRun[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => loadScannedRun(join(dataDir, entry.name))),
  );
  return loaded.filter((run): run is ScannedRun => run !== undefined);
}

// ---------------------------------------------------------------------------
// Regime driver categorisation — diff prior vs current regime drivers by their
// Stable category (breadth / trend / VIX term structure / VIX elevated / FRED
// Macro) and directional read, so flipped drivers are named without leaking the
// Noisy embedded counts ("3/5") into the comparison.
// ---------------------------------------------------------------------------

type DriverDirection = "risk-on" | "risk-off" | "neutral";

function driverCategory(driver: string): string | undefined {
  if (driver.startsWith("equity breadth proxies") || driver.startsWith("major crypto proxies")) {
    return "breadth";
  }
  if (driver.startsWith("trend")) {
    return "trend";
  }
  if (driver.startsWith("VIX term structure")) {
    return "VIX term structure";
  }
  if (driver.startsWith("VIX elevated")) {
    return "VIX elevated";
  }
  if (driver.startsWith("FRED macro")) {
    return "FRED macro";
  }
  return undefined;
}

function driverDirection(driver: string): DriverDirection {
  if (
    driver.includes("backwardation") ||
    driver.includes("elevated") ||
    driver.includes("negative")
  ) {
    return "risk-off";
  }
  if (driver.includes("positive")) {
    return "risk-on";
  }
  return "neutral";
}

function driverDirections(drivers: readonly string[]): ReadonlyMap<string, DriverDirection> {
  const map = new Map<string, DriverDirection>();
  for (const driver of drivers) {
    const category = driverCategory(driver);
    if (category !== undefined) {
      map.set(category, driverDirection(driver));
    }
  }
  return map;
}

function flippedDrivers(
  priorDrivers: readonly string[],
  currentDrivers: readonly string[],
): readonly string[] {
  const prior = driverDirections(priorDrivers);
  const current = driverDirections(currentDrivers);
  const categories = new Set([...prior.keys(), ...current.keys()]);
  const flipped: string[] = [];
  for (const category of categories) {
    const priorDir = prior.get(category) ?? "neutral";
    const currentDir = current.get(category) ?? "neutral";
    // A flip is a directional sense change; two "neutral" reads are not a flip.
    if (priorDir !== currentDir && (priorDir !== "neutral" || currentDir !== "neutral")) {
      flipped.push(category);
    }
  }
  return flipped.toSorted((left, right) => left.localeCompare(right));
}

function regimeFromExtras(extras: Record<string, unknown> | undefined): {
  readonly label: MarketRegimeLabel | undefined;
  readonly drivers: readonly string[];
} {
  const regime = extras?.marketRegime;
  if (!isRecord(regime)) {
    return { label: undefined, drivers: [] };
  }
  const { label } = regime;
  const drivers = Array.isArray(regime.drivers)
    ? regime.drivers.filter((driver): driver is string => typeof driver === "string")
    : [];
  return {
    label: isRegimeLabel(label) ? label : undefined,
    drivers,
  };
}

function isRegimeLabel(value: unknown): value is MarketRegimeLabel {
  return (
    value === "risk-on" ||
    value === "risk-off" ||
    value === "mixed" ||
    value === "insufficient-data"
  );
}

// ---------------------------------------------------------------------------
// Mover membership diff
// ---------------------------------------------------------------------------

function moverSymbols(movers: readonly Mover[]): readonly string[] {
  return [...new Set(movers.map((mover) => mover.snapshot.symbol.toUpperCase()))];
}

async function baselineMoverSymbols(
  baseline: ScannedRun,
  assetClass: AssetClass,
  moverLimit: number,
): Promise<readonly string[]> {
  const persisted = await readJson(join(baseline.dir, "normalized", "movers.json"));
  if (Array.isArray(persisted) && persisted.length > 0) {
    // Persisted movers.json holds full Mover objects: snapshot.symbol.
    return [
      ...new Set(
        persisted.flatMap((mover) => {
          if (!isRecord(mover) || !isRecord(mover.snapshot)) {
            return [];
          }
          const symbol = readString(mover.snapshot, "symbol");
          return symbol === undefined ? [] : [symbol.toUpperCase()];
        }),
      ),
    ];
  }
  // Fallback for older runs lacking movers.json: re-rank persisted snapshots.
  const snapshots = await readJson(join(baseline.dir, "normalized", "market-snapshots.json"));
  if (!Array.isArray(snapshots)) {
    return [];
  }
  const typed = snapshots.filter(
    (snapshot): snapshot is MarketSnapshot =>
      isRecord(snapshot) && snapshot.assetClass === assetClass,
  );
  return moverSymbols(rankMovers(typed, moverLimit));
}

function membershipDiff(
  prior: readonly string[],
  current: readonly string[],
): { readonly entered: readonly string[]; readonly exited: readonly string[] } {
  const priorSet = new Set(prior);
  const currentSet = new Set(current);
  const entered = current.filter((symbol) => !priorSet.has(symbol)).slice(0, MAX_MOVER_DIFF);
  const exited = prior.filter((symbol) => !currentSet.has(symbol)).slice(0, MAX_MOVER_DIFF);
  return { entered, exited };
}

// ---------------------------------------------------------------------------
// Resolved-since window
// ---------------------------------------------------------------------------

function resolvedSince(
  runs: readonly ScannedRun[],
  assetClass: AssetClass,
  baselineGeneratedAt: string,
): Promise<readonly MarketUpdateDeltaResolvedPrediction[]> {
  const baselineTime = timeValue(baselineGeneratedAt);
  return Promise.all(
    runs
      .filter((run) => run.assetClass === assetClass && isMarketUpdateJobType(run.jobType))
      .map(async (run): Promise<readonly MarketUpdateDeltaResolvedPrediction[]> => {
        const scoreFile = await readJson(join(run.dir, "score.json"));
        if (!isRecord(scoreFile) || !Array.isArray(scoreFile.scores)) {
          return [];
        }
        return scoreFile.scores.flatMap((score): MarketUpdateDeltaResolvedPrediction[] => {
          if (!isRecord(score) || score.resolved !== true) {
            return [];
          }
          const observedAt = readString(score, "observedAt");
          const predictionId = readString(score, "predictionId");
          const { outcome } = score;
          // Legacy scores without observedAt are excluded from the window.
          if (
            observedAt === undefined ||
            predictionId === undefined ||
            (outcome !== "hit" && outcome !== "miss") ||
            timeValue(observedAt) <= baselineTime
          ) {
            return [];
          }
          const prediction = run.predictions.get(predictionId);
          if (prediction === undefined) {
            return [];
          }
          return [
            {
              runId: run.runId,
              predictionId,
              claim: prediction.claim,
              probability: prediction.probability,
              outcome,
              observedAt,
            },
          ];
        });
      }),
  ).then((nested) =>
    nested
      .flat()
      .toSorted((left, right) => timeValue(right.observedAt) - timeValue(left.observedAt))
      .slice(0, MAX_RESOLVED_SINCE),
  );
}

// ---------------------------------------------------------------------------
// Entry point — deterministic given disk state + now.
// ---------------------------------------------------------------------------

export async function buildMarketUpdateDelta(
  input: BuildMarketUpdateDeltaInput,
): Promise<MarketUpdateDelta> {
  const { command, currentRegime } = input;
  const runs = await scanRuns(input.dataDir);
  const nowTime = input.now.getTime();
  const [baseline] = runs
    .filter(
      (run) =>
        run.assetClass === command.assetClass &&
        run.jobType === command.jobType &&
        timeValue(run.generatedAt) < nowTime,
    )
    .toSorted((left, right) => timeValue(right.generatedAt) - timeValue(left.generatedAt));

  if (baseline === undefined) {
    return {
      hasBaseline: false,
      currentRegime: currentRegime.label,
      regimeChanged: false,
      flippedDrivers: [],
      moversEntered: [],
      moversExited: [],
      resolvedSince: [],
    };
  }

  const priorRegime = regimeFromExtras(baseline.extras);
  const regimeChanged =
    priorRegime.label !== undefined && priorRegime.label !== currentRegime.label;

  const priorMovers = await baselineMoverSymbols(baseline, command.assetClass, input.moverLimit);
  const { entered, exited } = membershipDiff(priorMovers, moverSymbols(input.currentMovers));

  const resolved = await resolvedSince(runs, command.assetClass, baseline.generatedAt);

  return {
    hasBaseline: true,
    currentRegime: currentRegime.label,
    baselineRunId: baseline.runId,
    baselineGeneratedAt: baseline.generatedAt,
    ...(priorRegime.label !== undefined ? { priorRegime: priorRegime.label } : {}),
    regimeChanged,
    flippedDrivers: flippedDrivers(priorRegime.drivers, currentRegime.drivers),
    moversEntered: entered,
    moversExited: exited,
    resolvedSince: resolved,
  };
}
