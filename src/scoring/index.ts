import { DAY_MS } from "../config/shared";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../artifacts";
import { dataRootFromRunsDir, listRunDirNames } from "../data-paths";
import { writeAlphaPassSummaries, writeAlphaRunDirArtifacts } from "../alpha-search/post-score";
import { marketUpdateHorizonBucketOf } from "../domain/job-type";
import { type Prediction } from "../domain/prediction";
import { type ResearchReport } from "../domain/report";
import { loadRunArtifact, readReportMarketRegimeLabel, type RunArtifact } from "../run-artifacts";
import type { MalformedScoreRow } from "../run-artifact-score-reader";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { writeProviderHealthSummary } from "../health/provider-health";
import { scoringPolicyFor } from "./policy";
import { scoreForecastOrigin } from "./forecast-origin";
import { resolveOutcome } from "./resolver";
import { isPendingScore } from "./score-status";
import { readRunArtifactIndexStatus, writeThroughRunArtifactIndex } from "../run-artifact-index";
import {
  loadConditionalCalibrationCountsFromIndex,
  loadResolvedPairsFromIndex,
} from "../run-artifact-index-queries";
import { buildCalibrationSummary, forecastEventKey, type ResolvedPair } from "./calibration";
import { renderCalibrationMarkdown } from "./calibration-markdown";
import { buildMissAutopsyFile } from "./miss-autopsy";
import {
  createObservationRepository,
  type ObservationRepository,
  type FetchCloseFn,
} from "./observations";
import type {
  CalibrationSummary,
  ConditionalCalibrationSummary,
  AbandonedPredictionScore,
  MissAutopsyEntry,
  PendingPredictionScore,
  PendingScoreStatus,
  PredictionScore,
} from "./types";

const MAX_OBSERVATION_FAILURES = 4;
const OBSERVATION_RETRY_DELAYS_DAYS = [1, 3, 7] as const;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const MISS_AUTOPSY_FILE = RUN_ARTIFACT_FILES.missAutopsy;
const ZERO_CONDITIONAL_COUNTS: ConditionalCalibrationSummary = {
  activatedCount: 0,
  voidedCount: 0,
};

interface ScoreFile {
  readonly runId: string;
  readonly scores: readonly unknown[];
  readonly scoredAt: string;
}

export interface ScorePassOptions {
  readonly closeCacheDir?: string;
  readonly observationRepository?: ObservationRepository;
  readonly fetchClose?: FetchCloseFn;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly massiveApiKey?: string;
  readonly force?: boolean;
  readonly refreshProviderHealth?: (dataDir: string, now?: Date) => Promise<unknown>;
}

function unresolvedScore(
  prediction: Prediction,
  report: ResearchReport,
  attemptCount: number,
  evidence: Record<string, unknown>,
  status: PendingScoreStatus = "pending",
  nextAttemptAt?: string,
): PendingPredictionScore {
  return {
    predictionId: prediction.id,
    runId: report.runId,
    status,
    attemptCount,
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    scoringVersion: scoringPolicyFor(prediction).version,
    evidence,
  };
}

function nextObservationAttemptAt(now: Date, attemptCount: number): string {
  const delayDays = OBSERVATION_RETRY_DELAYS_DAYS[attemptCount - 1];
  if (delayDays === undefined) {
    throw new Error(`No retry delay for observation attempt ${String(attemptCount)}`);
  }
  return new Date(now.getTime() + delayDays * DAY_MS).toISOString();
}

function retryWindowElapsed(
  score: PendingPredictionScore,
  now: Date,
  force: boolean | undefined,
): boolean {
  if (force === true || score.nextAttemptAt === undefined) {
    return true;
  }
  const nextAttemptAt = Date.parse(score.nextAttemptAt);
  return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now.getTime();
}

function abandonedScore(
  prediction: Prediction,
  report: ResearchReport,
  attemptCount: number,
  now: Date,
  { withheldSessions, fetchFailures }: Record<string, unknown>,
): AbandonedPredictionScore {
  return {
    predictionId: prediction.id,
    runId: report.runId,
    status: "abandoned",
    abandonedAt: now.toISOString(),
    attemptCount,
    scoringVersion: scoringPolicyFor(prediction).version,
    evidence: {
      reason: "abandoned after fourth observation failure",
      ...(withheldSessions === undefined ? {} : { withheldSessions }),
      ...(fetchFailures === undefined ? {} : { fetchFailures }),
    },
  };
}

