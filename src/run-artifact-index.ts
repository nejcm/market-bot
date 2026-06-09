import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Database } from "bun:sqlite";
import type { RunSearchResult, RunSummary } from "../app/types";
import type {
  AssetClass,
  JobType,
  KeyFinding,
  Prediction,
  ResearchReport,
  Source,
} from "./domain/types";
import type { HistorySearchEntry, HistorySearchFilters, HistorySection } from "./history/artifacts";
import { loadRunArtifact, scanRunArtifactsFromDisk, type RunArtifactScan } from "./run-artifacts";
import type { PredictionScore } from "./scoring/types";
import { isRecord } from "./sources/guards";

const INDEX_SCHEMA_VERSION = 1;
const DEFAULT_INDEX_FILE = "index.sqlite";
const BUSY_TIMEOUT_MS = 1000;
const MAX_HISTORY_SEARCH_RESULTS = 100;
const MAX_CONSOLE_SEARCH_RESULTS = 100;
const SNIPPET_RADIUS = 72;

const MUTABLE_SIDECARS = new Set([
  "score.json",
  "alpha-validation.json",
  "normalized/candidate-profiles.json",
]);

type SearchScope = "console" | "history";
type SqlParam = string | number | bigint | boolean | null | Uint8Array;

interface ArtifactFileRow {
  readonly run_id: string;
  readonly path: string;
  readonly size: number;
  readonly modified_at: number;
  readonly content_hash: string;
}

interface RunRow {
  readonly run_id: string;
  readonly run_dir_name: string;
  readonly generated_at: string | null;
  readonly job_type: string | null;
  readonly asset_class: string | null;
  readonly symbol: string | null;
  readonly confidence: string | null;
  readonly depth: string | null;
  readonly finding_count: number;
  readonly prediction_count: number;
  readonly source_count: number;
  readonly data_gap_count: number;
  readonly has_score: number;
  readonly report_status: string;
  readonly score_status: string;
}

interface SearchEntryRow {
  readonly entry_key: string;
  readonly scope: SearchScope;
  readonly id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly job_type: JobType;
  readonly asset_class: AssetClass;
  readonly symbol: string | null;
  readonly section: string;
  readonly label: string;
  readonly text: string;
  readonly source_ids_json: string;
  readonly provider: string | null;
  readonly source_kind: string | null;
  readonly prediction_id: string | null;
  readonly sequence: number;
}

export interface RebuildRunArtifactIndexResult {
  readonly dbPath: string;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
  readonly artifactFileCount: number;
  readonly searchEntryCount: number;
}

interface RebuildOptions {
  readonly dbPath?: string;
}

interface RunIndexRows {
  readonly run: RunRow;
  readonly files: readonly ArtifactFileRow[];
  readonly searchEntries: readonly SearchEntryRow[];
}

function dataRootFromRunsDir(dataDir: string): string {
  return basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
}

export function defaultRunArtifactIndexPath(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), DEFAULT_INDEX_FILE);
}

export function configuredRunArtifactIndexPath(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return env.MARKET_BOT_INDEX_DB_PATH?.trim() || defaultRunArtifactIndexPath(dataDir);
}

export function isRunArtifactIndexDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.MARKET_BOT_INDEX_DISABLE;
  return value === "1" || value === "true";
}

