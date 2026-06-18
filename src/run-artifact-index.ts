import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RunSearchResult, RunSummary } from "../app/types";
import {
  marketUpdateHorizonBucketOf,
  isMarketRegimeLabel,
  type AssetClass,
  type JobType,
  type PredictionKind,
} from "./domain/types";
import { dataRootFromRunsDir } from "./data-paths";
import { renderClaimForMeasurableAs } from "./forecast/observable";
import type { HistorySearchEntry, HistorySearchFilters, HistorySection } from "./history/artifacts";
import {
  finalizeStatement,
  INDEX_SCHEMA_VERSION,
  openRunArtifactIndexDatabase as openDatabase,
  resetRunArtifactIndexSchema as resetSchema,
} from "./run-artifact-index-schema";
import { indexIsFresh } from "./run-artifact-index-freshness";
import { indexRowsForRun } from "./run-artifact-index-rows";
import type {
  PredictionRow,
  RebuildOptions,
  RunIndexRows,
  RunRow,
  SearchEntryRow,
  SearchScope,
  SqlParam,
} from "./run-artifact-index-types";
import type { ResolvedPair } from "./scoring/calibration";
import type {
  ConditionalCalibrationSummary,
  PredictionScore,
  PredictionScoreStatus,
} from "./scoring/types";

export { INDEX_SCHEMA_VERSION };
const DEFAULT_INDEX_FILE = "index.sqlite";
const MAX_HISTORY_SEARCH_RESULTS = 100;
const MAX_CONSOLE_SEARCH_RESULTS = 100;
const SNIPPET_RADIUS = 72;

export interface RebuildRunArtifactIndexResult {
  readonly dbPath: string;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
  readonly artifactFileCount: number;
  readonly searchEntryCount: number;
}

export type RunArtifactIndexStatusState =
  | "available"
  | "disabled"
  | "missing"
  | "unreadable"
  | "unsupported-schema";

