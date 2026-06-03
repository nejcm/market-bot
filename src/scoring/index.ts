import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMarketUpdateJobType, type Prediction, type ResearchReport } from "../domain/types";
import { resolveOutcome } from "./resolver";
import { buildCalibrationSummary, type ResolvedPair } from "./calibration";
import { renderCalibrationMarkdown } from "./calibration-markdown";
import {
  createObservationRepository,
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

async function scoreOnePrediction(
  prediction: Prediction,
  report: ResearchReport,
  existingScore: PredictionScore | undefined,
  now: Date,
  options: ScorePassOptions,
): Promise<PredictionScore> {
  const attemptCount = (existingScore?.attemptCount ?? 0) + 1;
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

  const resolveResult = await resolveOutcome(prediction, report, repo, now);

  if (resolveResult.status === "unresolved") {
    if (resolveResult.reason === "horizon-not-elapsed") {
      return unresolvedScore(prediction, report, existingScore?.attemptCount ?? 0, {
        reason: "horizon not yet elapsed",
      });
    }
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
    return unresolvedScore(prediction, report, attemptCount, resolveResult.evidence);
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
      // Resolved scores are historical records; version bumps apply only to new scoring writes.
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
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const pairsPerRun = await Promise.all(runDirs.map((runDir) => loadRunPairs(runDir)));
  const pairs = pairsPerRun.flat();

  if (pairs.length === 0) {
    return false;
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
  return true;
}
