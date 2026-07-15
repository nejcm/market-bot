import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildAlphaCandidateProfiles,
  buildAlphaCandidateWatchlist,
  isAlphaCandidateProfile,
  renderAlphaCandidateWatchlistMarkdown,
  type AlphaCandidateProfile,
} from "../alpha-search/candidate-state";
import {
  buildAlphaLeadCohortSummary,
  readAlphaCandidateWatchlist,
  readAlphaRejectedCandidateFile,
  renderAlphaLeadCohortMarkdown,
} from "../alpha-search/cohorts";
import {
  buildAlphaFeatureAttribution,
  renderAlphaFeatureAttributionMarkdown,
} from "../alpha-search/feature-attribution";
import {
  buildAlphaValidationSummary,
  isAlphaValidationComplete,
  renderAlphaValidationSummaryMarkdown,
  validateAlphaSearchReport,
  type AlphaValidationPrerequisiteInput,
  type AlphaValidationFile,
} from "../alpha-search/validation";
import {
  isInstrumentJobType,
  marketUpdateHorizonBucketOf,
  type Prediction,
  type ResearchReport,
} from "../domain/types";
import { loadRunArtifact, readReportMarketRegimeLabel, type RunArtifact } from "../run-artifacts";
import { NORMALIZED_DIR, RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { isRecord, readNumber, readString } from "../guards";
import { scoringPolicyFor } from "./policy";
import { resolveOutcome } from "./resolver";
import {
  loadConditionalCalibrationCountsFromIndex,
  loadResolvedPairsFromIndex,
} from "../run-artifact-index";
import { buildCalibrationSummary, type ResolvedPair } from "./calibration";
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
  MissAutopsyEntry,
  PredictionScore,
} from "./types";

const MAX_OBSERVATION_FAILURES = 4;
const OBSERVATION_RETRY_DELAYS_DAYS = [1, 3, 7] as const;
const DAY_MS = 86_400_000;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const MISS_AUTOPSY_FILE = RUN_ARTIFACT_FILES.missAutopsy;
const ALPHA_VALIDATION_FILE = RUN_ARTIFACT_FILES.alphaValidation;
const ALPHA_CANDIDATE_PROFILES_FILE = RUN_ARTIFACT_FILES.candidateProfiles;
const ALPHA_REJECTED_CANDIDATES_FILE = RUN_ARTIFACT_FILES.rejectedCandidates;
const ZERO_CONDITIONAL_COUNTS: ConditionalCalibrationSummary = {
  activatedCount: 0,
  voidedCount: 0,
};

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
  readonly massiveApiKey?: string;
  readonly force?: boolean;
}

