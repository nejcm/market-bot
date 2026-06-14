import type { AssetClass, JobType } from "./domain/types";
import type { ReportSearchScope } from "./report-search-entries";

export type SearchScope = ReportSearchScope;
export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

export interface ArtifactFileRow {
  readonly run_id: string;
  readonly path: string;
  readonly size: number;
  readonly modified_at: number;
}

export interface RunRow {
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

export interface PredictionRow {
  readonly id: string;
  readonly run_id: string;
  readonly kind: string;
  readonly subject: string;
  readonly claim: string;
  readonly probability: number;
  readonly horizon_trading_days: number;
  readonly measurable_as: string;
  readonly source_ids_json: string;
}

export interface ScoreRow {
  readonly prediction_id: string;
  readonly run_id: string;
  readonly resolved: number;
  readonly outcome: string | null;
  readonly observed_at: string | null;
  readonly scoring_version: number | null;
}

export interface SearchEntryRow {
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

export interface RunIndexRows {
  readonly run: RunRow;
  readonly files: readonly ArtifactFileRow[];
  readonly searchEntries: readonly SearchEntryRow[];
  readonly predictions: readonly PredictionRow[];
  readonly scores: readonly ScoreRow[];
}

export interface RebuildOptions {
  readonly dbPath?: string;
}
