import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  CalibrationDetail,
  AlphaCohortDetail,
  FailedRunArtifactFailure,
  ProviderHealthDetail,
  RunDetail,
  RunFile,
  RunSearchFilters,
  RunSearchResult,
  RunSummary,
} from "./types";
import { reportSearchCandidates } from "./report-artifact-view";
import {
  withoutUnmeasuredMarkdownMetrics,
  withoutUnmeasuredMetrics,
} from "../src/scoring/calibration-invariant";
import {
  listRunSummariesFromIndex,
  readRunSummaryFromIndex,
  searchRunReportsFromIndex,
} from "../src/run-artifact-index";
import {
  compareRunSummariesByRecency,
  runSearchResultFromCandidate,
  runSummaryFromReport,
  runSummaryMatchesFilters,
} from "../src/run-artifact-projection";
import { loadRunArtifact } from "../src/run-artifacts";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { isRecord, readNumber, readString, readStringArray } from "../src/guards";
import { normalizePredictionShortfallReport } from "../src/report/prediction-shortfall";

const REPORT_FILE = RUN_ARTIFACT_FILES.report;
const MARKDOWN_FILE = RUN_ARTIFACT_FILES.reportMarkdown;
const ANALYTICS_FILE = RUN_ARTIFACT_FILES.analytics;
const TRACE_FILE = RUN_ARTIFACT_FILES.trace;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const MISS_AUTOPSY_FILE = RUN_ARTIFACT_FILES.missAutopsy;
const FAILURE_FILE = RUN_ARTIFACT_FILES.failure;
const PROVIDER_HEALTH_DIR = "provider-health";
const CALIBRATION_DIR = "calibration";
const ALPHA_SEARCH_DIR = "alpha-search";
const SUMMARY_FILE = "summary.json";
const SUMMARY_MARKDOWN_FILE = "summary.md";
const COHORTS_FILE = "cohorts.json";
const COHORTS_MARKDOWN_FILE = "cohorts.md";
const MAX_RUN_FILE_BYTES = 5_000_000;
const MAX_SEARCH_RESULTS = 100;

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readReportRecord(path: string): Promise<Record<string, unknown> | undefined> {
  return normalizePredictionShortfallReport(await readJsonRecord(path));
}

function readEvidenceQuality(
  value: unknown,
): NonNullable<FailedRunArtifactFailure["evidenceQuality"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { checks } = value;
  const limitingReasons = readStringArray(value, "limitingReasons");
  const advisoryReasons = readStringArray(value, "advisoryReasons");
  if (
    value.version !== 1 ||
    (value.rubricVersion !== 1 && value.rubricVersion !== 2 && value.rubricVersion !== 3) ||
    (value.label !== "high" && value.label !== "medium" && value.label !== "low") ||
    !Array.isArray(checks) ||
    limitingReasons === undefined ||
    advisoryReasons === undefined
  ) {
    return undefined;
  }
  const parsedChecks: NonNullable<FailedRunArtifactFailure["evidenceQuality"]>["checks"] =
    checks.flatMap((check): NonNullable<FailedRunArtifactFailure["evidenceQuality"]>["checks"] => {
      if (!isRecord(check)) {
        return [];
      }
      const { evidenceClass } = check;
      const { coverage } = check;
      const { freshness } = check;
      const { corroboration } = check;
      if (
        typeof check.capability !== "string" ||
        (evidenceClass !== "core" &&
          evidenceClass !== "material" &&
          evidenceClass !== "supplemental") ||
        (coverage !== "pass" && coverage !== "fail") ||
        (freshness !== "pass" && freshness !== "fail" && freshness !== "not-applicable") ||
        (corroboration !== "pass" &&
          corroboration !== "fail" &&
          corroboration !== "not-applicable") ||
        typeof check.passed !== "boolean"
      ) {
        return [];
      }
      const reasons = readStringArray(check, "reasons");
      return reasons === undefined
        ? []
        : [
            {
              capability: check.capability,
              evidenceClass,
              coverage,
              freshness,
              corroboration,
              passed: check.passed,
              reasons,
            },
          ];
    });
  return parsedChecks.length !== checks.length
    ? undefined
    : {
        version: 1,
        rubricVersion: value.rubricVersion,
        label: value.label,
        checks: parsedChecks,
        limitingReasons,
        advisoryReasons,
      };
}

