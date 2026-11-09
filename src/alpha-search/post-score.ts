import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../artifacts";
import { dataRootFromRunsDir, listRunDirNames } from "../data-paths";
import { isInstrumentJobType } from "../domain/job-type";
import { type ResearchReport } from "../domain/report";
import { isRecord, readNumber, readString } from "../guards";
import { loadRunArtifact } from "../run-artifacts";
import { NORMALIZED_DIR, RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import type { ObservationRepository } from "../scoring/observations";
import {
  buildAlphaCandidateProfiles,
  buildAlphaCandidateWatchlist,
  isAlphaCandidateProfile,
  renderAlphaCandidateWatchlistMarkdown,
  type AlphaCandidateProfile,
} from "./candidate-state";
import {
  buildAlphaLeadCohortSummary,
  readAlphaCandidateWatchlist,
  readAlphaRejectedCandidateFile,
  renderAlphaLeadCohortMarkdown,
} from "./cohorts";
import {
  buildAlphaFeatureAttribution,
  renderAlphaFeatureAttributionMarkdown,
} from "./feature-attribution";
import {
  buildAlphaValidationSummary,
  isAlphaValidationComplete,
  renderAlphaValidationSummaryMarkdown,
  validateAlphaSearchReport,
  type AlphaValidationPrerequisiteInput,
  type AlphaValidationFile,
} from "./validation";

const ALPHA_VALIDATION_FILE = RUN_ARTIFACT_FILES.alphaValidation;
const ALPHA_CANDIDATE_PROFILES_FILE = RUN_ARTIFACT_FILES.candidateProfiles;
const ALPHA_REJECTED_CANDIDATES_FILE = RUN_ARTIFACT_FILES.rejectedCandidates;

async function listRunDirs(dataDir: string): Promise<readonly string[]> {
  return (await listRunDirNames(dataDir)).map((name) => join(dataDir, name));
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
    const raw = await readFile(
      join(dataRootFromRunsDir(dataDir), "provider-health", "summary.json"),
      "utf8",
    );
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
  repository: () => ObservationRepository,
): Promise<boolean> {
  const existing = await loadAlphaValidationFile(runDir);
  if (isAlphaValidationComplete({ report, validation: existing })) {
    // Completed Alpha validations are unchanged historical artifacts, so this run is skipped.
    return false;
  }

  const validation = await validateAlphaSearchReport({
    report,
    repository: repository(),
    now,
    ...(existing !== undefined ? { existingValidation: existing } : {}),
  });
  if (validation === undefined) {
    return false;
  }
  await writeFileAtomic(
    join(runDir, ALPHA_VALIDATION_FILE),
    `${JSON.stringify(validation, undefined, 2)}\n`,
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
  await writeFileAtomic(
    join(runDir, ALPHA_CANDIDATE_PROFILES_FILE),
    `${JSON.stringify(profiles, undefined, 2)}\n`,
  );
  return true;
}

export async function writeAlphaRunDirArtifacts(
  runDir: string,
  report: ResearchReport,
  now: Date,
  repository: () => ObservationRepository,
): Promise<boolean> {
  const wroteProfiles = await writeAlphaCandidateProfilesRunDir(runDir, report);
  const wroteValidation = await writeAlphaValidationRunDir(runDir, report, now, repository);
  return wroteProfiles || wroteValidation;
}

export async function writeAlphaPassSummaries(
  dataDir: string,
  now: Date,
  providerHealthRefreshFailed: boolean,
): Promise<void> {
  await buildAndWriteAlphaValidationSummary(
    dataDir,
    now,
    providerHealthRefreshFailed ? { providerHealthStatus: "unavailable" } : undefined,
  );
  await buildAndWriteAlphaFeatureAttribution(dataDir, now);
  await buildAndWriteAlphaCandidateWatchlist(dataDir, now);
  await buildAndWriteAlphaLeadCohorts(dataDir, now);
}

async function loadAlphaWatchlist(dataDir: string) {
  try {
    const raw = await readFile(
      join(dataRootFromRunsDir(dataDir), "alpha-search", "watchlist.json"),
      "utf8",
    );
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
  const outputDir = join(dataRootFromRunsDir(dataDir), "alpha-search");
  await mkdir(outputDir, { recursive: true });
  await writeFileAtomic(
    join(outputDir, "cohorts.json"),
    `${JSON.stringify(cohorts, undefined, 2)}\n`,
  );
  await writeFileAtomic(join(outputDir, "cohorts.md"), renderAlphaLeadCohortMarkdown(cohorts));
  return true;
}

async function buildAndWriteAlphaCandidateWatchlist(
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
  const watchlistDir = join(dataRootFromRunsDir(dataDir), "alpha-search");
  await mkdir(watchlistDir, { recursive: true });
  await writeFileAtomic(
    join(watchlistDir, "watchlist.json"),
    `${JSON.stringify(watchlist, undefined, 2)}\n`,
  );
  await writeFileAtomic(
    join(watchlistDir, "watchlist.md"),
    renderAlphaCandidateWatchlistMarkdown(watchlist),
  );
  return true;
}

async function buildAndWriteAlphaFeatureAttribution(
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
  const outputDir = join(dataRootFromRunsDir(dataDir), "alpha-search");
  await mkdir(outputDir, { recursive: true });
  await writeFileAtomic(
    join(outputDir, "feature-attribution.json"),
    `${JSON.stringify(attribution, undefined, 2)}\n`,
  );
  await writeFileAtomic(
    join(outputDir, "feature-attribution.md"),
    renderAlphaFeatureAttributionMarkdown(attribution),
  );
  return true;
}

async function buildAndWriteAlphaValidationSummary(
  dataDir: string,
  now: Date = new Date(),
  prerequisiteOverride?: AlphaValidationPrerequisiteInput,
): Promise<boolean> {
  const runDirs = await listRunDirs(dataDir);
  const [maybeFiles, persistedPrerequisites] = await Promise.all([
    Promise.all(runDirs.map((runDir) => loadAlphaValidationFile(runDir))),
    loadAlphaValidationPrerequisites(dataDir),
  ]);
  const files = maybeFiles.filter((file): file is AlphaValidationFile => file !== undefined);
  if (files.length === 0) {
    return false;
  }

  const summary = buildAlphaValidationSummary(
    files,
    now,
    prerequisiteOverride ?? persistedPrerequisites,
  );
  const summaryDir = join(dataRootFromRunsDir(dataDir), "alpha-validation");
  await mkdir(summaryDir, { recursive: true });
  await writeFileAtomic(
    join(summaryDir, "summary.json"),
    `${JSON.stringify(summary, undefined, 2)}\n`,
  );
  await writeFileAtomic(
    join(summaryDir, "summary.md"),
    renderAlphaValidationSummaryMarkdown(summary),
  );
  return true;
}
