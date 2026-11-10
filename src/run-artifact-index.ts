import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { runArtifactIndexDbPath, runArtifactIndexDisabled } from "./config";
import { listRunDirNames } from "./data-paths";
import {
  finalizeStatement,
  INDEX_SCHEMA_VERSION,
  openRunArtifactIndexDatabase as openDatabase,
  resetRunArtifactIndexSchema as resetSchema,
} from "./run-artifact-index-schema";
import { indexRowsForRun } from "./run-artifact-index-rows";
import type { RebuildOptions, RunIndexRows } from "./run-artifact-index-types";
import { warnIndexFallback } from "./run-artifact-index-queries";

export { INDEX_SCHEMA_VERSION };

export interface RebuildRunArtifactIndexResult {
  readonly dbPath: string;
  readonly sourceRunCount: number;
  readonly malformedRunCount: number;
  readonly artifactFileCount: number;
  readonly searchEntryCount: number;
}

type RunArtifactIndexStatusState =
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

export function readRunArtifactIndexStatus(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  dbPath: string = runArtifactIndexDbPath(dataDir, env),
): RunArtifactIndexStatus {
  const rebuildCommand = "bun run src/cli.ts index rebuild";
  const base = {
    dbPath,
    expectedSchemaVersion: INDEX_SCHEMA_VERSION,
    rebuildCommand,
  };
  if (runArtifactIndexDisabled(env)) {
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
      message: `Run Artifact Index database is missing. To create it, run: ${rebuildCommand}`,
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
        message: `Run Artifact Index schema version ${String(
          currentSchemaVersion ?? "unknown",
        )} is not compatible with the current expected version ${String(INDEX_SCHEMA_VERSION)}. The index will not be auto-migrated or auto-rebuilt. To update, run: ${rebuildCommand}`,
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

function insertDomainRows(db: Database, indexedRuns: readonly RunIndexRows[]): void {
  const insertPrediction = db.prepare(`
    INSERT INTO predictions (
      id, run_id, kind, subject, claim, probability, horizon_trading_days, measurable_as,
      source_ids_json, origin, baseline_probability, baseline_version, info_cutoff
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertScore = db.prepare(`
    INSERT INTO scores (
      prediction_id, run_id, resolved, status, outcome, observed_at, scoring_version,
      miss_autopsy_cause, forecast_origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOutcome = db.prepare(`
    INSERT INTO subsystem_outcomes (
      run_id, subsystem, expectation, outcome, code, stage, count, detail_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        row.origin,
        row.baseline_probability,
        row.baseline_version,
        row.info_cutoff,
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
        row.miss_autopsy_cause,
        row.forecast_origin,
      );
    }
    for (const row of indexed.outcomes) {
      insertOutcome.run(
        row.run_id,
        row.subsystem,
        row.expectation,
        row.outcome,
        row.code,
        row.stage,
        row.count,
        row.detail_json,
      );
    }
  }
  finalizeStatement(insertPrediction);
  finalizeStatement(insertScore);
  finalizeStatement(insertOutcome);
}

export async function rebuildRunArtifactIndex(
  dataDir: string,
  options: RebuildOptions = {},
): Promise<RebuildRunArtifactIndexResult> {
  const dbPath = options.dbPath ?? runArtifactIndexDbPath(dataDir);
  await mkdir(dirname(dbPath), { recursive: true });
  const dirNames = await listRunDirNames(dataDir);

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
          run_id, run_dir_name, generated_at, job_type, asset_class, symbol, evidence_quality, depth,
          market_regime_label, horizon_trading_days,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status, outcomes_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          row.evidence_quality,
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
          row.outcomes_status,
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
    malformedRunCount: runRows.filter(
      (row) => row.report_status === "malformed" || row.outcomes_status === "malformed",
    ).length,
    artifactFileCount: fileRows.length,
    searchEntryCount: searchEntryRows.length,
  };
}

export async function writeThroughRunArtifactIndex(
  dataDir: string,
  runDirs: readonly string[],
  options: RebuildOptions = {},
): Promise<void> {
  if (runArtifactIndexDisabled() || runDirs.length === 0) {
    return;
  }
  const dbPath = options.dbPath ?? runArtifactIndexDbPath(dataDir);
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
      const deleteOutcomes = db.prepare("DELETE FROM subsystem_outcomes WHERE run_id = ?");
      const deleteRun = db.prepare("DELETE FROM runs WHERE run_id = ?");
      const insertRun = db.prepare(`
        INSERT INTO runs (
          run_id, run_dir_name, generated_at, job_type, asset_class, symbol, evidence_quality, depth,
          market_regime_label, horizon_trading_days,
          finding_count, prediction_count, source_count, data_gap_count, has_score,
          report_status, score_status, outcomes_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          deleteOutcomes.run(runId);
          deleteRun.run(runId);
        }
        insertRun.run(
          indexed.run.run_id,
          indexed.run.run_dir_name,
          indexed.run.generated_at,
          indexed.run.job_type,
          indexed.run.asset_class,
          indexed.run.symbol,
          indexed.run.evidence_quality,
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
          indexed.run.outcomes_status,
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
      finalizeStatement(deleteOutcomes);
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