async function readFailedRunArtifactFailure(
  path: string,
): Promise<FailedRunArtifactFailure | undefined> {
  const value = await readJsonRecord(path);
  if (value === undefined) {
    return undefined;
  }
  const generatedAt = readString(value, "generatedAt");
  const failedAt = readString(value, "failedAt");
  const message = readString(value, "message");
  const reportValidationErrors = readStringArray(value, "reportValidationErrors");
  const predictionErrors = readStringArray(value, "predictionErrors");
  const totalCalls = readNumber(value, "totalCalls");
  const reportRepairReprompts = readNumber(value, "reportRepairReprompts");
  const evidenceQuality = readEvidenceQuality(value.evidenceQuality);
  const cost = isRecord(value.cost) ? value.cost : undefined;
  const tokenEstimate = cost === undefined ? undefined : readNumber(cost, "tokenEstimate");
  const costEstimateUsd = cost === undefined ? undefined : readNumber(cost, "costEstimateUsd");
  const rawLanguageViolations = value.languageViolations;
  const languageViolations = Array.isArray(rawLanguageViolations)
    ? rawLanguageViolations.flatMap((violation) =>
        isRecord(violation) &&
        typeof violation.field === "string" &&
        typeof violation.match === "string"
          ? [{ field: violation.field, match: violation.match }]
          : [],
      )
    : undefined;
  const parsedLanguageViolations =
    languageViolations !== undefined &&
    languageViolations.length ===
      (Array.isArray(rawLanguageViolations) ? rawLanguageViolations.length : -1)
      ? languageViolations
      : undefined;
  const parsedCost =
    tokenEstimate === undefined && costEstimateUsd === undefined
      ? undefined
      : {
          ...(tokenEstimate === undefined ? {} : { tokenEstimate }),
          ...(costEstimateUsd === undefined ? {} : { costEstimateUsd }),
        };
  if (
    message === undefined &&
    reportValidationErrors === undefined &&
    predictionErrors === undefined &&
    totalCalls === undefined &&
    reportRepairReprompts === undefined &&
    parsedLanguageViolations === undefined &&
    evidenceQuality === undefined &&
    parsedCost === undefined
  ) {
    return undefined;
  }
  return {
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(message === undefined ? {} : { message }),
    ...(reportValidationErrors === undefined ? {} : { reportValidationErrors }),
    ...(predictionErrors === undefined ? {} : { predictionErrors }),
    ...(totalCalls === undefined ? {} : { totalCalls }),
    ...(reportRepairReprompts === undefined ? {} : { reportRepairReprompts }),
    ...(parsedLanguageViolations === undefined
      ? {}
      : { languageViolations: parsedLanguageViolations }),
    ...(evidenceQuality === undefined ? {} : { evidenceQuality }),
    ...(parsedCost === undefined ? {} : { cost: parsedCost }),
  };
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readLimitedText(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size <= maxBytes
      ? await readFile(path, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

function isWithinDirectory(root: string, path: string): boolean {
  const childPath = relative(root, path);
  return childPath === "" || (!childPath.startsWith("..") && !isAbsolute(childPath));
}

function dataRootFromRunsDir(dataDir: string): string {
  return basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
}

function safeRunDir(dataDir: string, runId: string): string | undefined {
  if (
    runId === "" ||
    runId === "." ||
    runId === ".." ||
    runId.includes("/") ||
    runId.includes("\\")
  ) {
    return undefined;
  }

  const root = resolve(dataDir);
  const candidate = resolve(root, runId);
  return isWithinDirectory(root, candidate) ? candidate : undefined;
}

function safeRunFilePath(
  dataDir: string,
  runId: string,
  requestedPath: string,
): { readonly filePath: string; readonly relativePath: string } | undefined {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir) || requestedPath.trim() === "") {
    return undefined;
  }

  const normalizedPath = normalize(requestedPath).replace(/^([/\\])+/u, "");
  if (normalizedPath === "." || normalizedPath.split(/[\\/]/u).includes("..")) {
    return undefined;
  }

  const filePath = resolve(runDir, normalizedPath);
  return isWithinDirectory(runDir, filePath)
    ? { filePath, relativePath: normalizedPath.replaceAll("\\", "/") }
    : undefined;
}

async function listArtifactFiles(runDir: string): Promise<readonly string[]> {
  const files: string[] = [];

  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const childVisits: Promise<void>[] = [];

    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        childVisits.push(visit(fullPath, relativePath));
        continue;
      }

      if (entry.isFile()) {
        files.push(relativePath);
      }
    }

    await Promise.all(childVisits);
  }

  await visit(runDir, "");
  return files.toSorted((left, right) => left.localeCompare(right));
}

