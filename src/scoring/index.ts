import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetClass, Prediction, ResearchReport } from "../domain/types";
import { fetchYahooClose } from "../sources/yahoo";
import { fetchCoinGeckoClose } from "../sources/coingecko";
import { resolvePrediction } from "./resolver";
import { buildCalibrationSummary } from "./calibration";
import type { ResolvedPair } from "./calibration";
import type { PredictionScore } from "./types";

const MAX_SCORE_ATTEMPTS = 5;
const SCORE_FILE = "score.json";

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

function tradingDaysElapsed(from: Date, to: Date): number {
  let count = 0;
  let cursor = addDays(from, 0);
  while (cursor.getTime() < to.getTime()) {
    cursor = addDays(cursor, 1);
    if (isWeekday(cursor)) {
      count += 1;
    }
  }
  return count;
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

async function fetchClose(
  symbol: string,
  assetClass: AssetClass,
  date: Date,
): Promise<number | undefined> {
  if (assetClass === "equity") {
    return fetchYahooClose(symbol, date);
  }
  return fetchCoinGeckoClose(symbol.toLowerCase(), date);
}

function symbolsForPrediction(prediction: Prediction): readonly string[] {
  const { kind } = prediction;
  if (kind === "direction" || kind === "volatility" || kind === "range") {
    const parsed = { subject: prediction.subject };
    return [parsed.subject];
  }
  const parts = prediction.subject.split(":");
  return parts.length === 2 ? [parts[0] as string, parts[1] as string] : [prediction.subject];
}

async function scoreOnePrediction(
  prediction: Prediction,
  report: ResearchReport,
  existingScore: PredictionScore | undefined,
  now: Date,
): Promise<PredictionScore> {
  const attemptCount = (existingScore?.attemptCount ?? 0) + 1;
  const resDate = resolutionDate(report.generatedAt, prediction.horizonTradingDays);

  if (resDate > now) {
    return {
      predictionId: prediction.id,
      runId: report.runId,
      resolved: false,
      outcome: undefined,
      observedAt: undefined,
      attemptCount: existingScore?.attemptCount ?? 0,
      evidence: { reason: "horizon not yet elapsed" },
    };
  }

  const symbols = symbolsForPrediction(prediction);
  const closesAtOrigin = await Promise.all(
    symbols.map(async (symbol) => {
      const close = await fetchClose(symbol, report.assetClass, new Date(report.generatedAt));
      return close !== undefined
        ? { symbol, date: report.generatedAt.slice(0, 10), close }
        : undefined;
    }),
  );
  const closesAtHorizon = await Promise.all(
    symbols.map(async (symbol) => {
      const close = await fetchClose(symbol, report.assetClass, resDate);
      return close !== undefined
        ? { symbol, date: resDate.toISOString().slice(0, 10), close }
        : undefined;
    }),
  );

  const allCloses = [...closesAtOrigin, ...closesAtHorizon].filter(
    (c): c is { symbol: string; date: string; close: number } => c !== undefined,
  );

  const resolveResult = resolvePrediction(prediction, allCloses);

  if (resolveResult === undefined) {
    if (attemptCount >= MAX_SCORE_ATTEMPTS) {
      return {
        predictionId: prediction.id,
        runId: report.runId,
        resolved: true,
        outcome: undefined,
        observedAt: now.toISOString(),
        attemptCount,
        evidence: { reason: "abandoned after max attempts" },
      };
    }
    return {
      predictionId: prediction.id,
      runId: report.runId,
      resolved: false,
      outcome: undefined,
      observedAt: undefined,
      attemptCount,
      evidence: { reason: "close price unavailable" },
    };
  }

  return {
    predictionId: prediction.id,
    runId: report.runId,
    resolved: true,
    outcome: resolveResult.outcome,
    observedAt: now.toISOString(),
    attemptCount,
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

async function scoreRunDir(runDir: string, now: Date): Promise<void> {
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
      scoreOnePrediction(prediction, report, existingScores.get(prediction.id), now),
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
): Promise<ScorePassResult> {
  const runDirs = await listRunDirs(dataDir);

  const results = await Promise.all(
    runDirs.map(async (runDir) => {
      const report = await loadReport(runDir);
      if (report === undefined || report.predictions.length === 0) {
        return "skipped" as const;
      }
      await scoreRunDir(runDir, now);
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
    return [{ prediction, score, assetClass: report.assetClass, runId: report.runId }];
  });
}

export async function buildAndWriteCalibration(
  dataDir: string,
  now: Date = new Date(),
): Promise<void> {
  const runDirs = await listRunDirs(dataDir);
  const pairsPerRun = await Promise.all(runDirs.map(loadRunPairs));
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
}

export { tradingDaysElapsed };
