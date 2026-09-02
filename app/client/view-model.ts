import type { ProviderHealthDetail, RunSearchResult, RunSummary } from "../types";
import { RUN_ARTIFACT_FILES } from "../../src/run-artifact-layout";

export {
  extendedEvidenceItems,
  forecastDisagreements,
  forecastGroups,
  forecastRollup,
  predictionScores,
  predictionTargetHealth,
  predictions,
  scenarios,
  scoredForecasts,
  sources,
  stringArray,
  textItems,
} from "../report-artifact-view";

export { formatDate, formatDateMinute, runLabel } from "./view-model-format";

export {
  financialLensMetricTiles,
  financialLensStatTiles,
  valuationMetricTiles,
  type FinancialLensStatTile,
  type FinancialLensStatTone,
} from "./view-model-lens";

export {
  businessFrameworkView,
  webSubjectProfileView,
  type BusinessFrameworkView,
  type WebSubjectProfileView,
} from "./view-model-profile";

export {
  alphaCohortHeadline,
  alphaRejectionBucketRows,
  alphaStaleLeadRows,
  calibrationAutopsyCauses,
  calibrationHeadline,
  calibrationMetricNote,
  calibrationSampleWarning,
  calibrationSlices,
  historicalContextAuditView,
  reliabilityBins,
  runCompareCards,
  type CalibrationSliceGroup,
  type HistoricalContextAuditView,
  type ReliabilityBin,
  type RunCompareCard,
} from "./view-model-calibration";

export {
  closeLinePoints,
  formatClose,
  horizonMarkers,
  tradingViewSymbol,
  tradingViewUrl,
  verifiedSnapshotValue,
  verifiedSnapshotView,
  VERIFIED_SNAPSHOT_PATH,
  type SnapshotView,
} from "./view-model-snapshot";

const RUN_PATH_PREFIX = "/runs/";
const INSTRUMENT_PATH_PREFIX = "/instruments/";
const SIDEBAR_VIEW_PATHS = {
  dashboard: "/",
  search: "/search",
  jobs: "/jobs",
  calibration: "/calibration",
  "alpha-cohorts": "/alpha-cohorts",
  health: "/health",
} as const;

export type SidebarView = keyof typeof SIDEBAR_VIEW_PATHS;
const RECENT_RUN_LIMIT = 5;
const RUN_TYPE_ORDER = ["market-overview", "daily", "weekly", "equity", "crypto"];
const PROVIDER_GAP_KEYS = ["missingCredential", "fetchFailed", "yahooAuth", "other"];

export interface SearchResultGroup {
  readonly run: RunSummary;
  readonly results: readonly RunSearchResult[];
}

export interface RunTypeGroup {
  readonly type: string;
  readonly runs: readonly RunSummary[];
}

export interface DashboardMetrics {
  readonly totalRuns: number;
  readonly totalSources: number;
  readonly totalForecasts: number;
  readonly totalDataGaps: number;
  readonly scoredRuns: number;
  readonly equityRuns: number;
  readonly cryptoRuns: number;
  readonly averageConfidence: string;
}

export interface ProviderHealthRow {
  readonly provider: string;
  readonly route: string;
  readonly degraded: boolean;
  readonly total: number;
  readonly gaps: number;
  /** Runs where the endpoint reported `degraded` in analytics. A covered web-search fallback
   *  raises this without raising `gaps`: it deliberately emits no Source Gap. */
  readonly degradedRuns: number;
  readonly note: string;
}

export interface RunTrendPoint {
  readonly date: string;
  readonly runs: number;
  readonly forecasts: number;
  readonly sources: number;
  readonly dataGaps: number;
}

export function instrumentPath(assetClass: string, symbol: string): string {
  return `${INSTRUMENT_PATH_PREFIX}${encodeURIComponent(assetClass)}/${encodeURIComponent(
    symbol.toUpperCase(),
  )}`;
}

export function instrumentFromPathname(
  pathname: string,
): { readonly assetClass: string; readonly symbol: string } | undefined {
  if (!pathname.startsWith(INSTRUMENT_PATH_PREFIX)) {
    return undefined;
  }
  const parts = pathname.slice(INSTRUMENT_PATH_PREFIX.length).split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  try {
    const assetClass = decodeURIComponent(parts[0] ?? "");
    const symbol = decodeURIComponent(parts[1] ?? "");
    return assetClass === "" || symbol === ""
      ? undefined
      : { assetClass, symbol: symbol.toUpperCase() };
  } catch {
    return undefined;
  }
}

export function jsonBlock(value: Record<string, unknown> | undefined): string {
  return value === undefined ? "Not available" : JSON.stringify(value, null, 2);
}

export function runCountsLabel(run: RunSummary): string {
  return `${String(run.findingCount)} fnd · ${String(run.predictionCount)} fct · ${String(run.dataGapCount)} gap`;
}

export function isFailedRun(run: RunSummary): boolean {
  return run.availableFiles.includes(RUN_ARTIFACT_FILES.failure);
}

export function runPath(runId: string): string {
  return `${RUN_PATH_PREFIX}${encodeURIComponent(runId)}`;
}

export function sidebarViewPath(view: SidebarView): string {
  return SIDEBAR_VIEW_PATHS[view];
}

export function searchPath(query: string): string {
  return `${SIDEBAR_VIEW_PATHS.search}?${new URLSearchParams({ q: query.trim() }).toString()}`;
}

export function searchQueryFromSearchParams(search: string): string | undefined {
  const params = new URLSearchParams(search);
  return params.has("q") ? (params.get("q") ?? "") : undefined;
}

export function sidebarViewFromPathname(pathname: string): SidebarView | undefined {
  return (Object.entries(SIDEBAR_VIEW_PATHS) as readonly [SidebarView, string][]).find(
    ([, path]) => path === pathname,
  )?.[0];
}

