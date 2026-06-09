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
import { isMarketUpdateJobType, type Prediction, type ResearchReport } from "../domain/types";
import { loadRunArtifact } from "../run-artifacts";
import { isRecord, readNumber, readString } from "../sources/guards";
import { resolveOutcome } from "./resolver";
import { buildCalibrationSummary, type ResolvedPair } from "./calibration";
import { renderCalibrationMarkdown } from "./calibration-markdown";
import {
  createObservationRepository,
  type ObservationRepository,
  type FetchCloseFn,
} from "./observations";
import type { CalibrationSummary, PredictionScore } from "./types";

const MAX_SCORE_ATTEMPTS = 5;
const SCORE_FILE = "score.json";
const ALPHA_VALIDATION_FILE = "alpha-validation.json";
const ALPHA_CANDIDATE_PROFILES_FILE = "candidate-profiles.json";
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
  readonly massiveApiKey?: string;
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
  const attemptCount = (existingScore?.attemptCount ?? 0) + 1;
  const repo = observationRepositoryFor(report, now, options);

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
    const raw = await readFile(join(runDir, "normalized", ALPHA_CANDIDATE_PROFILES_FILE), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry) => isAlphaCandidateProfile(entry)) : [];
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

  const normalizedDir = join(runDir, "normalized");
  await mkdir(normalizedDir, { recursive: true });
  await writeFile(
    join(normalizedDir, ALPHA_CANDIDATE_PROFILES_FILE),
    `${JSON.stringify(profiles, undefined, 2)}\n`,
    "utf8",
  );
  return true;
}

async function scoreRunDir(
  runDir: string,
  report: ResearchReport,
  priorScores: readonly PredictionScore[],
  now: Date,
  options: ScorePassOptions,
): Promise<boolean> {
  let wroteScore = false;
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
      return prev.attemptCount < MAX_SCORE_ATTEMPTS;
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
      wroteScore = true;
    }
  }

  const wroteAlphaProfiles = await writeAlphaCandidateProfilesRunDir(runDir, report);
  const wroteAlphaValidation = await writeAlphaValidationRunDir(runDir, report, now, options);
  return wroteScore || wroteAlphaProfiles || wroteAlphaValidation;
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
      // Single guarded read of report + existing scores via the canonical seam (ADR 0016),
      // Replacing the prior raw `as ResearchReport`/`as ScoreFile` casts. score.json is parsed
      // Leniently; malformed score files degrade to no prior scores rather than throwing.
      const { artifact } = await loadRunArtifact(runDir);
      if (artifact === undefined) {
        return { status: "skipped" as const };
      }
      const wrote = await scoreRunDir(runDir, artifact.report, artifact.scores, now, options);
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

  return {
    scored: results.filter((result) => result.status === "scored").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    touchedRunDirs: results.flatMap((result) =>
      result.touchedRunDir === undefined ? [] : [result.touchedRunDir],
    ),
  };
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

async function loadRunPairs(runDir: string): Promise<readonly ResolvedPair[]> {
  const { artifact } = await loadRunArtifact(runDir);
  if (artifact === undefined || artifact.report.predictions.length === 0) {
    return [];
  }
  const { report, scores } = artifact;
  return report.predictions.flatMap((prediction) => {
    const score = scores.find((sc) => sc.predictionId === prediction.id);
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
): Promise<CalibrationSummary | null> {
  const runDirs = await listRunDirs(dataDir);
  const pairsPerRun = await Promise.all(runDirs.map((runDir) => loadRunPairs(runDir)));
  const pairs = pairsPerRun.flat();

  if (pairs.length === 0) {
    return null;
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
  return summary;
}
