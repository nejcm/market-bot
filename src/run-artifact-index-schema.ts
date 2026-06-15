import { Database, type Statement } from "bun:sqlite";

export const INDEX_SCHEMA_VERSION = 6;
const BUSY_TIMEOUT_MS = 1000;

export function openRunArtifactIndexDatabase(path: string, readonly: boolean): Database {
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
      market_regime_label TEXT,
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

    CREATE TABLE predictions (
      id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      claim TEXT NOT NULL,
      probability REAL NOT NULL,
      horizon_trading_days INTEGER NOT NULL,
      measurable_as TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      PRIMARY KEY (run_id, id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE scores (
      prediction_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      resolved INTEGER NOT NULL,
      outcome TEXT,
      observed_at TEXT,
      scoring_version INTEGER,
      PRIMARY KEY (run_id, prediction_id),
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE INDEX scores_resolved_idx ON scores(resolved, outcome);
  `;
}

export function resetRunArtifactIndexSchema(db: Database): void {
  db.exec(`
    DROP TABLE IF EXISTS search_fts;
    DROP TABLE IF EXISTS scores;
    DROP TABLE IF EXISTS predictions;
    DROP TABLE IF EXISTS search_entries;
    DROP TABLE IF EXISTS artifact_files;
    DROP TABLE IF EXISTS runs;
    ${schemaSql()}
  `);
}

export function finalizeStatement(statement: Statement): void {
  statement.finalize();
}
