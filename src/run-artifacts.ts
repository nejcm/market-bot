import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AssetClass,
  JobType,
  KeyFinding,
  MarketSnapshot,
  Prediction,
  PredictionKind,
  ResearchReport,
  Source,
} from "./domain/types";
import type { PredictionScore } from "./scoring/types";
import { isRecord, nonEmptyStringArrayValue, readString, stringArrayValue } from "./sources/guards";

// ---------------------------------------------------------------------------
// Run Artifact reader — the single read seam for persisted research runs under
// MARKET_BOT_DATA_DIR/<run-id>/. Parses report.json, score.json, and normalized
// Market snapshots once, leniently, at full fidelity. Callers project down to
// What they need. Reading is intentionally tolerant: older artifacts predate the
// Current schema, and report/schema.ts only validates on write. See ADR 0016.
// ---------------------------------------------------------------------------

// Per-file load outcome. "absent" = the file is missing (ENOENT); "malformed" =
// Present but unreadable or wrong shape.
export type ArtifactFileStatus = "ok" | "malformed" | "absent";

export interface RunArtifactStatus {
  readonly report: ArtifactFileStatus;
  readonly score: ArtifactFileStatus;
}

// The parsed core of one run directory. Only produced when report.json loads
// (status.report === "ok"). History/alpha-specific files (supplemental
// Snapshots, SEC fundamentals, alpha validation) are read by their one caller,
// Not here.
export interface RunArtifact {
  readonly runDirName: string;
  readonly report: ResearchReport;
  readonly scores: readonly PredictionScore[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly status: RunArtifactStatus;
}

// Status for every scanned directory, including those without a loadable report.
// Callers fold these into their own audit counts.
export interface RunScanEntry {
  readonly runDirName: string;
  readonly status: RunArtifactStatus;
}

export interface RunArtifactScan {
  // Report-"ok" runs only.
  readonly artifacts: readonly RunArtifact[];
  // One entry per scanned directory.
  readonly entries: readonly RunScanEntry[];
}

export interface LoadedRunArtifact {
  readonly artifact?: RunArtifact;
  readonly status: RunArtifactStatus;
}

interface JsonFileResult {
  readonly status: ArtifactFileStatus;
  readonly value?: unknown;
}

const PREDICTION_KINDS: ReadonlySet<string> = new Set<PredictionKind>([
  "direction",
  "relative",
  "volatility",
  "range",
  "macro",
  "iv",
]);

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isJobType(value: unknown): value is JobType {
  return value === "daily" || value === "weekly" || value === "ticker" || value === "alpha-search";
}

function isPredictionKind(value: unknown): value is PredictionKind {
  return typeof value === "string" && PREDICTION_KINDS.has(value);
}

// Distinguishes a missing file from a present-but-broken one: ENOENT returns
// "absent", any other failure (IO error, invalid JSON) returns "malformed".
async function readJsonFile(path: string): Promise<JsonFileResult> {
  try {
    const raw = await readFile(path, "utf8");
    try {
      return { status: "ok", value: JSON.parse(raw) as unknown };
    } catch {
      return { status: "malformed" };
    }
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { status: "absent" }
      : { status: "malformed" };
  }
}

function readFindings(value: unknown): readonly KeyFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly KeyFinding[] => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return [];
    }
    return [{ text: item.text, sourceIds: nonEmptyStringArrayValue(item.sourceIds) }];
  });
}

function readPredictions(value: unknown): readonly Prediction[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Prediction[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.claim !== "string" ||
      !isPredictionKind(item.kind) ||
      typeof item.subject !== "string" ||
      typeof item.measurableAs !== "string" ||
      typeof item.horizonTradingDays !== "number" ||
      typeof item.probability !== "number"
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        claim: item.claim,
        kind: item.kind,
        subject: item.subject,
        measurableAs: item.measurableAs,
        horizonTradingDays: item.horizonTradingDays,
        probability: item.probability,
        sourceIds: nonEmptyStringArrayValue(item.sourceIds),
      },
    ];
  });
}

function readSources(value: unknown): readonly Source[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly Source[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.title !== "string" ||
      typeof item.fetchedAt !== "string" ||
      typeof item.kind !== "string"
    ) {
      return [];
    }
    return [item as unknown as Source];
  });
}

function readReport(value: unknown): ResearchReport | undefined {
  if (!isRecord(value) || !isJobType(value.jobType) || !isAssetClass(value.assetClass)) {
    return;
  }
  const runId = readString(value, "runId");
  const generatedAt = readString(value, "generatedAt");
  if (runId === undefined || generatedAt === undefined) {
    return;
  }
  return {
    runId,
    jobType: value.jobType,
    assetClass: value.assetClass,
    ...(typeof value.symbol === "string" ? { symbol: value.symbol.toUpperCase() } : {}),
    generatedAt,
    summary: readString(value, "summary") ?? "",
    keyFindings: readFindings(value.keyFindings),
    bullCase: readFindings(value.bullCase),
    bearCase: readFindings(value.bearCase),
    risks: readFindings(value.risks),
    catalysts: readFindings(value.catalysts),
    scenarios: [],
    confidence:
      value.confidence === "high" || value.confidence === "medium" || value.confidence === "low"
        ? value.confidence
        : "low",
    dataGaps: stringArrayValue(value.dataGaps),
    predictions: readPredictions(value.predictions),
    sources: readSources(value.sources),
    notFinancialAdvice: true,
    ...(isRecord(value.extras) ? { extras: value.extras } : {}),
  };
}

