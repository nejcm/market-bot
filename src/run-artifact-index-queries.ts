import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RunSearchResult, RunSummary, WatchlistRowState } from "./run-artifact-index-types";
import { marketUpdateHorizonBucketOf, type AssetClass, type JobType } from "./domain/job-type";
import { isPredictionOrigin, type PredictionKind } from "./domain/prediction";
import { isMarketRegimeLabel } from "./domain/report";
import { runArtifactIndexDbPath, runArtifactIndexDisabled } from "./config";
import { listRunDirNames } from "./data-paths";
import {
  instrumentsForExpression,
  parseObservableExpression,
  renderClaimForMeasurableAs,
} from "./forecast/observable";
import type { HistorySearchEntry, HistorySearchFilters, HistorySection } from "./history/artifacts";
import { openRunArtifactIndexDatabase as openDatabase } from "./run-artifact-index-schema";
import { indexIsFresh } from "./run-artifact-index-freshness";
import { readJsonFile } from "./run-artifact-json-reader";
import { RUN_ARTIFACT_FILES, type ArtifactFileStatus } from "./run-artifact-layout";
import { readReport } from "./run-artifact-report-reader";
import { readPredictionScoreStatus } from "./run-artifact-score-reader";
import { isTerminal } from "./scoring/score-status";
import { isMissAutopsyCause } from "./run-artifacts";
import { readRunSubsystemOutcomesFromDisk } from "./run-artifact-index-rows";
import {
  runSearchResultFromIndexRow,
  runSummaryFromIndexRow,
  subsystemOutcomeFromIndexRow,
  type RunSubsystemOutcomeLedger,
} from "./run-artifact-projection";
import { isRecord, parseStringArrayJson, readStringVerbatim } from "./guards";
import type {
  PredictionRow,
  RunRow,
  SearchEntryRow,
  SearchScope,
  SqlParam,
  SubsystemOutcomeRow,
} from "./run-artifact-index-types";
import { forecastEventKey, type ResolvedPair } from "./scoring/calibration";
import type {
  ConditionalCalibrationSummary,
  PredictionScore,
  PredictionScoreStatus,
} from "./scoring/types";

const MAX_HISTORY_SEARCH_RESULTS = 100;
const MAX_CONSOLE_SEARCH_RESULTS = 100;

function predictionClaimFromRow(row: PredictionRow): string {
  return renderClaimForMeasurableAs(row.measurable_as, row.claim) ?? row.claim;
}

export function warnIndexFallback(message: string): void {
  process.stderr.write(`Run artifact index: ${message}\n`);
}

function normalizeSearchQuery(query: string): string | undefined {
  const normalized = query.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

function openReadableIndex(dataDir: string): Database | undefined {
  if (runArtifactIndexDisabled()) {
    return;
  }
  const dbPath = runArtifactIndexDbPath(dataDir);
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
  diskDirNames?: readonly string[],
): Promise<T | undefined> {
  const db = openReadableIndex(dataDir);
  if (db === undefined) {
    return;
  }
  try {
    return await withReadSnapshot(db, async () => {
      const fresh = await indexIsFresh(dataDir, db, warnIndexFallback, diskDirNames);
      return fresh ? await read(db) : undefined;
    });
  } catch (error: unknown) {
    warnIndexFallback(
      `index read failed (${error instanceof Error ? error.message : String(error)}), falling back to disk scan`,
    );
    return undefined;
  } finally {
    db.close();
  }
}

async function withReadSnapshot<T>(db: Database, work: () => Promise<T>): Promise<T> {
  // Deferred so a write-through cannot land between freshness and the projection read.
  db.exec("BEGIN");
  try {
    const result = await work();
    db.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection-level failures leave no transaction; keep the original error.
    }
    throw error;
  }
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
    return rows.map((row) => runSummaryFromIndexRow(row, filesByRunId.get(row.run_id) ?? []));
  });
}