function openDatabase(path: string, readonly: boolean): Database {
  const db = readonly
    ? new Database(path, { readonly: true })
    : new Database(path, { create: true });
  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  if (!readonly) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

function schemaSql(): string {
  return `
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      run_dir_name TEXT NOT NULL UNIQUE,
      generated_at TEXT,
      job_type TEXT,
      asset_class TEXT,
      symbol TEXT,
      confidence TEXT,
      depth TEXT,
      finding_count INTEGER NOT NULL,
      prediction_count INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      data_gap_count INTEGER NOT NULL,
      has_score INTEGER NOT NULL,
      report_status TEXT NOT NULL,
      score_status TEXT NOT NULL
    );

    CREATE TABLE artifact_files (
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      modified_at REAL NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (run_id, path),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE search_entries (
      entry_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      job_type TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      symbol TEXT,
      section TEXT NOT NULL,
      label TEXT NOT NULL,
      text TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      provider TEXT,
      source_kind TEXT,
      prediction_id TEXT,
      sequence INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE search_fts USING fts5(
      text,
      label,
      content='search_entries',
      content_rowid='rowid'
    );

    CREATE INDEX search_entries_scope_run_idx ON search_entries(scope, run_id);
    CREATE INDEX search_entries_filters_idx ON search_entries(scope, symbol, asset_class, job_type, section, provider);
  `;
}

function resetSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS search_fts;
    DROP TABLE IF EXISTS search_entries;
    DROP TABLE IF EXISTS artifact_files;
    DROP TABLE IF EXISTS runs;
    ${schemaSql()}
  `);
}

function readDepth(report: ResearchReport): string | undefined {
  const { extras } = report;
  if (!isRecord(extras)) {
    return;
  }
  const value = extras.depth;
  return typeof value === "string" ? value : undefined;
}

function sourceIdsJson(sourceIds: readonly string[]): string {
  return JSON.stringify(sourceIds);
}

function parseSourceIds(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function addSearchEntry(
  rows: SearchEntryRow[],
  scope: SearchScope,
  report: ResearchReport,
  section: string,
  label: string,
  text: string,
  sourceIds: readonly string[] = [],
  extras: Partial<
    Pick<SearchEntryRow, "provider" | "source_kind" | "prediction_id" | "symbol">
  > = {},
): void {
  if (text.trim() === "") {
    return;
  }
  const id = `${report.runId}:${scope}:${section}:${String(rows.length)}`;
  const symbol = extras.symbol ?? report.symbol?.toUpperCase() ?? null;
  rows.push({
    entry_key: `${scope}:${id}`,
    scope,
    id,
    run_id: report.runId,
    generated_at: report.generatedAt,
    job_type: report.jobType,
    asset_class: report.assetClass,
    symbol,
    section,
    label,
    text,
    source_ids_json: sourceIdsJson(sourceIds),
    provider: extras.provider ?? null,
    source_kind: extras.source_kind ?? null,
    prediction_id: extras.prediction_id ?? null,
    sequence: rows.length,
  });
}

function addFindingEntries(
  rows: SearchEntryRow[],
  scope: SearchScope,
  report: ResearchReport,
  section: "keyFindings" | "bullCase" | "bearCase" | "risks" | "catalysts",
  label: string,
  findings: readonly KeyFinding[],
): void {
  for (const [index, finding] of findings.entries()) {
    addSearchEntry(
      rows,
      scope,
      report,
      section,
      `${label} ${String(index + 1)}`,
      finding.text,
      finding.sourceIds,
    );
  }
}

function openQuestions(
  report: ResearchReport,
  scores: readonly PredictionScore[],
): readonly string[] {
  const resolved = new Set(
    scores.filter((score) => score.resolved).map((score) => score.predictionId),
  );
  return [
    ...report.dataGaps.map((gap) => `Data gap: ${gap}`),
    ...report.predictions
      .filter((prediction) => !resolved.has(prediction.id))
      .map((prediction) => `Unresolved prediction: ${prediction.claim}`),
  ];
}

function addPredictionEntries(
  rows: SearchEntryRow[],
  scope: SearchScope,
  report: ResearchReport,
  predictions: readonly Prediction[],
): void {
  for (const prediction of predictions) {
    const label = scope === "console" ? `Observable forecast ${prediction.id}` : prediction.id;
    const text =
      scope === "console"
        ? [prediction.claim, prediction.measurableAs].join(" ")
        : prediction.claim;
    addSearchEntry(rows, scope, report, "predictions", label, text, prediction.sourceIds, {
      prediction_id: prediction.id,
    });
  }
}

function addSourceEntries(
  rows: SearchEntryRow[],
  scope: SearchScope,
  report: ResearchReport,
  sources: readonly Source[],
): void {
  for (const source of sources) {
    const label = scope === "console" ? `Source ${source.id}` : source.id;
    const text =
      scope === "console"
        ? [
            source.title,
            source.publisher,
            source.provider,
            source.summary,
            source.snippet,
            source.url,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" ")
        : [source.title, source.summary, source.snippet].join(" ");
    addSearchEntry(rows, scope, report, "sources", label, text, [source.id], {
      provider: source.provider ?? null,
      source_kind: source.kind,
      symbol: source.symbol?.toUpperCase() ?? report.symbol?.toUpperCase() ?? null,
    });
  }
}

function searchEntriesForReport(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  scope: SearchScope,
): readonly SearchEntryRow[] {
  const rows: SearchEntryRow[] = [];
  addSearchEntry(rows, scope, report, "summary", "Summary", report.summary);
  addFindingEntries(
    rows,
    scope,
    report,
    "keyFindings",
    scope === "console" ? "Key finding" : "keyFindings",
    report.keyFindings,
  );
  addFindingEntries(
    rows,
    scope,
    report,
    "bullCase",
    scope === "console" ? "Bull case" : "bullCase",
    report.bullCase,
  );
  addFindingEntries(
    rows,
    scope,
    report,
    "bearCase",
    scope === "console" ? "Bear case" : "bearCase",
    report.bearCase,
  );
  addFindingEntries(
    rows,
    scope,
    report,
    "risks",
    scope === "console" ? "Risk" : "risks",
    report.risks,
  );
  addFindingEntries(
    rows,
    scope,
    report,
    "catalysts",
    scope === "console" ? "Catalyst" : "catalysts",
    report.catalysts,
  );
  if (scope === "history") {
    for (const [index, gap] of report.dataGaps.entries()) {
      addSearchEntry(rows, scope, report, "dataGaps", `Data gap ${String(index + 1)}`, gap);
    }
  }
  addPredictionEntries(rows, scope, report, report.predictions);
  addSourceEntries(rows, scope, report, report.sources);
  if (scope === "console") {
    for (const [index, gap] of report.dataGaps.entries()) {
      addSearchEntry(rows, scope, report, "dataGaps", `Data gap ${String(index + 1)}`, gap);
    }
  }
  if (scope === "history") {
    for (const [index, question] of openQuestions(report, scores).entries()) {
      addSearchEntry(
        rows,
        scope,
        report,
        "openQuestions",
        `Open question ${String(index + 1)}`,
        question,
      );
    }
  }
  return rows;
}

async function listArtifactFiles(
  runDir: string,
  runId: string,
): Promise<readonly ArtifactFileRow[]> {
  const rows: ArtifactFileRow[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        const metadata = await stat(fullPath);
        const content = await readFile(fullPath);
        rows.push({
          run_id: runId,
          path: relative(runDir, fullPath).replaceAll("\\", "/"),
          size: metadata.size,
          modified_at: metadata.mtimeMs,
          content_hash: createHash("sha256").update(content).digest("hex"),
        });
      }),
    );
  }

  await visit(runDir);
  return rows.toSorted((left, right) => left.path.localeCompare(right.path));
}

function runRowFor(
  runDirName: string,
  loaded: Awaited<ReturnType<typeof loadRunArtifact>>,
  files: readonly ArtifactFileRow[],
): RunRow {
  const { artifact } = loaded;
  if (artifact === undefined) {
    return {
      run_id: runDirName,
      run_dir_name: runDirName,
      generated_at: null,
      job_type: null,
      asset_class: null,
      symbol: null,
      confidence: null,
      depth: null,
      finding_count: 0,
      prediction_count: 0,
      source_count: 0,
      data_gap_count: 0,
      has_score: files.some((file) => file.path === "score.json") ? 1 : 0,
      report_status: loaded.status.report,
      score_status: loaded.status.score,
    };
  }
  const { report } = artifact;
  return {
    run_id: report.runId,
    run_dir_name: runDirName,
    generated_at: report.generatedAt,
    job_type: report.jobType,
    asset_class: report.assetClass,
    symbol: report.symbol?.toUpperCase() ?? null,
    confidence: report.confidence,
    depth: readDepth(report) ?? null,
    finding_count: report.keyFindings.length,
    prediction_count: report.predictions.length,
    source_count: report.sources.length,
    data_gap_count: report.dataGaps.length,
    has_score: files.some((file) => file.path === "score.json") ? 1 : 0,
    report_status: loaded.status.report,
    score_status: loaded.status.score,
  };
}

async function indexRowsForRun(dataDir: string, runDirName: string): Promise<RunIndexRows> {
  const runDir = join(dataDir, runDirName);
  const loaded = await loadRunArtifact(runDir);
  const runId = loaded.artifact?.report.runId ?? runDirName;
  const files = await listArtifactFiles(runDir, runId);
  return {
    run: runRowFor(runDirName, loaded, files),
    files,
    searchEntries:
      loaded.artifact === undefined
        ? []
        : [
            ...searchEntriesForReport(loaded.artifact.report, loaded.artifact.scores, "console"),
            ...searchEntriesForReport(loaded.artifact.report, loaded.artifact.scores, "history"),
          ],
  };
}

export async function rebuildRunArtifactIndex(
  dataDir: string,
  options: RebuildOptions = {},
): Promise<RebuildRunArtifactIndexResult> {
  const dbPath = options.dbPath ?? configuredRunArtifactIndexPath(dataDir);
  await mkdir(dirname(dbPath), { recursive: true });
  const scan = await scanRunArtifactsFromDisk(dataDir);
  const runDirs = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const dirNames = runDirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const indexedRuns = await Promise.all(
    dirNames.map((runDirName) => indexRowsForRun(dataDir, runDirName)),
  );
  const runRows = indexedRuns.map((run) => run.run);
  const fileRows = indexedRuns.flatMap((run) => run.files);
  const searchEntryRows = indexedRuns.flatMap((run) => run.searchEntries);

  const db = openDatabase(dbPath, false);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      resetSchema(db);
      const insertRun = db.prepare(`
        INSERT INTO runs (
          run_id, run_dir_name, generated_at, job_type, asset_class, symbol, confidence, depth,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFile = db.prepare(`
        INSERT INTO artifact_files (run_id, path, size, modified_at, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertSearch = db.prepare(`
        INSERT INTO search_entries (
          entry_key, scope, id, run_id, generated_at, job_type, asset_class, symbol, section, label,
          text, source_ids_json, provider, source_kind, prediction_id, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of runRows) {
        insertRun.run(
          row.run_id,
          row.run_dir_name,
          row.generated_at,
          row.job_type,
          row.asset_class,
          row.symbol,
          row.confidence,
          row.depth,
          row.finding_count,
          row.prediction_count,
          row.source_count,
          row.data_gap_count,
          row.has_score,
          row.report_status,
          row.score_status,
        );
      }
      for (const row of fileRows) {
        insertFile.run(row.run_id, row.path, row.size, row.modified_at, row.content_hash);
      }
      for (const row of searchEntryRows) {
        insertSearch.run(
          row.entry_key,
          row.scope,
          row.id,
          row.run_id,
          row.generated_at,
          row.job_type,
          row.asset_class,
          row.symbol,
          row.section,
          row.label,
          row.text,
          row.source_ids_json,
          row.provider,
          row.source_kind,
          row.prediction_id,
          row.sequence,
        );
      }
      finalizeStatement(insertRun);
      finalizeStatement(insertFile);
      finalizeStatement(insertSearch);
      db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
      db.exec(`PRAGMA user_version = ${String(INDEX_SCHEMA_VERSION)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }

  return {
    dbPath,
    sourceRunCount: scan.artifacts.length,
    malformedRunCount: scan.entries.filter((entry) => entry.status.report === "malformed").length,
    artifactFileCount: fileRows.length,
    searchEntryCount: searchEntryRows.length,
  };
}

export async function writeThroughRunArtifactIndex(
  dataDir: string,
  runDirs: readonly string[],
  options: RebuildOptions = {},
): Promise<void> {
  if (isRunArtifactIndexDisabled() || runDirs.length === 0) {
    return;
  }
  const dbPath = options.dbPath ?? configuredRunArtifactIndexPath(dataDir);
  if (!existsSync(dbPath)) {
    return;
  }

  const runDirNames = [...new Set(runDirs.map((runDir) => basename(runDir)))];
  const indexedRuns = await Promise.all(
    runDirNames.map((runDirName) => indexRowsForRun(dataDir, runDirName)),
  );
  const db = openDatabase(dbPath, false);
  try {
    const version = db.query("PRAGMA user_version").get() as {
      readonly user_version: number;
    } | null;
    if (version?.user_version !== INDEX_SCHEMA_VERSION) {
      return;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRun = db.prepare("SELECT run_id FROM runs WHERE run_dir_name = ?");
      const deleteFiles = db.prepare("DELETE FROM artifact_files WHERE run_id = ?");
      const deleteSearch = db.prepare("DELETE FROM search_entries WHERE run_id = ?");
      const deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
      const insertRun = db.prepare(`
        INSERT INTO runs (
          run_id, run_dir_name, generated_at, job_type, asset_class, symbol, confidence, depth,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFile = db.prepare(`
        INSERT INTO artifact_files (run_id, path, size, modified_at, content_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertSearch = db.prepare(`
        INSERT INTO search_entries (
          entry_key, scope, id, run_id, generated_at, job_type, asset_class, symbol, section, label,
          text, source_ids_json, provider, source_kind, prediction_id, sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const indexed of indexedRuns) {
        const previous = existingRun.get(indexed.run.run_dir_name) as {
          readonly run_id: string;
        } | null;
        const runIdsToReplace = new Set([indexed.run.run_id]);
        if (previous !== null) {
          runIdsToReplace.add(previous.run_id);
        }
        for (const runId of runIdsToReplace) {
          deleteFiles.run(runId);
          deleteSearch.run(runId);
          deleteRun.run(runId);
        }
        insertRun.run(
          indexed.run.run_id,
          indexed.run.run_dir_name,
          indexed.run.generated_at,
          indexed.run.job_type,
          indexed.run.asset_class,
          indexed.run.symbol,
          indexed.run.confidence,
          indexed.run.depth,
          indexed.run.finding_count,
          indexed.run.prediction_count,
          indexed.run.source_count,
          indexed.run.data_gap_count,
          indexed.run.has_score,
          indexed.run.report_status,
          indexed.run.score_status,
        );
        for (const row of indexed.files) {
          insertFile.run(row.run_id, row.path, row.size, row.modified_at, row.content_hash);
        }
        for (const row of indexed.searchEntries) {
          insertSearch.run(
            row.entry_key,
            row.scope,
            row.id,
            row.run_id,
            row.generated_at,
            row.job_type,
            row.asset_class,
            row.symbol,
            row.section,
            row.label,
            row.text,
            row.source_ids_json,
            row.provider,
            row.source_kind,
            row.prediction_id,
            row.sequence,
          );
        }
      }
      finalizeStatement(existingRun);
      finalizeStatement(deleteFiles);
      finalizeStatement(deleteSearch);
      finalizeStatement(deleteRun);
      finalizeStatement(insertRun);
      finalizeStatement(insertFile);
      finalizeStatement(insertSearch);
      db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }
}

function finalizeStatement(statement: unknown): void {
  if (
    typeof statement === "object" &&
    statement !== null &&
    "finalize" in statement &&
    typeof statement.finalize === "function"
  ) {
    statement.finalize();
  }
}

function ftsQuery(query: string): string | undefined {
  const terms = query
    .trim()
    .split(/\s+/u)
    .filter((term) => term !== "");
  if (terms.length === 0) {
    return;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function openReadableIndex(dataDir: string): Database | undefined {
  if (isRunArtifactIndexDisabled()) {
    return;
  }
  const dbPath = configuredRunArtifactIndexPath(dataDir);
  if (!existsSync(dbPath)) {
    return;
  }
  try {
    return openDatabase(dbPath, true);
  } catch {
    return undefined;
  }
}

async function listRunDirNames(dataDir: string): Promise<readonly string[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

async function mutableSidecarMatches(
  dataDir: string,
  runDirName: string,
  row: ArtifactFileRow,
): Promise<boolean> {
  const filePath = join(dataDir, runDirName, row.path);
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && metadata.size === row.size && metadata.mtimeMs === row.modified_at;
  } catch {
    return false;
  }
}

async function indexIsFresh(dataDir: string, db: Database): Promise<boolean> {
  const version = db.query("PRAGMA user_version").get() as { readonly user_version: number } | null;
  if (version?.user_version !== INDEX_SCHEMA_VERSION) {
    return false;
  }

  const diskDirs = await listRunDirNames(dataDir);
  const indexedDirs = (
    db.query("SELECT run_dir_name FROM runs ORDER BY run_dir_name").all() as readonly {
      readonly run_dir_name: string;
    }[]
  ).map((row) => row.run_dir_name);
  if (JSON.stringify(diskDirs) !== JSON.stringify(indexedDirs)) {
    return false;
  }

  const runs = db.query("SELECT * FROM runs ORDER BY run_dir_name").all() as readonly RunRow[];
  const sidecars = db
    .query(
      `SELECT run_id, path, size, modified_at, content_hash
       FROM artifact_files
       WHERE path IN ('score.json', 'alpha-validation.json', 'normalized/candidate-profiles.json')`,
    )
    .all() as readonly ArtifactFileRow[];
  const sidecarsByKey = new Map(sidecars.map((row) => [`${row.run_id}:${row.path}`, row]));

  const checks = runs.flatMap((run) =>
    [...MUTABLE_SIDECARS].map(async (path) => {
      const indexed = sidecarsByKey.get(`${run.run_id}:${path}`);
      const diskPath = join(dataDir, run.run_dir_name, path);
      const exists = await stat(diskPath)
        .then((metadata) => metadata.isFile())
        .catch(() => false);
      if (!exists && indexed === undefined) {
        return true;
      }
      return (
        indexed !== undefined && (await mutableSidecarMatches(dataDir, run.run_dir_name, indexed))
      );
    }),
  );

  const results = await Promise.all(checks);
  return results.every(Boolean);
}

async function withFreshIndex<T>(
  dataDir: string,
  read: (db: Database) => Promise<T>,
): Promise<T | undefined> {
  const db = openReadableIndex(dataDir);
  if (db === undefined) {
    return;
  }
  try {
    return (await indexIsFresh(dataDir, db)) ? await read(db) : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function rowToSummary(row: RunRow, availableFiles: readonly string[]): RunSummary {
  return {
    runId: row.run_id,
    ...(row.generated_at !== null ? { generatedAt: row.generated_at } : {}),
    ...(row.job_type !== null ? { jobType: row.job_type } : {}),
    ...(row.asset_class !== null ? { assetClass: row.asset_class } : {}),
    ...(row.symbol !== null ? { symbol: row.symbol } : {}),
    ...(row.depth !== null ? { depth: row.depth } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    findingCount: row.finding_count,
    predictionCount: row.prediction_count,
    sourceCount: row.source_count,
    dataGapCount: row.data_gap_count,
    hasScore: row.has_score === 1,
    availableFiles,
  };
}

function availableFilesFor(db: Database, runId: string): readonly string[] {
  return (
    db
      .query("SELECT path FROM artifact_files WHERE run_id = ? ORDER BY path")
      .all(runId) as readonly {
      readonly path: string;
    }[]
  ).map((row) => row.path);
}

export async function scanRunArtifactsFromIndex(
  dataDir: string,
): Promise<RunArtifactScan | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = db.query("SELECT * FROM runs ORDER BY run_dir_name").all() as readonly RunRow[];
    const loaded = await Promise.all(
      rows
        .filter((row) => row.report_status === "ok")
        .map((row) => loadRunArtifact(join(dataDir, row.run_dir_name))),
    );
    return {
      artifacts: loaded.flatMap((item) => (item.artifact === undefined ? [] : [item.artifact])),
      entries: rows.map((row) => ({
        runDirName: row.run_dir_name,
        status: {
          report: row.report_status as RunArtifactScan["entries"][number]["status"]["report"],
          score: row.score_status as RunArtifactScan["entries"][number]["status"]["score"],
        },
      })),
    };
  });
}

export async function listRunSummariesFromIndex(
  dataDir: string,
): Promise<readonly RunSummary[] | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = db
      .query("SELECT * FROM runs ORDER BY COALESCE(generated_at, run_id) DESC")
      .all() as readonly RunRow[];
    return rows.map((row) => rowToSummary(row, availableFilesFor(db, row.run_id)));
  });
}

export async function readRunSummaryFromIndex(
  dataDir: string,
  runId: string,
): Promise<RunSummary | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const row = db
      .query("SELECT * FROM runs WHERE run_id = ? OR run_dir_name = ?")
      .get(runId, runId) as RunRow | null;
    return row === null ? undefined : rowToSummary(row, availableFilesFor(db, row.run_id));
  });
}