function readScores(value: unknown): readonly PredictionScore[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return;
  }
  return value.scores.flatMap((item): readonly PredictionScore[] => {
    if (
      !isRecord(item) ||
      typeof item.predictionId !== "string" ||
      typeof item.runId !== "string" ||
      typeof item.resolved !== "boolean" ||
      typeof item.attemptCount !== "number" ||
      !isRecord(item.evidence)
    ) {
      return [];
    }
    return [
      {
        predictionId: item.predictionId,
        runId: item.runId,
        resolved: item.resolved,
        outcome: item.outcome === "hit" || item.outcome === "miss" ? item.outcome : undefined,
        observedAt: typeof item.observedAt === "string" ? item.observedAt : undefined,
        attemptCount: item.attemptCount,
        // Carried through at full fidelity so score-writing consumers (scoring/index.ts) can
        // Preserve the version stamped on already-resolved scores. Undefined for legacy files.
        ...(typeof item.scoringVersion === "number" ? { scoringVersion: item.scoringVersion } : {}),
        evidence: item.evidence,
      },
    ];
  });
}

function readSnapshots(value: unknown): readonly MarketSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly MarketSnapshot[] => {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      !isAssetClass(item.assetClass) ||
      typeof item.symbol !== "string" ||
      typeof item.price !== "number" ||
      typeof item.changePercent24h !== "number" ||
      typeof item.volume !== "number" ||
      typeof item.observedAt !== "string"
    ) {
      return [];
    }
    return [item as unknown as MarketSnapshot];
  });
}

function scoreStatusFor(
  file: JsonFileResult,
  parsed: readonly PredictionScore[] | undefined,
): ArtifactFileStatus {
  if (file.status === "absent") {
    return "absent";
  }
  return parsed === undefined ? "malformed" : "ok";
}

const REPORT_FILE = "report.json";
const SCORE_FILE = "score.json";
const MARKET_SNAPSHOTS_FILE = join("normalized", "market-snapshots.json");

// Reads one run directory. Returns an artifact only when report.json loads to a
// Valid report; score.json is read only in that case (matching the historical
// Short-circuit so audit counts stay stable).
export async function loadRunArtifact(runDir: string): Promise<LoadedRunArtifact> {
  const runDirName = basename(runDir);
  const reportFile = await readJsonFile(join(runDir, REPORT_FILE));
  const report = reportFile.status === "ok" ? readReport(reportFile.value) : undefined;
  if (report === undefined) {
    // ENOENT stays "absent"; a present-but-bad report becomes "malformed".
    const reportStatus: ArtifactFileStatus =
      reportFile.status === "absent" ? "absent" : "malformed";
    return { status: { report: reportStatus, score: "absent" } };
  }

  const scoreFile = await readJsonFile(join(runDir, SCORE_FILE));
  const parsedScores = scoreFile.status === "ok" ? readScores(scoreFile.value) : undefined;
  const snapshotFile = await readJsonFile(join(runDir, MARKET_SNAPSHOTS_FILE));
  const status: RunArtifactStatus = {
    report: "ok",
    score: scoreStatusFor(scoreFile, parsedScores),
  };

  return {
    artifact: {
      runDirName,
      report,
      scores: parsedScores ?? [],
      marketSnapshots: readSnapshots(snapshotFile.value),
      status,
    },
    status,
  };
}

// Scans every run directory under dataDir in one pass. A missing dataDir yields
// An empty scan.
export async function scanRunArtifactsFromDisk(dataDir: string): Promise<RunArtifactScan> {
  const dirEntries = await readdir(dataDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw error;
  });

  const dirs = dirEntries.filter((entry) => entry.isDirectory());
  const loaded = await Promise.all(
    dirs.map(async (entry) => ({
      name: entry.name,
      result: await loadRunArtifact(join(dataDir, entry.name)),
    })),
  );

  return {
    artifacts: loaded.flatMap((item) =>
      item.result.artifact === undefined ? [] : [item.result.artifact],
    ),
    entries: loaded.map((item) => ({ runDirName: item.name, status: item.result.status })),
  };
}

export async function scanRunArtifacts(dataDir: string): Promise<RunArtifactScan> {
  const { scanRunArtifactsFromIndex } = await import("./run-artifact-index");
  return (await scanRunArtifactsFromIndex(dataDir)) ?? (await scanRunArtifactsFromDisk(dataDir));
}