async function searchRun(
  dataDir: string,
  runId: string,
  filters: RunSearchFilters,
): Promise<readonly RunSearchResult[]> {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir)) {
    return [];
  }

  const [report, availableFiles] = await Promise.all([
    readReportRecord(join(runDir, REPORT_FILE)),
    listArtifactFiles(runDir),
  ]);
  if (report === undefined) {
    return [];
  }

  const summary = runSummaryFromReport(runId, report, availableFiles);
  if (!runSummaryMatchesFilters(summary, filters)) {
    return [];
  }

  const normalizedQuery = filters.query.trim().toLowerCase();
  return reportSearchCandidates(report, "console")
    .filter((candidate) => candidate.text.toLowerCase().includes(normalizedQuery))
    .map((candidate) => runSearchResultFromCandidate(summary, candidate, normalizedQuery));
}

async function runSummaryFromDir(dataDir: string, runId: string): Promise<RunSummary | undefined> {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir)) {
    return undefined;
  }

  const [report, availableFiles] = await Promise.all([
    readReportRecord(join(runDir, REPORT_FILE)),
    listArtifactFiles(runDir),
  ]);

  return runSummaryFromReport(runId, report, availableFiles);
}

export async function listRunSummaries(dataDir: string): Promise<readonly RunSummary[]> {
  const indexed = await listRunSummariesFromIndex(dataDir);
  if (indexed !== undefined) {
    return indexed;
  }

  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => runSummaryFromDir(dataDir, entry.name)),
  );

  return summaries
    .filter((summary): summary is RunSummary => summary !== undefined)
    .toSorted(compareRunSummariesByRecency);
}

export async function searchRunReports(
  dataDir: string,
  filters: RunSearchFilters,
  limit: number = MAX_SEARCH_RESULTS,
): Promise<readonly RunSearchResult[]> {
  const query = filters.query.trim();
  if (query === "" || limit <= 0) {
    return [];
  }

  const indexed = await searchRunReportsFromIndex(dataDir, { ...filters, query }, limit);
  if (indexed !== undefined) {
    return indexed;
  }

  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const runResults = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => searchRun(dataDir, entry.name, { ...filters, query })),
  );
  const results = runResults.flat();

  return results
    .toSorted((left, right) => compareRunSummariesByRecency(left.run, right.run))
    .slice(0, limit);
}

