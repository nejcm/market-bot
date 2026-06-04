import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunDetail, RunSummary } from "./types";

const REPORT_FILE = "report.json";
const MARKDOWN_FILE = "report.md";
const SCORE_FILE = "score.json";

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

function isWithinDirectory(root: string, path: string): boolean {
  const childPath = relative(root, path);
  return childPath === "" || (!childPath.startsWith("..") && !isAbsolute(childPath));
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

export async function readRunDetail(
  dataDir: string,
  runId: string,
): Promise<RunDetail | undefined> {
  const runDir = safeRunDir(dataDir, runId);
  if (runDir === undefined || !existsSync(runDir)) {
    return undefined;
  }

  const [report, markdown, availableFiles] = await Promise.all([
    readJsonRecord(join(runDir, REPORT_FILE)),
    readOptionalText(join(runDir, MARKDOWN_FILE)),
    listArtifactFiles(runDir),
  ]);

  return {
    summary: runSummary(runId, report, availableFiles),
    ...(report !== undefined ? { report } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
  };
}