export interface RunArtifactIndexStatus {
  readonly state: RunArtifactIndexStatusState;
  readonly dbPath: string;
  readonly expectedSchemaVersion: number;
  readonly currentSchemaVersion?: number;
  readonly rebuildCommand: string;
  readonly message: string;
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

export function readRunArtifactIndexStatus(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  dbPath: string = configuredRunArtifactIndexPath(dataDir, env),
): RunArtifactIndexStatus {
  const rebuildCommand = "bun run src/cli.ts index rebuild";
  const base = {
    dbPath,
    expectedSchemaVersion: INDEX_SCHEMA_VERSION,
    rebuildCommand,
  };
  if (isRunArtifactIndexDisabled(env)) {
    return {
      ...base,
      state: "disabled",
      message: "Run Artifact Index is disabled by MARKET_BOT_INDEX_DISABLE.",
    };
  }
  if (!existsSync(dbPath)) {
    return {
      ...base,
      state: "missing",
      message: `Run Artifact Index database is missing; run ${rebuildCommand}.`,
    };
  }

  let db: Database | undefined = undefined;
  try {
    db = openDatabase(dbPath, true);
    const version = db.query("PRAGMA user_version").get() as {
      readonly user_version: number;
    } | null;
    const currentSchemaVersion = version?.user_version;
    if (currentSchemaVersion !== INDEX_SCHEMA_VERSION) {
      return {
        ...base,
        state: "unsupported-schema",
        ...(currentSchemaVersion !== undefined ? { currentSchemaVersion } : {}),
        message: `Run Artifact Index schema ${String(
          currentSchemaVersion ?? "unknown",
        )} is unsupported; expected ${String(INDEX_SCHEMA_VERSION)}. Run ${rebuildCommand}.`,
      };
    }
    return {
      ...base,
      state: "available",
      currentSchemaVersion,
      message: "Run Artifact Index schema is supported.",
    };
  } catch (error) {
    return {
      ...base,
      state: "unreadable",
      message: `Run Artifact Index could not be opened: ${String(error)}`,
    };
  } finally {
    db?.close();
  }
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

function predictionClaimFromRow(row: PredictionRow): string {
  return renderClaimForMeasurableAs(row.measurable_as, row.claim) ?? row.claim;
}

function insertDomainRows(db: Database, indexedRuns: readonly RunIndexRows[]): void {
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (
      id, run_id, kind, subject, claim, probability, horizon_trading_days, measurable_as,
      source_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertScore = db.prepare(`
    INSERT INTO scores (
      prediction_id, run_id, resolved, status, outcome, observed_at, scoring_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const indexed of indexedRuns) {
    for (const row of indexed.predictions) {
      insertPrediction.run(
        row.id,
        row.run_id,
        row.kind,
        row.subject,
        row.claim,
        row.probability,
        row.horizon_trading_days,
        row.measurable_as,
        row.source_ids_json,
      );
    }
    for (const row of indexed.scores) {
      insertScore.run(
        row.prediction_id,
        row.run_id,
        row.resolved,
        row.status,
        row.outcome,
        row.observed_at,
        row.scoring_version,
      );
    }
  }
  finalizeStatement(insertPrediction);
  finalizeStatement(insertScore);
}

export async function rebuildRunArtifactIndex(
  dataDir: string,
  options: RebuildOptions = {},
): Promise<RebuildRunArtifactIndexResult> {
  const dbPath = options.dbPath ?? configuredRunArtifactIndexPath(dataDir);
  await mkdir(dirname(dbPath), { recursive: true });
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
          market_regime_label, horizon_trading_days,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFile = db.prepare(`
        INSERT INTO artifact_files (run_id, path, size, modified_at)
        VALUES (?, ?, ?, ?)
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
          row.market_regime_label,
          row.horizon_trading_days,
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
        insertFile.run(row.run_id, row.path, row.size, row.modified_at);
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
      insertDomainRows(db, indexedRuns);
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
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    db.close();
  }

  return {
    dbPath,
    sourceRunCount: runRows.filter((row) => row.report_status === "ok").length,
    malformedRunCount: runRows.filter((row) => row.report_status === "malformed").length,
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
    warnIndexFallback("index database missing, skipping write-through");
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
      warnIndexFallback(
        `unsupported schema version ${String(version?.user_version ?? "unknown")}, skipping write-through`,
      );
      return;
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRun = db.prepare("SELECT run_id FROM runs WHERE run_dir_name = ?");
      const deleteFiles = db.prepare("DELETE FROM artifact_files WHERE run_id = ?");
      const deleteSearch = db.prepare("DELETE FROM search_entries WHERE run_id = ?");
      const deletePredictions = db.prepare("DELETE FROM predictions WHERE run_id = ?");
      const deleteScores = db.prepare("DELETE FROM scores WHERE run_id = ?");
      const deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
      const insertRun = db.prepare(`
        INSERT INTO runs (
          run_id, run_dir_name, generated_at, job_type, asset_class, symbol, confidence, depth,
          market_regime_label, horizon_trading_days,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFile = db.prepare(`
        INSERT INTO artifact_files (run_id, path, size, modified_at)
        VALUES (?, ?, ?, ?)
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
          deletePredictions.run(runId);
          deleteScores.run(runId);
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
          indexed.run.market_regime_label,
          indexed.run.horizon_trading_days,
          indexed.run.finding_count,
          indexed.run.prediction_count,
          indexed.run.source_count,
          indexed.run.data_gap_count,
          indexed.run.has_score,
          indexed.run.report_status,
          indexed.run.score_status,
        );
        for (const row of indexed.files) {
          insertFile.run(row.run_id, row.path, row.size, row.modified_at);
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
      insertDomainRows(db, indexedRuns);
      finalizeStatement(existingRun);
      finalizeStatement(deleteFiles);
      finalizeStatement(deleteSearch);
      finalizeStatement(deletePredictions);
      finalizeStatement(deleteScores);
      finalizeStatement(deleteRun);
      finalizeStatement(insertRun);
      finalizeStatement(insertFile);
      finalizeStatement(insertSearch);
      /*
       * FTS is contentless over search_entries and repopulated only by `index rebuild`.
       * Write-through deliberately leaves it stale because substring `instr` is the search
       * parity path; rebuilding FTS per run would cost O(corpus) work for no current reader.
       */
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    db.close();
  }
}

function warnIndexFallback(message: string): void {
  process.stderr.write(`Run artifact index: ${message}\n`);
}

function normalizeSearchQuery(query: string): string | undefined {
  const normalized = query.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
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

async function withFreshIndex<T>(
  dataDir: string,
  read: (db: Database) => Promise<T>,
): Promise<T | undefined> {
  const db = openReadableIndex(dataDir);
  if (db === undefined) {
    return;
  }
  try {
    return (await indexIsFresh(dataDir, db, warnIndexFallback)) ? await read(db) : undefined;
  } catch (error: unknown) {
    warnIndexFallback(
      `index read failed (${error instanceof Error ? error.message : String(error)}), falling back to disk scan`,
    );
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

function runsById(db: Database, runIds: readonly string[]): Map<string, RunRow> {
  if (runIds.length === 0) {
    return new Map();
  }
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT * FROM runs WHERE run_id IN (${placeholders})`)
    .all(...runIds) as readonly RunRow[];
  return new Map(rows.map((row) => [row.run_id, row]));
}

function availableFilesByRunId(
  db: Database,
  runIds: readonly string[],
): Map<string, readonly string[]> {
  if (runIds.length === 0) {
    return new Map();
  }
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT run_id, path FROM artifact_files WHERE run_id IN (${placeholders}) ORDER BY run_id, path`,
    )
    .all(...runIds) as readonly { readonly run_id: string; readonly path: string }[];
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const paths = grouped.get(row.run_id) ?? [];
    paths.push(row.path);
    grouped.set(row.run_id, paths);
  }
  return new Map([...grouped.entries()].map(([runId, paths]) => [runId, paths] as const));
}

export async function listRunSummariesFromIndex(
  dataDir: string,
): Promise<readonly RunSummary[] | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = db
      .query("SELECT * FROM runs ORDER BY COALESCE(generated_at, run_id) DESC, run_dir_name DESC")
      .all() as readonly RunRow[];
    const filesByRunId = availableFilesByRunId(
      db,
      rows.map((row) => row.run_id),
    );
    return rows.map((row) => rowToSummary(row, filesByRunId.get(row.run_id) ?? []));
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
  matchLabel = false,
): readonly SearchEntryRow[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery === undefined || limit <= 0) {
    return [];
  }
  const clauses = ["e.scope = ?"];
  const params: SqlParam[] = [scope];
  if (matchLabel) {
    clauses.push("(instr(lower(e.text), ?) > 0 OR instr(lower(e.label), ?) > 0)");
    params.push(normalizedQuery, normalizedQuery);
  } else {
    clauses.push("instr(lower(e.text), ?) > 0");
    params.push(normalizedQuery);
  }
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
       FROM search_entries e
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
    const runIds = [...new Set(rows.map((row) => row.run_id))];
    const runById = runsById(db, runIds);
    const filesByRunId = availableFilesByRunId(db, runIds);
    return rows.map((row) => {
      const run = runById.get(row.run_id);
      if (run === undefined) {
        throw new Error(`Missing indexed run row for ${row.run_id}`);
      }
      return {
        run: rowToSummary(run, filesByRunId.get(run.run_id) ?? []),
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
      true,
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

interface ResolvedPairQueryRow {
  readonly id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly subject: string;
  readonly claim: string;
  readonly probability: number;
  readonly horizon_trading_days: number;
  readonly measurable_as: string;
  readonly source_ids_json: string;
  readonly prediction_id: string;
  readonly status: string | null;
  readonly outcome: string;
  readonly observed_at: string | null;
  readonly scoring_version: number | null;
  readonly job_type: string;
  readonly asset_class: string;
  readonly market_regime_label: string | null;
  readonly run_horizon_trading_days: number | null;
}

// Bucket a resolved pair by the run-level horizon (mirroring the disk path),
// Not the per-prediction horizon, so index-backed and disk-backed calibration
// Slice identically regardless of index freshness.
function marketUpdateBucketForRow(jobType: JobType, runHorizon: number | null): string | undefined {
  return marketUpdateHorizonBucketOf({ jobType, horizonTradingDays: runHorizon ?? undefined });
}

export async function loadResolvedPairsFromIndex(
  dataDir: string,
): Promise<readonly ResolvedPair[] | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = db
      .query(
        `SELECT
          p.id, p.run_id, p.kind, p.subject, p.claim, p.probability, p.horizon_trading_days,
          p.measurable_as, p.source_ids_json,
          s.prediction_id, s.status, s.outcome, s.observed_at, s.scoring_version,
          r.job_type, r.asset_class, r.market_regime_label,
          r.horizon_trading_days AS run_horizon_trading_days
        FROM predictions p
        JOIN scores s ON p.run_id = s.run_id AND p.id = s.prediction_id
        JOIN runs r ON r.run_id = p.run_id
        WHERE s.resolved = 1 AND s.outcome IS NOT NULL`,
      )
      .all() as readonly ResolvedPairQueryRow[];

    return rows.map((row) => {
      const jobType = row.job_type as JobType;
      const claim = predictionClaimFromRow(row);
      const horizonBucket = marketUpdateBucketForRow(jobType, row.run_horizon_trading_days);
      return {
        prediction: {
          id: row.id,
          claim,
          kind: row.kind as PredictionKind,
          subject: row.subject,
          measurableAs: row.measurable_as,
          horizonTradingDays: row.horizon_trading_days,
          probability: row.probability,
          sourceIds: parseSourceIds(row.source_ids_json),
        },
        score: {
          predictionId: row.prediction_id,
          runId: row.run_id,
          ...(row.status !== null ? { status: row.status as PredictionScoreStatus } : {}),
          resolved: true,
          outcome: row.outcome as PredictionScore["outcome"],
          observedAt: row.observed_at ?? undefined,
          ...(row.scoring_version !== null ? { scoringVersion: row.scoring_version } : {}),
          attemptCount: 0,
          evidence: {},
        },
        assetClass: row.asset_class as AssetClass,
        jobType,
        runId: row.run_id,
        ...(horizonBucket !== undefined ? { marketUpdateHorizonBucket: horizonBucket } : {}),
        ...(isMarketRegimeLabel(row.market_regime_label)
          ? { marketRegimeLabel: row.market_regime_label }
          : {}),
      };
    });
  });
}

export async function loadConditionalCalibrationCountsFromIndex(
  dataDir: string,
): Promise<ConditionalCalibrationSummary | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const row = db
      .query(
        `SELECT COUNT(*) AS voided_count
        FROM predictions p
        JOIN scores s ON p.run_id = s.run_id AND p.id = s.prediction_id
        WHERE p.kind = 'conditional' AND s.status = 'voided'`,
      )
      .get() as { readonly voided_count: number } | null;
    // Activated conditionals are the resolved conditional pairs already passed
    // Into buildCalibrationSummary; this query only supplies excluded voids.
    return { activatedCount: 0, voidedCount: row?.voided_count ?? 0 };
  });
}
