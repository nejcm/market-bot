import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type {
  ProviderHealthDetail,
  RunDetail,
  RunFile,
  RunSearchFilters,
  RunSearchResult,
  RunSummary,
} from "./types";
import { reportSearchCandidates } from "./report-artifact-view";

const REPORT_FILE = "report.json";
const MARKDOWN_FILE = "report.md";
const ANALYTICS_FILE = "analytics.json";
const TRACE_FILE = "trace.json";
const SCORE_FILE = "score.json";
const PROVIDER_HEALTH_DIR = "provider-health";
const SUMMARY_FILE = "summary.json";
const SUMMARY_MARKDOWN_FILE = "summary.md";
const MAX_RUN_FILE_BYTES = 5_000_000;
const MAX_SEARCH_RESULTS = 100;
const SNIPPET_RADIUS = 72;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function arrayCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
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

function readDepth(report: Record<string, unknown>): string | undefined {
  const { extras } = report;
  return isRecord(extras) ? readString(extras, "depth") : undefined;
}

function runSummary(
  runId: string,
  report: Record<string, unknown> | undefined,
  availableFiles: readonly string[],
): RunSummary {
  const generatedAt = report === undefined ? undefined : readString(report, "generatedAt");
  const jobType = report === undefined ? undefined : readString(report, "jobType");
  const assetClass = report === undefined ? undefined : readString(report, "assetClass");
  const symbol = report === undefined ? undefined : readString(report, "symbol");
  const depth = report === undefined ? undefined : readDepth(report);
  const confidence = report === undefined ? undefined : readString(report, "confidence");

  return {
    runId: readString(report ?? {}, "runId") ?? runId,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(jobType !== undefined ? { jobType } : {}),
    ...(assetClass !== undefined ? { assetClass } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    findingCount: report === undefined ? 0 : arrayCount(report, "keyFindings"),
    predictionCount: report === undefined ? 0 : arrayCount(report, "predictions"),
    sourceCount: report === undefined ? 0 : arrayCount(report, "sources"),
    dataGapCount: report === undefined ? 0 : arrayCount(report, "dataGaps"),
    hasScore: availableFiles.includes(SCORE_FILE),
    availableFiles,
  };
}

function reportMatchesFilters(
  summary: RunSummary,
  filters: Omit<RunSearchFilters, "query">,
): boolean {
  const symbol = filters.symbol?.trim().toLowerCase();
  const assetClass = filters.assetClass?.trim().toLowerCase();
  const jobType = filters.jobType?.trim().toLowerCase();
  const generatedDate = summary.generatedAt?.slice(0, 10) ?? "";

  if (symbol !== undefined && symbol !== "" && summary.symbol?.toLowerCase() !== symbol) {
    return false;
  }

  if (
    assetClass !== undefined &&
    assetClass !== "" &&
    summary.assetClass?.toLowerCase() !== assetClass
  ) {
    return false;
  }

  if (jobType !== undefined && jobType !== "" && summary.jobType?.toLowerCase() !== jobType) {
    return false;
  }

  if ((filters.from !== undefined || filters.to !== undefined) && generatedDate === "") {
    return false;
  }

  if (filters.from !== undefined && generatedDate < filters.from.slice(0, 10)) {
    return false;
  }

  if (filters.to !== undefined && generatedDate > filters.to.slice(0, 10)) {
    return false;
  }

  return true;
}

function textSnippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + query.length + SNIPPET_RADIUS);
  const prefix = start === 0 ? "" : "...";
  const suffix = end === text.length ? "" : "...";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
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
    readJsonRecord(join(runDir, REPORT_FILE)),
    listArtifactFiles(runDir),
  ]);
  if (report === undefined) {
    return [];
  }

  const summary = runSummary(runId, report, availableFiles);
  if (!reportMatchesFilters(summary, filters)) {
    return [];
  }

  const normalizedQuery = filters.query.trim().toLowerCase();
  return reportSearchCandidates(report)
    .filter((candidate) => candidate.text.toLowerCase().includes(normalizedQuery))
    .map((candidate) => ({
      run: summary,
      section: candidate.section,
      label: candidate.label,
      snippet: textSnippet(candidate.text, normalizedQuery),
      sourceIds: candidate.sourceIds,
    }));
}

async function runSummaryFromDir(dataDir: string, runId: string): Promise<RunSummary | undefined> {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir)) {
    return undefined;
  }

  const [report, availableFiles] = await Promise.all([
    readJsonRecord(join(runDir, REPORT_FILE)),
    listArtifactFiles(runDir),
  ]);

  return runSummary(runId, report, availableFiles);
}

export async function listRunSummaries(dataDir: string): Promise<readonly RunSummary[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => runSummaryFromDir(dataDir, entry.name)),
  );

  return summaries
    .filter((summary): summary is RunSummary => summary !== undefined)
    .toSorted((left, right) =>
      (right.generatedAt ?? right.runId).localeCompare(left.generatedAt ?? left.runId),
    );
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

  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const runResults = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => searchRun(dataDir, entry.name, { ...filters, query })),
  );
  const results = runResults.flat();

  return results
    .toSorted((left, right) =>
      (right.run.generatedAt ?? right.run.runId).localeCompare(
        left.run.generatedAt ?? left.run.runId,
      ),
    )
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

  const [report, markdown, analytics, trace, score, availableFiles] = await Promise.all([
    readJsonRecord(join(runDir, REPORT_FILE)),
    readOptionalText(join(runDir, MARKDOWN_FILE)),
    readJsonRecord(join(runDir, ANALYTICS_FILE)),
    readJsonRecord(join(runDir, TRACE_FILE)),
    readJsonRecord(join(runDir, SCORE_FILE)),
    listArtifactFiles(runDir),
  ]);

  return {
    summary: runSummary(runId, report, availableFiles),
    ...(report !== undefined ? { report } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(analytics !== undefined ? { analytics } : {}),
    ...(trace !== undefined ? { trace } : {}),
    ...(score !== undefined ? { score } : {}),
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
  const healthDir = join(dataRootFromRunsDir(dataDir), PROVIDER_HEALTH_DIR);
  const [summary, markdown] = await Promise.all([
    readJsonRecord(join(healthDir, SUMMARY_FILE)),
    readOptionalText(join(healthDir, SUMMARY_MARKDOWN_FILE)),
  ]);

  return {
    ...(summary !== undefined ? { summary } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
  };
}