export async function readRunDetail(
  dataDir: string,
  runId: string,
): Promise<RunDetail | undefined> {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir)) {
    return undefined;
  }

  const [report, failure, markdown, analytics, trace, score, missAutopsy, indexedSummary] =
    await Promise.all([
      readReportRecord(join(runDir, REPORT_FILE)),
      readFailedRunArtifactFailure(join(runDir, FAILURE_FILE)),
      readOptionalText(join(runDir, MARKDOWN_FILE)),
      readJsonRecord(join(runDir, ANALYTICS_FILE)),
      readJsonRecord(join(runDir, TRACE_FILE)),
      readJsonRecord(join(runDir, SCORE_FILE)),
      readJsonRecord(join(runDir, MISS_AUTOPSY_FILE)),
      readRunSummaryFromIndex(dataDir, runId),
    ]);
  const artifact = await loadRunArtifact(runDir);
  const availableFiles = indexedSummary?.availableFiles ?? (await listArtifactFiles(runDir));
  let detailReport = report;
  if (artifact.artifact?.report !== undefined) {
    detailReport = { ...artifact.artifact.report };
  }

  return {
    summary: indexedSummary ?? runSummaryFromReport(runId, report, availableFiles),
    ...(failure !== undefined ? { failure } : {}),
    ...(detailReport !== undefined ? { report: detailReport } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(analytics !== undefined ? { analytics } : {}),
    ...(trace !== undefined ? { trace } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(missAutopsy !== undefined ? { missAutopsy } : {}),
    ...(artifact.artifact !== undefined
      ? { marketSnapshots: artifact.artifact.marketSnapshots }
      : {}),
    ...(artifact.artifact !== undefined ? { sourceGaps: artifact.artifact.sourceGaps } : {}),
    ...(artifact.artifact?.verifiedMarketSnapshot !== undefined
      ? { verifiedMarketSnapshot: artifact.artifact.verifiedMarketSnapshot }
      : {}),
    ...(artifact.artifact?.financialLenses !== undefined
      ? { financialLenses: artifact.artifact.financialLenses }
      : {}),
    ...(artifact.artifact?.financialStatements !== undefined
      ? { financialStatements: artifact.artifact.financialStatements }
      : {}),
    ...(artifact.artifact?.subsequentFinancing !== undefined
      ? { subsequentFinancing: artifact.artifact.subsequentFinancing }
      : {}),
    ...(artifact.artifact?.peerImpliedRange !== undefined
      ? { peerImpliedRange: artifact.artifact.peerImpliedRange }
      : {}),
    ...(artifact.artifact?.valuationWorkbench !== undefined
      ? { valuationWorkbench: artifact.artifact.valuationWorkbench }
      : {}),
    ...(artifact.artifact?.reverseDcf !== undefined
      ? { reverseDcf: artifact.artifact.reverseDcf }
      : {}),
    ...(artifact.artifact?.fundamentalHistory !== undefined
      ? { fundamentalHistory: artifact.artifact.fundamentalHistory }
      : {}),
    ...(artifact.artifact?.businessFramework !== undefined
      ? { businessFramework: artifact.artifact.businessFramework }
      : {}),
    ...(artifact.artifact?.webSubjectProfile !== undefined
      ? { webSubjectProfile: artifact.artifact.webSubjectProfile }
      : {}),
  };
}

export async function readRunFile(
  dataDir: string,
  runId: string,
  requestedPath: string,
): Promise<RunFile | undefined> {
  const safePath = safeRunFilePath(dataDir, runId, requestedPath);
  if (safePath === undefined || !existsSync(safePath.filePath)) {
    return undefined;
  }

  const content = await readLimitedText(safePath.filePath, MAX_RUN_FILE_BYTES);
  return content === undefined ? undefined : { path: safePath.relativePath, content };
}

export async function readProviderHealth(dataDir: string): Promise<ProviderHealthDetail> {
  return readSummaryArtifacts(dataDir, PROVIDER_HEALTH_DIR);
}

export async function readCalibrationSummary(dataDir: string): Promise<CalibrationDetail> {
  const { summary, markdown } = await readSummaryArtifacts(dataDir, CALIBRATION_DIR);
  if (summary === undefined) {
    return markdown === undefined ? {} : { markdown };
  }
  // Zero-resolution invariant, enforced on read: a summary stored before the
  // Producer omitted these still serves hitRate 0 and brierScore 0, and its
  // Markdown still prints 0.0000 / 0.0%. Neither reaches the Console.
  const normalized = withoutUnmeasuredMetrics(summary);
  return {
    summary: normalized,
    ...(markdown === undefined
      ? {}
      : { markdown: withoutUnmeasuredMarkdownMetrics(markdown, summary.resolvedCount) }),
  };
}

export async function readAlphaLeadCohorts(dataDir: string): Promise<AlphaCohortDetail> {
  const summaryDir = join(dataRootFromRunsDir(dataDir), ALPHA_SEARCH_DIR);
  const [summary, markdown] = await Promise.all([
    readJsonRecord(join(summaryDir, COHORTS_FILE)),
    readOptionalText(join(summaryDir, COHORTS_MARKDOWN_FILE)),
  ]);

  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
  };
}

async function readSummaryArtifacts(
  dataDir: string,
  artifactDir: string,
): Promise<{ summary?: Record<string, unknown>; markdown?: string }> {
  const summaryDir = join(dataRootFromRunsDir(dataDir), artifactDir);
  const [summary, markdown] = await Promise.all([
    readJsonRecord(join(summaryDir, SUMMARY_FILE)),
    readOptionalText(join(summaryDir, SUMMARY_MARKDOWN_FILE)),
  ]);

  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
  };
}
