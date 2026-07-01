import type { RunSearchFilters, RunSearchResult, RunSearchSection, RunSummary } from "../app/types";
import { renderClaimForMeasurableAs } from "./forecast/observable";
import type { ReportSearchCandidate } from "./report-search-entries";
import { RUN_ARTIFACT_FILES } from "./run-artifact-layout";
import type { RunRow, SearchEntryRow } from "./run-artifact-index-types";
import { isRecord, parseStringArrayJson, readNumber, stringArrayValue } from "./sources/guards";

const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const SNIPPET_RADIUS = 72;
const PREDICTION_SHORTFALL_PREFIX = "predictionShortfall:";

// Local, non-trimming string reader for summary projection.
// Values are preserved verbatim, unlike guards.readString which drops empty/whitespace.
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function arrayCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

// Shared with run-artifact-index-rows.ts: both read the same extras.depth field
// Off a parsed report, one for the disk summary path (untyped Record) and one for the
// Index row path (typed ResearchReport). The narrow parameter type accepts either.
export function readDepth(report: { readonly extras?: unknown }): string | undefined {
  const { extras } = report;
  return isRecord(extras) ? readString(extras, "depth") : undefined;
}

export function runSummaryFromReport(
  runId: string,
  report: Record<string, unknown> | undefined,
  availableFiles: readonly string[],
): RunSummary {
  const generatedAt = report === undefined ? undefined : readString(report, "generatedAt");
  const jobType = report === undefined ? undefined : readString(report, "jobType");
  const assetClass = report === undefined ? undefined : readString(report, "assetClass");
  const symbol = report === undefined ? undefined : readString(report, "symbol");
  const depth = report === undefined ? undefined : readDepth(report);
  const confidence =
    report === undefined
      ? undefined
      : (readString(report, "evidenceQuality") ?? readString(report, "confidence"));

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

export function runSummaryFromIndexRow(row: RunRow, availableFiles: readonly string[]): RunSummary {
  return {
    runId: row.run_id,
    ...(row.generated_at !== null ? { generatedAt: row.generated_at } : {}),
    ...(row.job_type !== null ? { jobType: row.job_type } : {}),
    ...(row.asset_class !== null ? { assetClass: row.asset_class } : {}),
    ...(row.symbol !== null ? { symbol: row.symbol } : {}),
    ...(row.depth !== null ? { depth: row.depth } : {}),
    ...(row.evidence_quality !== null ? { confidence: row.evidence_quality } : {}),
    findingCount: row.finding_count,
    predictionCount: row.prediction_count,
    sourceCount: row.source_count,
    dataGapCount: row.data_gap_count,
    hasScore: row.has_score === 1,
    availableFiles,
  };
}

export function runSummaryMatchesFilters(
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

export function compareRunSummariesByRecency(left: RunSummary, right: RunSummary): number {
  return (
    (right.generatedAt ?? right.runId).localeCompare(left.generatedAt ?? left.runId) ||
    right.runId.localeCompare(left.runId)
  );
}

export function searchSnippet(text: string, query: string): string {
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

export function runSearchResultFromCandidate(
  run: RunSummary,
  candidate: ReportSearchCandidate,
  query: string,
): RunSearchResult {
  return {
    run,
    section: candidate.section,
    label: candidate.label,
    snippet: searchSnippet(candidate.text, query),
    sourceIds: candidate.sourceIds,
  };
}

export function runSearchResultFromIndexRow(
  row: SearchEntryRow,
  run: RunSummary,
  query: string,
): RunSearchResult {
  return {
    run,
    section: row.section as RunSearchSection,
    label: row.label,
    snippet: searchSnippet(row.text, query),
    sourceIds: parseStringArrayJson(row.source_ids_json),
  };
}

// The report-derived view projections below (scenarios, predictions, sources, data
// Gap helpers) previously lived in app/report-artifact-view.ts. They are moved here
// So all report-derived read projections share one module per ADR 0016; that file now
// Re-exports them for existing app/API callers. Score/analytics-derived views (forecast
// Disagreement, miss autopsies, prediction scores, target health) stay in
// App/report-artifact-view.ts — they read score.json/missAutopsy.json/extras alongside
// The report and are out of this phase's scope.

export interface ScenarioView {
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export function scenarios(report: Record<string, unknown> | undefined): readonly ScenarioView[] {
  const value = report?.scenarios;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const name = readString(item, "name");
      const description = readString(item, "description");
      return name === undefined || description === undefined
        ? []
        : [{ name, description, sourceIds: stringArrayValue(item.sourceIds) }];
    });
}

export interface PredictionView {
  readonly id: string;
  readonly claim: string;
  readonly kind?: string;
  readonly subject?: string;
  readonly measurableAs?: string;
  readonly probability?: number;
  readonly horizonTradingDays?: number;
  readonly sourceIds: readonly string[];
}

export function predictions(
  report: Record<string, unknown> | undefined,
): readonly PredictionView[] {
  const value = report?.predictions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const storedClaim = readString(item, "claim");
      const measurableAs = readString(item, "measurableAs");
      const claim =
        measurableAs === undefined
          ? storedClaim
          : renderClaimForMeasurableAs(measurableAs, storedClaim);
      const kind = readString(item, "kind");
      const subject = readString(item, "subject");
      const probability = readNumber(item, "probability");
      const horizonTradingDays = readNumber(item, "horizonTradingDays");
      return id === undefined || claim === undefined
        ? []
        : [
            {
              id,
              claim,
              ...(kind !== undefined ? { kind } : {}),
              ...(subject !== undefined ? { subject } : {}),
              ...(measurableAs !== undefined ? { measurableAs } : {}),
              ...(probability !== undefined ? { probability } : {}),
              ...(horizonTradingDays !== undefined ? { horizonTradingDays } : {}),
              sourceIds: stringArrayValue(item.sourceIds),
            },
          ];
    });
}

export interface SourceView {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly provider?: string;
  readonly url?: string;
}

function readHttpUrl(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key);
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function sources(report: Record<string, unknown> | undefined): readonly SourceView[] {
  const value = report?.sources;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const title = readString(item, "title");
      const kind = readString(item, "kind");
      const provider = readString(item, "provider");
      const url = readHttpUrl(item, "url");
      return id === undefined || title === undefined
        ? []
        : [
            {
              id,
              title,
              ...(kind !== undefined ? { kind } : {}),
              ...(provider !== undefined ? { provider } : {}),
              ...(url !== undefined ? { url } : {}),
            },
          ];
    });
}

export interface SplitDataGaps {
  readonly shortfalls: readonly string[];
  readonly otherGaps: readonly string[];
}

export function splitDataGaps(gaps: readonly string[]): SplitDataGaps {
  const shortfalls: string[] = [];
  const otherGaps: string[] = [];

  for (const gap of gaps) {
    if (gap.startsWith(PREDICTION_SHORTFALL_PREFIX)) {
      shortfalls.push(gap);
    } else {
      otherGaps.push(gap);
    }
  }

  return { shortfalls, otherGaps };
}

export function formatShortfallGap(gap: string): string {
  if (!gap.startsWith(PREDICTION_SHORTFALL_PREFIX)) {
    return gap;
  }

  const message = gap.slice(PREDICTION_SHORTFALL_PREFIX.length).trimStart();
  return message === "" ? gap : message;
}
