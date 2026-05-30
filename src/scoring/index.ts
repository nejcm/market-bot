import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMarketUpdateJobType, type Prediction, type ResearchReport } from "../domain/types";
import { observableForecastFromPrediction, type ObservableForecast } from "../forecast/observable";
import { resolvePrediction } from "./resolver";
import { buildCalibrationSummary, type ResolvedPair } from "./calibration";
import { renderCalibrationMarkdown } from "./calibration-markdown";
import {
  createObservationRepository,
  type Observation,
  type ObservationRepository,
  type FetchCloseFn,
} from "./observations";
import type { PredictionScore } from "./types";

const MAX_SCORE_ATTEMPTS = 5;
const SCORE_FILE = "score.json";
export const SCORING_VERSION = 2;

interface ScoreFile {
  readonly runId: string;
  readonly scores: readonly PredictionScore[];
  readonly scoredAt: string;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function isWeekday(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6;
}

function resolutionDate(generatedAt: string, horizonTradingDays: number): Date {
  let count = 0;
  let cursor = new Date(generatedAt);
  while (count < horizonTradingDays) {
    cursor = addDays(cursor, 1);
    if (isWeekday(cursor)) {
      count += 1;
    }
  }
  return cursor;
}

export interface ScorePassOptions {
  readonly closeCacheDir?: string;
  readonly observationRepository?: ObservationRepository;
  readonly fetchClose?: FetchCloseFn;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
}

function unresolvedScore(
  prediction: Prediction,
  report: ResearchReport,
  attemptCount: number,
  evidence: Record<string, unknown>,
): PredictionScore {
  return {
    predictionId: prediction.id,
    runId: report.runId,
    resolved: false,
    outcome: undefined,
    observedAt: undefined,
    attemptCount,
    scoringVersion: SCORING_VERSION,
    evidence,
  };
}

function isCloseBasedForecast(forecast: ObservableForecast): boolean {
  return (
    forecast.expression.kind === "direction" ||
    forecast.expression.kind === "relative" ||
    forecast.expression.kind === "volatility" ||
    forecast.expression.kind === "range"
  );
}

function windowSubjects(forecast: ObservableForecast): readonly string[] {
  if (forecast.expression.kind === "relative") {
    return [forecast.expression.subjectA, forecast.expression.subjectB];
  }
  if (
    forecast.expression.kind === "direction" ||
    forecast.expression.kind === "volatility" ||
    forecast.expression.kind === "range"
  ) {
    return [forecast.expression.subject];
  }
  return [];
}

async function closeObservations(
  forecast: ObservableForecast,
  report: ResearchReport,
  now: Date,
  repo: ObservationRepository,
): Promise<readonly Observation[]> {
  const subjects = windowSubjects(forecast);
  const windows = await Promise.all(
    subjects.map((subject) =>
      repo.window(subject, report.assetClass, new Date(report.generatedAt), now),
    ),
  );
  const required = forecast.horizonTradingDays + 1;
  const enough = windows.every((window) => window.length >= required);

  if (!enough) {
    return [];
  }

  return windows.flatMap((window) => window.slice(0, required));
}

async function pointObservations(
  forecast: ObservableForecast,
  report: ResearchReport,
  resDate: Date,
  repo: ObservationRepository,
): Promise<readonly Observation[]> {
  const originDate = new Date(report.generatedAt);
  const symbols = forecast.instruments;
  const atOrigin =
    forecast.expression.kind === "iv"
      ? []
      : await Promise.all(
          symbols.map((symbol) => repo.point(symbol, report.assetClass, originDate)),
        );
  const atHorizon = await Promise.all(
    symbols.map((symbol) => repo.point(symbol, report.assetClass, resDate)),
  );

  return [...atOrigin, ...atHorizon].filter(
    (observation): observation is Observation => observation !== undefined,
  );
}

async function scoreOnePrediction(
  prediction: Prediction,
  report: ResearchReport,
  existingScore: PredictionScore | undefined,
  now: Date,
  options: ScorePassOptions,
): Promise<PredictionScore> {
  const attemptCount = (existingScore?.attemptCount ?? 0) + 1;
  const forecast = observableForecastFromPrediction(prediction);
  if (!("prediction" in forecast)) {
    throw new Error(forecast.message);
  }
  const resDate = resolutionDate(report.generatedAt, prediction.horizonTradingDays);

  if (resDate > now) {
    return unresolvedScore(prediction, report, existingScore?.attemptCount ?? 0, {
      reason: "horizon not yet elapsed",
    });
  }

  const repo =
    options.observationRepository ??
    createObservationRepository({
      report,
      ...(options.closeCacheDir !== undefined ? { cacheDir: options.closeCacheDir } : {}),
      ...(options.fetchClose !== undefined ? { fetchClose: options.fetchClose } : {}),
      ...(options.fredApiKey !== undefined ? { fredApiKey: options.fredApiKey } : {}),
      ...(options.tradierApiToken !== undefined
        ? { tradierApiToken: options.tradierApiToken }
        : {}),
      now,
    });
  const observations = isCloseBasedForecast(forecast)
    ? await closeObservations(forecast, report, now, repo)
    : await pointObservations(forecast, report, resDate, repo);

  const resolveResult = resolvePrediction(prediction, observations);

  if (resolveResult === undefined) {
    if (attemptCount >= MAX_SCORE_ATTEMPTS) {
      return {
        predictionId: prediction.id,
        runId: report.runId,
        resolved: true,
        outcome: undefined,
        observedAt: now.toISOString(),
        attemptCount,
        scoringVersion: SCORING_VERSION,
        evidence: { reason: "abandoned after max attempts" },
      };
    }
    return unresolvedScore(prediction, report, attemptCount, {
      reason: "observation unavailable",
    });
  }

  return {
    predictionId: prediction.id,
    runId: report.runId,
    resolved: true,
    outcome: resolveResult.outcome,
    observedAt: now.toISOString(),
    attemptCount,
    scoringVersion: SCORING_VERSION,
    evidence: resolveResult.evidence,
  };
}

async function loadScoreFile(runDir: string): Promise<ScoreFile | undefined> {
  try {
    const raw = await readFile(join(runDir, SCORE_FILE), "utf8");
    return JSON.parse(raw) as ScoreFile;
  } catch {
    return undefined;
  }
}

async function loadReport(runDir: string): Promise<ResearchReport | undefined> {
  try {
    const raw = await readFile(join(runDir, "report.json"), "utf8");
    return JSON.parse(raw) as ResearchReport;
  } catch {
    return undefined;
  }
}

async function scoreRunDir(runDir: string, now: Date, options: ScorePassOptions): Promise<void> {
  const report = await loadReport(runDir);
  if (report === undefined || report.predictions.length === 0) {
    return;
  }

  const existing = await loadScoreFile(runDir);
  const existingScores = new Map(existing?.scores.map((score) => [score.predictionId, score]));

  const pendingPredictions = report.predictions.filter((prediction) => {
    const prev = existingScores.get(prediction.id);
    if (prev === undefined) {
      return true;
    }
    if (prev.resolved) {
      return false;
    }
    return prev.attemptCount < MAX_SCORE_ATTEMPTS;
  });

  if (pendingPredictions.length === 0) {
    return;
  }

  const newScores = await Promise.all(
    pendingPredictions.map((prediction) =>
      scoreOnePrediction(prediction, report, existingScores.get(prediction.id), now, options),
    ),
  );

  const mergedScores: PredictionScore[] = [];
  for (const prediction of report.predictions) {
    const newScore = newScores.find((score) => score.predictionId === prediction.id);
    const existing2 = existingScores.get(prediction.id);
    if (newScore !== undefined) {
      mergedScores.push(newScore);
    } else if (existing2 !== undefined) {
      mergedScores.push(existing2);
    }
  }

  const scoreFile: ScoreFile = {
    runId: report.runId,
    scores: mergedScores,
    scoredAt: now.toISOString(),
  };

  await writeFile(join(runDir, SCORE_FILE), `${JSON.stringify(scoreFile, undefined, 2)}\n`, "utf8");
}

async function listRunDirs(dataDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dataDir, entry.name));
  } catch {
    return [];
  }
}

