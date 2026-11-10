import type { AssetClass, JobType } from "./domain/job-type";
import type { ReportSearchScope } from "./report-search-entries";
import type { ArtifactFileStatus } from "./run-artifact-layout";

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
  readonly evidence_quality: string | null;
  readonly depth: string | null;
  readonly market_regime_label: string | null;
  readonly horizon_trading_days: number | null;
  readonly finding_count: number;
  readonly prediction_count: number;
  readonly source_count: number;
  readonly data_gap_count: number;
  readonly has_score: number;
  readonly report_status: string;
  readonly score_status: string;
  readonly outcomes_status: ArtifactFileStatus;
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
  readonly origin: string | null;
  readonly baseline_probability: number | null;
  readonly baseline_version: string | null;
  readonly info_cutoff: string | null;
}

export interface ScoreRow {
  readonly prediction_id: string;
  readonly run_id: string;
  readonly resolved: number;
  readonly status: string | null;
  readonly outcome: string | null;
  readonly observed_at: string | null;
  readonly scoring_version: number | null;
  readonly miss_autopsy_cause: string | null;
  readonly forecast_origin: string | null;
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

export interface SubsystemOutcomeRow {
  readonly run_id: string;
  readonly subsystem: string;
  readonly expectation: string;
  readonly outcome: string;
  readonly code: string;
  readonly stage: string | null;
  readonly count: number | null;
  readonly detail_json: string | null;
}

export interface RunIndexRows {
  readonly run: RunRow;
  readonly files: readonly ArtifactFileRow[];
  readonly searchEntries: readonly SearchEntryRow[];
  readonly predictions: readonly PredictionRow[];
  readonly scores: readonly ScoreRow[];
  readonly outcomes: readonly SubsystemOutcomeRow[];
}

export interface RebuildOptions {
  readonly dbPath?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly generatedAt?: string;
  readonly jobType?: string;
  readonly assetClass?: string;
  readonly symbol?: string;
  readonly depth?: string;
  readonly confidence?: string;
  readonly findingCount: number;
  readonly predictionCount: number;
  readonly sourceCount: number;
  readonly dataGapCount: number;
  readonly hasScore: boolean;
  readonly availableFiles: readonly string[];
}

export type WatchlistRowState =
  | {
      readonly state: "available";
      readonly latestRunId: string;
      readonly latestRunAt?: string;
      readonly depth?: string;
      readonly openPredictionCount: number;
      readonly latestCalibration?: {
        readonly outcome: "hit" | "miss";
        readonly at: string;
      };
    }
  | { readonly state: "never-run" }
  | { readonly state: "index-unavailable" };

export interface RunSearchFilters {
  readonly query: string;
  readonly symbol?: string;
  readonly assetClass?: string;
  readonly jobType?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface RunSearchResult {
  readonly run: RunSummary;
  readonly section: RunSearchSection;
  readonly label: string;
  readonly snippet: string;
  readonly sourceIds: readonly string[];
}

export type RunSearchSection =
  | "summary"
  | "keyFindings"
  | "bullCase"
  | "bearCase"
  | "risks"
  | "catalysts"
  | "researchLeads"
  | "rejectedCandidates"
  | "predictions"
  | "sources"
  | "dataGaps"
  | "extendedEvidence"
  | "scenarios";