export async function loadRunSubsystemOutcomesFromIndex(
  dataDir: string,
  diskDirNames?: readonly string[],
): Promise<readonly RunSubsystemOutcomeLedger[] | undefined> {
  return await withFreshIndex(
    dataDir,
    async (db) => {
      const statusRows = db
        .query("SELECT run_id, outcomes_status FROM runs ORDER BY run_id")
        .all() as readonly {
        readonly run_id: string;
        readonly outcomes_status: string;
      }[];
      const outcomeRows = db
        .query("SELECT * FROM subsystem_outcomes ORDER BY run_id, rowid")
        .all() as readonly SubsystemOutcomeRow[];
      const outcomeRowsByRunId = new Map<string, SubsystemOutcomeRow[]>();
      for (const outcomeRow of outcomeRows) {
        const rows = outcomeRowsByRunId.get(outcomeRow.run_id) ?? [];
        rows.push(outcomeRow);
        outcomeRowsByRunId.set(outcomeRow.run_id, rows);
      }
      return statusRows.map((row): RunSubsystemOutcomeLedger => {
        const status: ArtifactFileStatus =
          row.outcomes_status === "ok" ||
          row.outcomes_status === "absent" ||
          row.outcomes_status === "malformed"
            ? row.outcomes_status
            : "malformed";
        const indexedRows = outcomeRowsByRunId.get(row.run_id) ?? [];
        const outcomes = indexedRows.map((item) => subsystemOutcomeFromIndexRow(item));
        if (status !== "ok") {
          return { runId: row.run_id, status, outcomes: [] };
        }
        if (outcomes.some((outcome) => outcome === undefined)) {
          return { runId: row.run_id, status: "malformed", outcomes: [] };
        }
        return {
          runId: row.run_id,
          status,
          outcomes: outcomes.filter((outcome) => outcome !== undefined),
        };
      });
    },
    diskDirNames,
  );
}

export async function scanRunSubsystemOutcomesFromDisk(
  dataDir: string,
  runDirNames?: readonly string[],
): Promise<readonly RunSubsystemOutcomeLedger[]> {
  const names = runDirNames ?? (await listRunDirNames(dataDir));
  const outcomes = await Promise.all(
    [...names]
      .toSorted((left, right) => left.localeCompare(right))
      .map(async (name) => {
        const runDir = join(dataDir, name);
        const reportFile = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.report));
        const failureFile = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.failure));
        const report = reportFile.status === "ok" ? readReport(reportFile.value) : undefined;
        const runId =
          report?.runId ??
          (failureFile.status === "ok" && isRecord(failureFile.value)
            ? readStringVerbatim(failureFile.value, "runId")
            : undefined) ??
          name;
        return await readRunSubsystemOutcomesFromDisk(runDir, runId);
      }),
  );
  return outcomes.toSorted(
    (left, right) => Number(left.runId > right.runId) - Number(left.runId < right.runId),
  );
}

export async function readRunSummaryFromIndex(
  dataDir: string,
  runId: string,
): Promise<RunSummary | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const row = db
      .query("SELECT * FROM runs WHERE run_id = ? OR run_dir_name = ?")
      .get(runId, runId) as RunRow | null;
    return row === null
      ? undefined
      : runSummaryFromIndexRow(row, availableFilesFor(db, row.run_id));
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
      return runSearchResultFromIndexRow(
        row,
        runSummaryFromIndexRow(run, filesByRunId.get(run.run_id) ?? []),
        filters.query,
      );
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
      sourceIds: parseStringArrayJson(row.source_ids_json),
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
  readonly origin: string | null;
  readonly baseline_probability: number | null;
  readonly baseline_version: string | null;
  readonly info_cutoff: string | null;
  readonly prediction_id: string;
  readonly status: string | null;
  readonly outcome: string;
  readonly observed_at: string | null;
  readonly scoring_version: number | null;
  readonly miss_autopsy_cause: string | null;
  readonly forecast_origin: string | null;
  readonly job_type: string;
  readonly asset_class: string;
  readonly generated_at: string;
  readonly market_regime_label: string | null;
  readonly run_horizon_trading_days: number | null;
}

// Bucket a resolved pair by the run-level horizon (mirroring the disk path),
// Not the per-prediction horizon, so index-backed and disk-backed calibration
// Slice identically regardless of index freshness.
function marketUpdateBucketForRow(jobType: JobType, runHorizon: number | null): string | undefined {
  return marketUpdateHorizonBucketOf({ jobType, horizonTradingDays: runHorizon ?? undefined });
}