function observationRepositoryFor(
  report: ResearchReport,
  now: Date,
  options: ScorePassOptions,
): ObservationRepository {
  return (
    options.observationRepository ??
    createObservationRepository({
      report,
      ...(options.closeCacheDir !== undefined ? { cacheDir: options.closeCacheDir } : {}),
      ...(options.fetchClose !== undefined ? { fetchClose: options.fetchClose } : {}),
      ...(options.fredApiKey !== undefined ? { fredApiKey: options.fredApiKey } : {}),
      ...(options.tradierApiToken !== undefined
        ? { tradierApiToken: options.tradierApiToken }
        : {}),
      ...(options.massiveApiKey !== undefined ? { massiveApiKey: options.massiveApiKey } : {}),
      now,
    })
  );
}

export async function scoreOnePrediction(
  prediction: Prediction,
  report: ResearchReport,
  existingScore: PredictionScore | undefined,
  now: Date,
  options: ScorePassOptions,
): Promise<PredictionScore> {
  if (
    existingScore !== undefined &&
    isPendingScore(existingScore) &&
    existingScore.attemptCount >= MAX_OBSERVATION_FAILURES
  ) {
    return abandonedScore(
      prediction,
      report,
      existingScore.attemptCount,
      now,
      existingScore.evidence,
    );
  }

  const attemptCount = (existingScore?.attemptCount ?? 0) + 1;
  const repo = observationRepositoryFor(report, now, options);

  const resolveResult = await resolveOutcome(prediction, report, repo, now);

  if (resolveResult.status === "unresolved") {
    if (resolveResult.reason === "horizon-not-elapsed") {
      return unresolvedScore(
        prediction,
        report,
        existingScore?.attemptCount ?? 0,
        {
          reason: "horizon not yet elapsed",
        },
        resolveResult.scoreStatus ?? "pending",
      );
    }
    if (attemptCount >= MAX_OBSERVATION_FAILURES) {
      return abandonedScore(prediction, report, attemptCount, now, resolveResult.evidence);
    }
    return unresolvedScore(
      prediction,
      report,
      attemptCount,
      resolveResult.evidence,
      resolveResult.scoreStatus ?? "pending",
      nextObservationAttemptAt(now, attemptCount),
    );
  }

  const forecastOrigin =
    resolveResult.forecastOrigin === undefined
      ? {}
      : { forecastOrigin: resolveResult.forecastOrigin };

  if (resolveResult.status === "voided") {
    return {
      predictionId: prediction.id,
      runId: report.runId,
      status: "voided",
      observedAt: now.toISOString(),
      attemptCount,
      scoringVersion: scoringPolicyFor(prediction).version,
      evidence: resolveResult.evidence,
      ...forecastOrigin,
    };
  }

  return {
    predictionId: prediction.id,
    runId: report.runId,
    status: "resolved",
    outcome: resolveResult.outcome,
    observedAt: now.toISOString(),
    attemptCount,
    scoringVersion: scoringPolicyFor(prediction).version,
    evidence: resolveResult.evidence,
    ...forecastOrigin,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// An empty file replaces existing autopsies once a repaired score is no longer a miss.
export async function writeMissAutopsyRunDir(
  runDir: string,
  report: ResearchReport,
  scores: readonly PredictionScore[],
  existingAutopsies: readonly MissAutopsyEntry[],
  now: Date,
): Promise<boolean> {
  const next = buildMissAutopsyFile(report, scores, now);
  if (sameJson(existingAutopsies, next.autopsies)) {
    return false;
  }
  await writeFileAtomic(join(runDir, MISS_AUTOPSY_FILE), `${JSON.stringify(next, undefined, 2)}\n`);
  return true;
}

async function scoreRunDir(
  runDir: string,
  report: ResearchReport,
  priorScores: readonly PredictionScore[],
  malformedScores: readonly MalformedScoreRow[],
  unidentifiedRows: readonly unknown[],
  priorAutopsies: readonly MissAutopsyEntry[],
  now: Date,
  options: ScorePassOptions,
): Promise<boolean> {
  let wroteScore = false;
  let currentScores = priorScores;
  if (report.predictions.length > 0) {
    const existingScores = new Map(priorScores.map((score) => [score.predictionId, score]));
    const malformedById = new Map(malformedScores.map((row) => [row.predictionId, row]));
    const rowCountById = new Map<string, number>();
    for (const { predictionId } of [...priorScores, ...malformedScores]) {
      rowCountById.set(predictionId, (rowCountById.get(predictionId) ?? 0) + 1);
    }

    const pendingPredictions = report.predictions.filter((prediction) => {
      const malformed = malformedById.get(prediction.id);
      if (malformed !== undefined) {
        process.stderr.write(
          `score ${report.runId}/${prediction.id} is malformed (${malformed.reason}), left as written and not rescored\n`,
        );
        return false;
      }
      const rowCount = rowCountById.get(prediction.id) ?? 0;
      if (rowCount > 1) {
        process.stderr.write(
          `score ${report.runId}/${prediction.id} has ${String(rowCount)} rows, left as written and not rescored\n`,
        );
        return false;
      }
      const prev = existingScores.get(prediction.id);
      if (prev === undefined) {
        return true;
      }
      // Terminal scores are historical records; version bumps apply only to new scoring writes.
      if (!isPendingScore(prev)) {
        return false;
      }
      return (
        prev.attemptCount >= MAX_OBSERVATION_FAILURES ||
        retryWindowElapsed(prev, now, options.force)
      );
    });

    if (pendingPredictions.length > 0) {
      const newScores = await Promise.all(
        pendingPredictions.map((prediction) =>
          scoreOnePrediction(prediction, report, existingScores.get(prediction.id), now, options),
        ),
      );

      // Rescored ids have exactly one prior row, so replacing in place keeps every row's relative order.
      const newById = new Map(newScores.map((score) => [score.predictionId, score]));
      const mergedScores = [
        ...priorScores.map((score) => newById.get(score.predictionId) ?? score),
        ...newScores.filter(({ predictionId }) => !existingScores.has(predictionId)),
      ];
      const scoreFile: ScoreFile = {
        runId: report.runId,
        // Rows this pass did not rescore go back as read: orphans, duplicates, malformed, id-less (ADR 0003).
        scores: [...mergedScores, ...malformedScores.map(({ raw }) => raw), ...unidentifiedRows],
        scoredAt: now.toISOString(),
      };

      await writeFileAtomic(
        join(runDir, SCORE_FILE),
        `${JSON.stringify(scoreFile, undefined, 2)}\n`,
      );
      currentScores = mergedScores;
      wroteScore = true;
    }
  }

  const wroteAutopsy = await writeMissAutopsyRunDir(
    runDir,
    report,
    currentScores,
    priorAutopsies,
    now,
  );
  const wroteAlpha = await writeAlphaRunDirArtifacts(runDir, report, now, () =>
    observationRepositoryFor(report, now, options),
  );
  return wroteScore || wroteAutopsy || wroteAlpha;
}

async function listRunDirs(dataDir: string): Promise<readonly string[]> {
  return (await listRunDirNames(dataDir)).map((name) => join(dataDir, name));
}

export interface ScorePassResult {
  readonly scored: number;
  readonly skipped: number;
  readonly touchedRunDirs: readonly string[];
}

export async function runScorePass(
  dataDir: string,
  now: Date = new Date(),
  options: ScorePassOptions = {},
): Promise<ScorePassResult> {
  const runDirs = await listRunDirs(dataDir);

  const settled = await Promise.allSettled(
    runDirs.map(async (runDir) => {
      // Single guarded read of report + existing scores via the canonical seam (ADR 0002),
      // Replacing the prior raw `as ResearchReport`/`as ScoreFile` casts. score.json is parsed
      // Leniently; malformed score files degrade to no prior scores rather than throwing.
      const { artifact } = await loadRunArtifact(runDir);
      if (artifact === undefined) {
        return { status: "skipped" as const };
      }
      const wrote = await scoreRunDir(
        runDir,
        artifact.report,
        artifact.scores,
        artifact.malformedScores,
        artifact.unidentifiedScoreRows,
        artifact.missAutopsies,
        now,
        options,
      );
      const status = artifact.report.predictions.length > 0 || wrote ? "scored" : "skipped";
      return {
        status,
        ...(wrote ? { touchedRunDir: runDir } : {}),
      };
    }),
  );
  const failure = settled.find((result) => result.status === "rejected");
  const results = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const touchedRunDirs = results.flatMap((result) =>
    result.touchedRunDir === undefined ? [] : [result.touchedRunDir],
  );
  const indexRunDirs = failure === undefined ? touchedRunDirs : runDirs;
  if (indexRunDirs.length > 0 && readRunArtifactIndexStatus(dataDir).state === "available") {
    await writeThroughRunArtifactIndex(dataDir, indexRunDirs).catch((error: unknown) => {
      process.stderr.write(
        `Run artifact index update failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
  if (failure !== undefined) {
    throw failure.reason;
  }
  let providerHealthRefreshFailed = false;
  try {
    await (options.refreshProviderHealth ?? writeProviderHealthSummary)(dataDir, now);
  } catch (error: unknown) {
    providerHealthRefreshFailed = true;
    process.stderr.write(
      `provider-health summary refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  await writeAlphaPassSummaries(dataDir, now, providerHealthRefreshFailed);

  return {
    scored: results.filter((result) => result.status === "scored").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    touchedRunDirs,
  };
}

function pairsForArtifact(artifact: RunArtifact): readonly ResolvedPair[] {
  const { report, scores } = artifact;
  const autopsyByPrediction = new Map(
    artifact.missAutopsies.map((autopsy) => [autopsy.predictionId, autopsy]),
  );
  const marketRegimeLabel = readReportMarketRegimeLabel(report);
  return report.predictions.flatMap((prediction) => {
    const score = scores.find((sc) => sc.predictionId === prediction.id);
    if (score === undefined || score.scoringVersion !== 3 || score.status !== "resolved") {
      return [];
    }
    const missAutopsy = autopsyByPrediction.get(prediction.id);
    const marketUpdateHorizonBucket = marketUpdateHorizonBucketOf(report);
    return [
      {
        prediction,
        // Resolved here because only the report knows the earnings timing a legacy origin needs.
        score: {
          ...score,
          forecastOrigin: scoreForecastOrigin(score, prediction.measurableAs, report),
        },
        assetClass: report.assetClass,
        jobType: report.jobType,
        ...(marketUpdateHorizonBucket !== undefined ? { marketUpdateHorizonBucket } : {}),
        runId: report.runId,
        generatedAt: report.generatedAt,
        ...(missAutopsy !== undefined ? { missAutopsyCause: missAutopsy.cause } : {}),
        ...(marketRegimeLabel !== undefined ? { marketRegimeLabel } : {}),
      },
    ];
  });
}

async function loadCalibrationInputsFromDisk(dataDir: string): Promise<{
  readonly pairs: readonly ResolvedPair[];
  readonly conditionalCounts: ConditionalCalibrationSummary;
}> {
  const runDirs = await listRunDirs(dataDir);
  const loaded = await Promise.all(runDirs.map((runDir) => loadRunArtifact(runDir)));
  const pairs = loaded.flatMap(({ artifact }) =>
    artifact === undefined || artifact.report.predictions.length === 0
      ? []
      : pairsForArtifact(artifact),
  );
  const voidedEvents = new Set<string>();
  for (const { artifact } of loaded) {
    if (artifact === undefined) {
      continue;
    }
    const predictionsById = new Map(
      artifact.report.predictions.map((prediction) => [prediction.id, prediction]),
    );
    for (const score of artifact.scores) {
      const prediction = predictionsById.get(score.predictionId);
      if (
        prediction?.kind === "conditional" &&
        score.scoringVersion === 3 &&
        score.status === "voided"
      ) {
        voidedEvents.add(
          forecastEventKey(
            artifact.report.assetClass,
            prediction.measurableAs,
            artifact.report.generatedAt,
            scoreForecastOrigin(score, prediction.measurableAs, artifact.report),
          ),
        );
      }
    }
  }
  // Activated conditionals are counted from resolved pairs in
  // BuildCalibrationSummary; disk scanning only has to add excluded voids.
  return { pairs, conditionalCounts: { activatedCount: 0, voidedCount: voidedEvents.size } };
}

export async function buildAndWriteCalibration(
  dataDir: string,
  now: Date = new Date(),
): Promise<CalibrationSummary | null> {
  const indexPairs = await loadResolvedPairsFromIndex(dataDir);
  const indexConditionalCounts =
    indexPairs === undefined ? undefined : await loadConditionalCalibrationCountsFromIndex(dataDir);
  const diskInputs =
    indexPairs === undefined || indexConditionalCounts === undefined
      ? await loadCalibrationInputsFromDisk(dataDir)
      : undefined;
  const pairs = indexPairs ?? diskInputs?.pairs ?? [];
  const conditionalCounts =
    indexConditionalCounts ?? diskInputs?.conditionalCounts ?? ZERO_CONDITIONAL_COUNTS;

  const summary = buildCalibrationSummary(pairs, now, conditionalCounts);
  const calibrationDir = join(dataRootFromRunsDir(dataDir), "calibration");
  await mkdir(calibrationDir, { recursive: true });
  await writeFileAtomic(
    join(calibrationDir, "summary.json"),
    `${JSON.stringify(summary, undefined, 2)}\n`,
  );
  await writeFileAtomic(join(calibrationDir, "summary.md"), renderCalibrationMarkdown(summary));
  return summary;
}