function appendOptionalFilter(
  clauses: string[],
  params: SqlParam[],
  column: string,
  value: string | undefined,
  normalize: (input: string) => string = (input) => input,
): void {
  if (value === undefined || value.trim() === "") {
    return;
  }
  clauses.push(`${column} = ?`);
  params.push(normalize(value));
}

function appendDateFilters(
  clauses: string[],
  params: SqlParam[],
  from: string | undefined,
  to: string | undefined,
): void {
  if (from !== undefined) {
    clauses.push("substr(e.generated_at, 1, 10) >= ?");
    params.push(from.slice(0, 10));
  }
  if (to !== undefined) {
    clauses.push("substr(e.generated_at, 1, 10) <= ?");
    params.push(to.slice(0, 10));
  }
}

function searchRows(
  db: Database,
  scope: SearchScope,
  query: string,
  filters: {
    readonly symbol?: string;
    readonly assetClass?: string;
    readonly jobType?: string;
    readonly from?: string;
    readonly to?: string;
    readonly section?: string;
    readonly provider?: string;
  },
  limit: number,
): readonly SearchEntryRow[] {
  const match = ftsQuery(query);
  if (match === undefined || limit <= 0) {
    return [];
  }
  const clauses = ["search_fts MATCH ?", "e.scope = ?"];
  const params: SqlParam[] = [match, scope];
  appendOptionalFilter(clauses, params, "e.symbol", filters.symbol, (value) => value.toUpperCase());
  appendOptionalFilter(clauses, params, "e.asset_class", filters.assetClass);
  appendOptionalFilter(clauses, params, "e.job_type", filters.jobType);
  appendOptionalFilter(clauses, params, "e.section", filters.section);
  appendOptionalFilter(clauses, params, "e.provider", filters.provider);
  appendDateFilters(clauses, params, filters.from, filters.to);
  params.push(limit);

  return db
    .query(
      `SELECT e.*
       FROM search_fts
       JOIN search_entries e ON e.rowid = search_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY e.generated_at DESC, e.run_id DESC, e.sequence ASC
       LIMIT ?`,
    )
    .all(...params) as readonly SearchEntryRow[];
}