function unresolvedScore(
  prediction: Prediction,
  report: ResearchReport,
  attemptCount: number,
  evidence: Record<string, unknown>,
  status: PredictionScore["status"] = "pending",
  nextAttemptAt?: string,
): PredictionScore {
  return {
    predictionId: prediction.id,
    runId: report.runId,
    status,
    resolved: false,
    outcome: undefined,
    observedAt: undefined,
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
  score: PredictionScore,
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
): PredictionScore {
  return {
    predictionId: prediction.id,
    runId: report.runId,
    status: "abandoned",
    resolved: true,
    outcome: undefined,
    observedAt: now.toISOString(),
    attemptCount,
    scoringVersion: scoringPolicyFor(prediction).version,
    evidence: { reason: "abandoned after fourth observation failure" },
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

async function scoreOnePrediction(
  prediction: Prediction,
  report: ResearchReport,
  existingScore: PredictionScore | undefined,
  now: Date,
  options: ScorePassOptions,
): Promise<PredictionScore> {
  if (
    existingScore !== undefined &&
    !existingScore.resolved &&
    existingScore.attemptCount >= MAX_OBSERVATION_FAILURES
  ) {
    return abandonedScore(prediction, report, existingScore.attemptCount, now);
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
      return abandonedScore(prediction, report, attemptCount, now);
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

  if (resolveResult.status === "voided") {
    return {
      predictionId: prediction.id,
      runId: report.runId,
      status: "voided",
      resolved: true,
      outcome: undefined,
      observedAt: now.toISOString(),
      attemptCount,
      scoringVersion: scoringPolicyFor(prediction).version,
      evidence: resolveResult.evidence,
    };
  }

  return {
    predictionId: prediction.id,
    runId: report.runId,
    status: "resolved",
    resolved: true,
    outcome: resolveResult.outcome,
    observedAt: now.toISOString(),
    attemptCount,
    scoringVersion: scoringPolicyFor(prediction).version,
    evidence: resolveResult.evidence,
  };
}

async function loadAlphaValidationFile(runDir: string): Promise<AlphaValidationFile | undefined> {
  try {
    const raw = await readFile(join(runDir, ALPHA_VALIDATION_FILE), "utf8");
    return JSON.parse(raw) as AlphaValidationFile;
  } catch {
    return undefined;
  }
}

async function loadAlphaCandidateProfiles(
  runDir: string,
): Promise<readonly AlphaCandidateProfile[]> {
  try {
    const raw = await readFile(join(runDir, ALPHA_CANDIDATE_PROFILES_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry) => isAlphaCandidateProfile(entry)) : [];
  } catch {
    return [];
  }
}

async function loadAlphaRejectedCandidates(runDir: string) {
  try {
    const raw = await readFile(join(runDir, ALPHA_REJECTED_CANDIDATES_FILE), "utf8");
    return readAlphaRejectedCandidateFile(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

async function loadAlphaValidationPrerequisites(
  dataDir: string,
): Promise<AlphaValidationPrerequisiteInput | undefined> {
  try {
    const raw = await readFile(join(dataDir, "../provider-health", "summary.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.validation)) {
      return;
    }
    const { validation } = parsed;
    const status = readString(validation, "status");
    const blockingIssueCount = readNumber(validation, "blockingIssueCount");
    const { requiredCoverage } = validation;
    const unmetRequiredCoverage = Array.isArray(requiredCoverage)
      ? requiredCoverage.flatMap((item) => {
          if (!isRecord(item) || item.met === true) {
            return [];
          }
          const key = readString(item, "key");
          return key === undefined ? [] : [key];
        })
      : [];
    return {
      ...(status === "pass" || status === "warn" || status === "fail"
        ? { providerHealthStatus: status }
        : {}),
      ...(blockingIssueCount !== undefined ? { blockingIssueCount } : {}),
      unmetRequiredCoverage,
    };
  } catch {}
}

async function writeAlphaValidationRunDir(
  runDir: string,
  report: ResearchReport,
  now: Date,
  options: ScorePassOptions,
): Promise<boolean> {
  const existing = await loadAlphaValidationFile(runDir);
  if (isAlphaValidationComplete({ report, validation: existing })) {
    // Completed Alpha validations are unchanged historical artifacts, so this run is skipped.
    return false;
  }

  const validation = await validateAlphaSearchReport({
    report,
    repository: observationRepositoryFor(report, now, options),
    now,
    ...(existing !== undefined ? { existingValidation: existing } : {}),
  });
  if (validation === undefined) {
    return false;
  }
  await writeFile(
    join(runDir, ALPHA_VALIDATION_FILE),
    `${JSON.stringify(validation, undefined, 2)}\n`,
    "utf8",
  );
  return true;
}

async function writeAlphaCandidateProfilesRunDir(
  runDir: string,
  report: ResearchReport,
): Promise<boolean> {
  const profiles = buildAlphaCandidateProfiles(report);
  if (profiles.length === 0) {
    return false;
  }

  const existingProfiles = await loadAlphaCandidateProfiles(runDir);
  if (existingProfiles.length > 0) {
    return false;
  }

  await mkdir(join(runDir, NORMALIZED_DIR), { recursive: true });
  await writeFile(
    join(runDir, ALPHA_CANDIDATE_PROFILES_FILE),
    `${JSON.stringify(profiles, undefined, 2)}\n`,
    "utf8",
  );
  return true;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function writeMissAutopsyRunDir(
  runDir: string,
  report: ResearchReport,
  scores: readonly PredictionScore[],
  existingAutopsies: readonly MissAutopsyEntry[],
  now: Date,
): Promise<boolean> {
  const next = buildMissAutopsyFile(report, scores, now);
  if (next.autopsies.length === 0) {
    return false;
  }
  if (sameJson(existingAutopsies, next.autopsies)) {
    return false;
  }
  await writeFile(
    join(runDir, MISS_AUTOPSY_FILE),
    `${JSON.stringify(next, undefined, 2)}\n`,
    "utf8",
  );
  return true;
}

async function scoreRunDir(
  runDir: string,
  report: ResearchReport,
  priorScores: readonly PredictionScore[],
  priorAutopsies: readonly MissAutopsyEntry[],
  now: Date,
  options: ScorePassOptions,
): Promise<boolean> {
  let wroteScore = false;
  let currentScores = priorScores;
  if (report.predictions.length > 0) {
    const existingScores = new Map(priorScores.map((score) => [score.predictionId, score]));

    const pendingPredictions = report.predictions.filter((prediction) => {
      const prev = existingScores.get(prediction.id);
      if (prev === undefined) {
        return true;
      }
      if (prev.resolved) {
        // Resolved scores are historical records; version bumps apply only to new scoring writes.
        return false;
      }
      if (prev.attemptCount >= MAX_OBSERVATION_FAILURES) {
        return true;
      }
      return (
        prev.attemptCount < MAX_OBSERVATION_FAILURES && retryWindowElapsed(prev, now, options.force)
      );
    });

    if (pendingPredictions.length > 0) {
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

      await writeFile(
        join(runDir, SCORE_FILE),
        `${JSON.stringify(scoreFile, undefined, 2)}\n`,
        "utf8",
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
  const wroteAlphaProfiles = await writeAlphaCandidateProfilesRunDir(runDir, report);
  const wroteAlphaValidation = await writeAlphaValidationRunDir(runDir, report, now, options);
  return wroteScore || wroteAutopsy || wroteAlphaProfiles || wroteAlphaValidation;
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
  readonly touchedRunDirs: readonly string[];
}

export async function runScorePass(
  dataDir: string,
  now: Date = new Date(),
  options: ScorePassOptions = {},
): Promise<ScorePassResult> {
  const runDirs = await listRunDirs(dataDir);

  const results = await Promise.all(
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
  await buildAndWriteAlphaValidationSummary(dataDir, now);
  await buildAndWriteAlphaFeatureAttribution(dataDir, now);
  await buildAndWriteAlphaCandidateWatchlist(dataDir, now);
  await buildAndWriteAlphaLeadCohorts(dataDir, now);

  return {
    scored: results.filter((result) => result.status === "scored").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    touchedRunDirs: results.flatMap((result) =>
      result.touchedRunDir === undefined ? [] : [result.touchedRunDir],
    ),
  };
}

async function loadAlphaWatchlist(dataDir: string) {
  try {
    const raw = await readFile(join(dataDir, "../alpha-search", "watchlist.json"), "utf8");
    const watchlist = readAlphaCandidateWatchlist(JSON.parse(raw) as unknown);
    if (watchlist === undefined) {
      throw new Error("Alpha candidate watchlist is invalid");
    }
    return watchlist;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function buildAndWriteAlphaLeadCohorts(
  dataDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const [rejectedPerRun, maybeValidations, watchlist, loadedRuns] = await Promise.all([
    Promise.all(runDirs.map((runDir) => loadAlphaRejectedCandidates(runDir))),
    Promise.all(runDirs.map((runDir) => loadAlphaValidationFile(runDir))),
    loadAlphaWatchlist(dataDir),
    Promise.all(runDirs.map((runDir) => loadRunArtifact(runDir))),
  ]);
  const rejectedCandidates = rejectedPerRun.flat();
  const validations = maybeValidations.filter(
    (file): file is AlphaValidationFile => file !== undefined,
  );
  if (rejectedCandidates.length === 0 && validations.length === 0 && watchlist === undefined) {
    return false;
  }

  const tickerBriefSymbols = new Set(
    loadedRuns.flatMap(({ artifact }) =>
      isInstrumentJobType(artifact?.report.jobType) && artifact.report.symbol !== undefined
        ? [artifact.report.symbol.toUpperCase()]
        : [],
    ),
  );
  const cohorts = buildAlphaLeadCohortSummary({
    rejectedCandidates,
    validations,
    ...(watchlist !== undefined ? { watchlist } : {}),
    tickerBriefSymbols,
    now,
  });
  const outputDir = join(dataDir, "../alpha-search");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "cohorts.json"),
    `${JSON.stringify(cohorts, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(join(outputDir, "cohorts.md"), renderAlphaLeadCohortMarkdown(cohorts), "utf8");
  return true;
}

export async function buildAndWriteAlphaCandidateWatchlist(
  dataDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const [profilesPerRun, maybeValidations] = await Promise.all([
    Promise.all(runDirs.map((runDir) => loadAlphaCandidateProfiles(runDir))),
    Promise.all(runDirs.map((runDir) => loadAlphaValidationFile(runDir))),
  ]);
  const profiles = profilesPerRun.flat();
  if (profiles.length === 0) {
    return false;
  }

  const validations = maybeValidations.filter(
    (file): file is AlphaValidationFile => file !== undefined,
  );
  const watchlist = buildAlphaCandidateWatchlist({ profiles, validations, now });
  const watchlistDir = join(dataDir, "../alpha-search");
  await mkdir(watchlistDir, { recursive: true });
  await writeFile(
    join(watchlistDir, "watchlist.json"),
    `${JSON.stringify(watchlist, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(watchlistDir, "watchlist.md"),
    renderAlphaCandidateWatchlistMarkdown(watchlist),
    "utf8",
  );
  return true;
}

export async function buildAndWriteAlphaFeatureAttribution(
  dataDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const [profilesPerRun, maybeValidations] = await Promise.all([
    Promise.all(runDirs.map((runDir) => loadAlphaCandidateProfiles(runDir))),
    Promise.all(runDirs.map((runDir) => loadAlphaValidationFile(runDir))),
  ]);
  const profiles = profilesPerRun.flat();
  const validations = maybeValidations.filter(
    (file): file is AlphaValidationFile => file !== undefined,
  );
  if (profiles.length === 0 || validations.length === 0) {
    return false;
  }

  const attribution = buildAlphaFeatureAttribution({ profiles, validations, now });
  const outputDir = join(dataDir, "../alpha-search");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "feature-attribution.json"),
    `${JSON.stringify(attribution, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outputDir, "feature-attribution.md"),
    renderAlphaFeatureAttributionMarkdown(attribution),
    "utf8",
  );
  return true;
}

export async function buildAndWriteAlphaValidationSummary(
  dataDir: string,
  now: Date = new Date(),
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const [maybeFiles, prerequisites] = await Promise.all([
    Promise.all(runDirs.map((runDir) => loadAlphaValidationFile(runDir))),
    loadAlphaValidationPrerequisites(dataDir),
  ]);
  const files = maybeFiles.filter((file): file is AlphaValidationFile => file !== undefined);
  if (files.length === 0) {
    return false;
  }

  const summary = buildAlphaValidationSummary(files, now, prerequisites);
  const summaryDir = join(dataDir, "../alpha-validation");
  await mkdir(summaryDir, { recursive: true });
  await writeFile(
    join(summaryDir, "summary.json"),
    `${JSON.stringify(summary, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(summaryDir, "summary.md"),
    renderAlphaValidationSummaryMarkdown(summary),
    "utf8",
  );
  return true;
}

function pairsForArtifact(artifact: RunArtifact): readonly ResolvedPair[] {
  const { report, scores } = artifact;
  const autopsyByPrediction = new Map(
    artifact.missAutopsies.map((autopsy) => [autopsy.predictionId, autopsy]),
  );
  const marketRegimeLabel = readReportMarketRegimeLabel(report);
  return report.predictions.flatMap((prediction) => {
    const score = scores.find((sc) => sc.predictionId === prediction.id);
    if (
      score === undefined ||
      score.scoringVersion !== 3 ||
      !score.resolved ||
      score.outcome === undefined
    ) {
      return [];
    }
    const missAutopsy = autopsyByPrediction.get(prediction.id);
    const marketUpdateHorizonBucket = marketUpdateHorizonBucketOf(report);
    return [
      {
        prediction,
        score,
        assetClass: report.assetClass,
        jobType: report.jobType,
        ...(marketUpdateHorizonBucket !== undefined ? { marketUpdateHorizonBucket } : {}),
        runId: report.runId,
        ...(missAutopsy !== undefined ? { missAutopsy } : {}),
        ...(marketRegimeLabel !== undefined ? { marketRegimeLabel } : {}),
      },
    ];
  });
}

async function loadMissAutopsiesByPrediction(
  dataDir: string,
): Promise<ReadonlyMap<string, MissAutopsyEntry>> {
  const runDirs = await listRunDirs(dataDir);
  const loaded = await Promise.all(runDirs.map((runDir) => loadRunArtifact(runDir)));
  return new Map(
    loaded.flatMap(({ artifact }) =>
      artifact === undefined
        ? []
        : artifact.missAutopsies.map(
            (autopsy) => [`${artifact.report.runId}:${autopsy.predictionId}`, autopsy] as const,
          ),
    ),
  );
}

// Even on a warm index this re-reads every run directory from disk to recover
// Miss autopsies, which the index does not yet hydrate. TODO: store the autopsy
// Cause in the index row so loadResolvedPairsFromIndex can join it without a scan.
async function withMissAutopsiesFromDisk(
  dataDir: string,
  pairs: readonly ResolvedPair[],
): Promise<readonly ResolvedPair[]> {
  const autopsies = await loadMissAutopsiesByPrediction(dataDir);
  return pairs.map((pair) => {
    const missAutopsy = autopsies.get(`${pair.runId}:${pair.prediction.id}`);
    return missAutopsy === undefined ? pair : { ...pair, missAutopsy };
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
  let voidedCount = 0;
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
        voidedCount += 1;
      }
    }
  }
  // Activated conditionals are counted from resolved pairs in
  // BuildCalibrationSummary; disk scanning only has to add excluded voids.
  return { pairs, conditionalCounts: { activatedCount: 0, voidedCount } };
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
  const pairs =
    indexPairs === undefined
      ? (diskInputs?.pairs ?? [])
      : await withMissAutopsiesFromDisk(dataDir, indexPairs);
  const conditionalCounts =
    indexConditionalCounts ?? diskInputs?.conditionalCounts ?? ZERO_CONDITIONAL_COUNTS;

  const summary = buildCalibrationSummary(pairs, now, conditionalCounts);
  const calibrationDir = join(dataDir, "../calibration");
  await mkdir(calibrationDir, { recursive: true });
  await writeFile(
    join(calibrationDir, "summary.json"),
    `${JSON.stringify(summary, undefined, 2)}\n`,
    "utf8",
  );
  await writeFile(join(calibrationDir, "summary.md"), renderCalibrationMarkdown(summary), "utf8");
  return summary;
}