export function runIdFromPathname(pathname: string): string | undefined {
  if (!pathname.startsWith(RUN_PATH_PREFIX)) {
    return undefined;
  }

  const encodedRunId = pathname.slice(RUN_PATH_PREFIX.length);
  if (encodedRunId === "" || encodedRunId.includes("/")) {
    return undefined;
  }

  try {
    const runId = decodeURIComponent(encodedRunId);
    return runId === "" ? undefined : runId;
  } catch {
    return undefined;
  }
}

export function recentRunSummaries(
  runs: readonly RunSummary[],
  limit: number = RECENT_RUN_LIMIT,
): readonly RunSummary[] {
  return runs.slice(0, Math.max(0, limit));
}

export function filterRuns(
  runs: readonly RunSummary[],
  typeFilter: string,
  queryText: string,
): readonly RunSummary[] {
  return runs.filter(
    (run) =>
      (typeFilter === "all" || (run.jobType ?? "run") === typeFilter) &&
      (queryText.trim() === "" || matchesQuery(run, queryText)),
  );
}

export function providerHealthRows(detail: ProviderHealthDetail): readonly ProviderHealthRow[] {
  const routes = detail.summary?.routes;
  if (!Array.isArray(routes)) {
    return [];
  }

  return routes
    .filter(
      (route): route is Record<string, unknown> =>
        typeof route === "object" && route !== null && !Array.isArray(route),
    )
    .map((route) => {
      const gaps = PROVIDER_GAP_KEYS.reduce((sum, key) => sum + readCount(route, key), 0);
      const degradedRuns = readCount(route, "degraded");
      const { sampleMessages } = route;
      const note =
        Array.isArray(sampleMessages) && typeof sampleMessages[0] === "string"
          ? sampleMessages[0]
          : "";

      return {
        provider: typeof route.provider === "string" ? route.provider : "unknown",
        route: typeof route.route === "string" ? route.route : "",
        degraded: gaps > 0 || degradedRuns > 0,
        total: readCount(route, "total"),
        gaps,
        degradedRuns,
        note,
      };
    });
}

function readCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

export function matchesQuery(run: RunSummary, text: string): boolean {
  const haystack = [run.runId, run.jobType, run.assetClass, run.symbol, run.depth, run.confidence]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  return haystack.includes(text.trim().toLowerCase());
}

export function groupedRunsByType(runs: readonly RunSummary[]): readonly RunTypeGroup[] {
  const groups = new Map<string, RunSummary[]>();

  for (const run of runs) {
    const type = run.jobType ?? "run";
    groups.set(type, [...(groups.get(type) ?? []), run]);
  }

  return [...groups.entries()]
    .toSorted(([left], [right]) => runTypeRank(left) - runTypeRank(right))
    .map(([type, groupedRuns]) => ({
      type,
      runs: groupedRuns,
    }));
}

function runTypeRank(type: string): number {
  const index = RUN_TYPE_ORDER.indexOf(type);
  return index === -1 ? RUN_TYPE_ORDER.length : index;
}

export function dashboardMetrics(runs: readonly RunSummary[]): DashboardMetrics {
  const confidenceValues = runs
    .map((run) => confidenceRank(run.confidence))
    .filter((value): value is number => value !== undefined);
  const averageConfidence =
    confidenceValues.length === 0
      ? "unknown"
      : confidenceLabel(
          confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length,
        );

  return {
    totalRuns: runs.length,
    totalSources: runs.reduce((sum, run) => sum + run.sourceCount, 0),
    totalForecasts: runs.reduce((sum, run) => sum + run.predictionCount, 0),
    totalDataGaps: runs.reduce((sum, run) => sum + run.dataGapCount, 0),
    scoredRuns: runs.filter((run) => run.hasScore).length,
    equityRuns: runs.filter((run) => run.assetClass === "equity").length,
    cryptoRuns: runs.filter((run) => run.assetClass === "crypto").length,
    averageConfidence,
  };
}

export function runTrend(runs: readonly RunSummary[], bucketLimit = 14): readonly RunTrendPoint[] {
  const buckets = new Map<string, RunTrendPoint>();

  for (const run of runs) {
    const date = dateKey(run.generatedAt);
    if (date === undefined) {
      continue;
    }

    const current = buckets.get(date) ?? {
      date,
      runs: 0,
      forecasts: 0,
      sources: 0,
      dataGaps: 0,
    };

    buckets.set(date, {
      date,
      runs: current.runs + 1,
      forecasts: current.forecasts + run.predictionCount,
      sources: current.sources + run.sourceCount,
      dataGaps: current.dataGaps + run.dataGapCount,
    });
  }

  return [...buckets.values()]
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .slice(Math.max(0, buckets.size - bucketLimit));
}

export function groupedSearchResults(
  results: readonly RunSearchResult[],
): readonly SearchResultGroup[] {
  const groups = new Map<string, { run: RunSummary; results: RunSearchResult[] }>();

  for (const result of results) {
    const group = groups.get(result.run.runId);
    if (group === undefined) {
      groups.set(result.run.runId, { run: result.run, results: [result] });
      continue;
    }

    groups.set(result.run.runId, { run: group.run, results: [...group.results, result] });
  }

  return [...groups.values()];
}

function dateKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function confidenceRank(value: string | undefined): number | undefined {
  if (value === "low") {
    return 1;
  }

  if (value === "medium") {
    return 2;
  }

  if (value === "high") {
    return 3;
  }

  return undefined;
}

function confidenceLabel(value: number): string {
  if (value >= 2.5) {
    return "high";
  }

  if (value >= 1.5) {
    return "medium";
  }

  return "low";
}