function textSnippet(text: string, query: string): string {
  const normalized = query.trim().toLowerCase();
  const index = text.toLowerCase().indexOf(normalized);
  if (index === -1) {
    return text.slice(0, SNIPPET_RADIUS * 2).trim();
  }
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + normalized.length + SNIPPET_RADIUS);
  const prefix = start === 0 ? "" : "...";
  const suffix = end === text.length ? "" : "...";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export async function searchRunReportsFromIndex(
  dataDir: string,
  filters: {
    readonly query: string;
    readonly symbol?: string;
    readonly assetClass?: string;
    readonly jobType?: string;
    readonly from?: string;
    readonly to?: string;
  },
  limit: number = MAX_CONSOLE_SEARCH_RESULTS,
): Promise<readonly RunSearchResult[] | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = searchRows(db, "console", filters.query, filters, limit);
    return rows.map((row) => {
      const run = db.query("SELECT * FROM runs WHERE run_id = ?").get(row.run_id) as RunRow;
      return {
        run: rowToSummary(run, availableFilesFor(db, run.run_id)),
        section: row.section as RunSearchResult["section"],
        label: row.label,
        snippet: textSnippet(row.text, filters.query),
        sourceIds: parseSourceIds(row.source_ids_json),
      };
    });
  });
}