export interface ScorePassResult {
  readonly scored: number;
  readonly skipped: number;
}

export async function runScorePass(
  dataDir: string,
  now: Date = new Date(),
  options: ScorePassOptions = {},
): Promise<ScorePassResult> {
  const runDirs = await listRunDirs(dataDir);

  const results = await Promise.all(
    runDirs.map(async (runDir) => {
      const report = await loadReport(runDir);
      if (report === undefined || report.predictions.length === 0) {
        return "skipped" as const;
      }
      await scoreRunDir(runDir, now, options);
      return "scored" as const;
    }),
  );

  return {
    scored: results.filter((result) => result === "scored").length,
    skipped: results.filter((result) => result === "skipped").length,
  };
}

async function loadRunPairs(runDir: string): Promise<readonly ResolvedPair[]> {
  const report = await loadReport(runDir);
  if (report === undefined || report.predictions.length === 0) {
    return [];
  }
  const scoreFile = await loadScoreFile(runDir);
  if (scoreFile === undefined) {
    return [];
  }
  return report.predictions.flatMap((prediction) => {
    const score = scoreFile.scores.find((sc) => sc.predictionId === prediction.id);
    if (score === undefined || !score.resolved || score.outcome === undefined) {
      return [];
    }
    return [
      {
        prediction,
        score,
        assetClass: report.assetClass,
        jobType: report.jobType,
        ...(isMarketUpdateJobType(report.jobType) ? { marketUpdateCadence: report.jobType } : {}),
        runId: report.runId,
      },
    ];
  });
}

export async function buildAndWriteCalibration(
  dataDir: string,
  now: Date = new Date(),
): Promise<void> {
  const runDirs = await listRunDirs(dataDir);
  const pairsPerRun = await Promise.all(runDirs.map((runDir) => loadRunPairs(runDir)));
  const pairs = pairsPerRun.flat();

  if (pairs.length === 0) {
    return;
  }

  const summary = buildCalibrationSummary(pairs, now);
  const calibrationDir = join(dataDir, "../calibration");
  await mkdir(calibrationDir, { recursive: true });
  await writeFile(
    join(calibrationDir, "summary.json"),
    `${JSON.stringify(summary, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(join(calibrationDir, "summary.md"), renderCalibrationMarkdown(summary), "utf8");
}