// Indexes built before readReport rejected unparseable timestamps still hold those runs' rows.
function hasParseableGeneratedAt(row: { readonly generated_at: string }): boolean {
  return !Number.isNaN(Date.parse(row.generated_at));
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
          p.origin, p.baseline_probability, p.baseline_version, p.info_cutoff,
          s.prediction_id, s.status, s.outcome, s.observed_at, s.scoring_version,
          s.miss_autopsy_cause, s.forecast_origin,
          r.job_type, r.asset_class, r.generated_at, r.market_regime_label,
          r.horizon_trading_days AS run_horizon_trading_days
        FROM predictions p
        JOIN scores s ON p.run_id = s.run_id AND p.id = s.prediction_id
        JOIN runs r ON r.run_id = p.run_id
        WHERE s.resolved = 1 AND s.outcome IS NOT NULL AND s.scoring_version = 3`,
      )
      .all() as readonly ResolvedPairQueryRow[];

    return rows
      .filter((row) => hasParseableGeneratedAt(row))
      .map((row) => {
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
            sourceIds: parseStringArrayJson(row.source_ids_json),
            // The query keeps v3 scores only, and a score's version is its prediction's policy version.
            scoringPolicyVersion: 3,
            ...(isPredictionOrigin(row.origin) ? { origin: row.origin } : {}),
            ...(row.baseline_probability !== null &&
            row.baseline_version !== null &&
            row.info_cutoff !== null
              ? {
                  baselineProbability: row.baseline_probability,
                  baselineVersion: row.baseline_version,
                }
              : {}),
            ...(row.info_cutoff !== null ? { infoCutoff: row.info_cutoff } : {}),
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
            ...(row.forecast_origin !== null ? { forecastOrigin: row.forecast_origin } : {}),
          },
          assetClass: row.asset_class as AssetClass,
          jobType,
          runId: row.run_id,
          generatedAt: row.generated_at,
          ...(horizonBucket !== undefined ? { marketUpdateHorizonBucket: horizonBucket } : {}),
          ...(isMarketRegimeLabel(row.market_regime_label)
            ? { marketRegimeLabel: row.market_regime_label }
            : {}),
          ...(isMissAutopsyCause(row.miss_autopsy_cause)
            ? { missAutopsyCause: row.miss_autopsy_cause }
            : {}),
        };
      });
  });
}

export async function loadConditionalCalibrationCountsFromIndex(
  dataDir: string,
): Promise<ConditionalCalibrationSummary | undefined> {
  return await withFreshIndex(dataDir, async (db) => {
    const rows = db
      .query(
        `SELECT r.asset_class, p.measurable_as, r.generated_at, s.forecast_origin
        FROM predictions p
        JOIN scores s ON p.run_id = s.run_id AND p.id = s.prediction_id
        JOIN runs r ON r.run_id = p.run_id
        WHERE p.kind = 'conditional' AND s.status = 'voided' AND s.scoring_version = 3`,
      )
      .all() as readonly {
      readonly asset_class: AssetClass;
      readonly measurable_as: string;
      readonly generated_at: string;
      readonly forecast_origin: string | null;
    }[];
    const voidedEvents = new Set(
      rows
        .filter((row) => hasParseableGeneratedAt(row))
        .map((row) =>
          forecastEventKey(
            row.asset_class,
            row.measurable_as,
            row.generated_at,
            row.forecast_origin ?? undefined,
          ),
        ),
    );
    // Activated conditionals are the resolved conditional pairs already passed
    // Into buildCalibrationSummary; this query only supplies excluded voids.
    return { activatedCount: 0, voidedCount: voidedEvents.size };
  });
}

interface WatchlistPredictionQueryRow {
  readonly id: string;
  readonly measurable_as: string;
  readonly subject: string;
  readonly resolved: number | null;
  readonly status: string | null;
  readonly outcome: string | null;
  readonly observed_at: string | null;
  readonly generated_at: string | null;
}

function predictionSymbolsForRow(row: WatchlistPredictionQueryRow): readonly string[] | undefined {
  try {
    return instrumentsForExpression(parseObservableExpression(row.measurable_as)).map((symbol) =>
      symbol.toUpperCase(),
    );
  } catch {
    return undefined;
  }
}

function predictionMatchesInstrument(row: WatchlistPredictionQueryRow, symbol: string): boolean {
  const parsedSymbols = predictionSymbolsForRow(row);
  return parsedSymbols === undefined
    ? row.subject.toUpperCase() === symbol
    : parsedSymbols.includes(symbol);
}

// Open = unscored (no score row) or a non-terminal status; a row without status is malformed, not open.
function isOpenWatchlistPrediction(row: WatchlistPredictionQueryRow): boolean {
  if (row.resolved === null) {
    return true;
  }
  const status = readPredictionScoreStatus(row.status);
  return status !== undefined && !isTerminal(status);
}

// Symbol-less multi-subject runs (Forecast Grid, market overview) count when a prediction's primary subject matches.
const INSTRUMENT_RUNS_WHERE = `asset_class = ? AND (symbol = ? OR (symbol IS NULL AND run_id IN (
  SELECT run_id FROM predictions WHERE upper(subject) = ?3 OR upper(subject) LIKE ?4)))`;

function instrumentWatchlistRow(
  db: Database,
  assetClass: string,
  symbol: string,
): WatchlistRowState {
  const normalizedSymbol = symbol.toUpperCase();
  const runParams = [assetClass, normalizedSymbol, normalizedSymbol, `${normalizedSymbol}:%`];
  const latest = db
    .query(
      `SELECT run_id AS runId, generated_at AS generatedAt, depth
       FROM runs WHERE ${INSTRUMENT_RUNS_WHERE}
       ORDER BY generated_at DESC, run_dir_name DESC LIMIT 1`,
    )
    .get(...runParams) as {
    readonly runId: string;
    readonly generatedAt: string | null;
    readonly depth: string | null;
  } | null;
  if (latest === null) {
    return { state: "never-run" };
  }

  const predictions = db
    .query(
      `SELECT p.id, p.measurable_as, p.subject, s.resolved, s.status, s.outcome,
              s.observed_at, r.generated_at
       FROM predictions p
       LEFT JOIN scores s ON s.run_id = p.run_id AND s.prediction_id = p.id
       JOIN runs r ON r.run_id = p.run_id
       WHERE p.run_id IN (SELECT run_id FROM runs WHERE ${INSTRUMENT_RUNS_WHERE})`,
    )
    .all(...runParams) as readonly WatchlistPredictionQueryRow[];

  let openPredictionCount = 0;
  let latestCalibration: { readonly outcome: "hit" | "miss"; readonly at: string } | undefined =
    undefined;
  for (const row of predictions) {
    if (!predictionMatchesInstrument(row, normalizedSymbol)) {
      continue;
    }
    if (isOpenWatchlistPrediction(row)) {
      openPredictionCount += 1;
      continue;
    }
    if (row.outcome !== "hit" && row.outcome !== "miss") {
      continue;
    }
    const at = row.observed_at ?? row.generated_at;
    if (at === null || (latestCalibration !== undefined && at <= latestCalibration.at)) {
      continue;
    }
    latestCalibration = { outcome: row.outcome, at };
  }

  return {
    state: "available",
    latestRunId: latest.runId,
    ...(latest.generatedAt !== null ? { latestRunAt: latest.generatedAt } : {}),
    ...(latest.depth !== null ? { depth: latest.depth } : {}),
    openPredictionCount,
    ...(latestCalibration !== undefined ? { latestCalibration } : {}),
  };
}

export async function readInstrumentWatchlistRows(
  dataDir: string,
  instruments: readonly { readonly assetClass: string; readonly symbol: string }[],
): Promise<readonly WatchlistRowState[] | undefined> {
  // Undefined overall means the index is unavailable; every item then declares index-unavailable.
  return await withFreshIndex(dataDir, async (db) =>
    instruments.map((instrument) =>
      instrumentWatchlistRow(db, instrument.assetClass, instrument.symbol),
    ),
  );
}

export interface LatestSuccessfulInstrumentRun {
  readonly runId: string;
  readonly runDirName: string;
  readonly generatedAt: string | null;
}

export async function readLatestSuccessfulInstrumentRuns(
  dataDir: string,
  instruments: readonly { readonly assetClass: string; readonly symbol: string }[],
): Promise<readonly (LatestSuccessfulInstrumentRun | null)[] | undefined> {
  // Failed runs carry no symbol in the index, so the status filter is defensive.
  return await withFreshIndex(dataDir, async (db) =>
    instruments.map(
      (instrument) =>
        db
          .query(
            `SELECT run_id AS runId, run_dir_name AS runDirName, generated_at AS generatedAt
             FROM runs
             WHERE asset_class = ? AND symbol = ? AND report_status != 'failed'
             ORDER BY generated_at DESC, run_dir_name DESC
             LIMIT 1`,
          )
          .get(
            instrument.assetClass,
            instrument.symbol.toUpperCase(),
          ) as LatestSuccessfulInstrumentRun | null,
    ),
  );
}