export async function searchHistoryEntriesFromIndex(
  dataDir: string,
  filters: HistorySearchFilters,
): Promise<readonly HistorySearchEntry[] | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = searchRows(
      db,
      "history",
      filters.query,
      {
        ...(filters.symbol !== undefined ? { symbol: filters.symbol } : {}),
        ...(filters.assetClass !== undefined ? { assetClass: filters.assetClass } : {}),
        ...(filters.jobType !== undefined ? { jobType: filters.jobType } : {}),
        ...(filters.from !== undefined ? { from: filters.from } : {}),
        ...(filters.to !== undefined ? { to: filters.to } : {}),
        ...(filters.section !== undefined ? { section: filters.section } : {}),
        ...(filters.provider !== undefined ? { provider: filters.provider } : {}),
      },
      filters.limit ?? MAX_HISTORY_SEARCH_RESULTS,
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      generatedAt: row.generated_at,
      jobType: row.job_type,
      assetClass: row.asset_class,
      ...(row.symbol !== null
        ? { symbol: row.symbol, instrumentKey: `${row.asset_class}:${row.symbol}` }
        : {}),
      section: row.section as HistorySection,
      label: row.label,
      text: row.text,
      sourceIds: parseSourceIds(row.source_ids_json),
      ...(row.provider !== null ? { provider: row.provider } : {}),
      ...(row.source_kind !== null ? { sourceKind: row.source_kind } : {}),
      ...(row.prediction_id !== null ? { predictionId: row.prediction_id } : {}),
    }));
  });
}
