import type {
  CalibrationDetail,
  ProviderHealthDetail,
  RunSearchResult,
  RunSummary,
} from "../types";

export {
  forecastRollup,
  predictionScores,
  predictions,
  scenarios,
  scoredForecasts,
  sources,
  stringArray,
  textItems,
} from "../report-artifact-view";
export type { ForecastRollup, PredictionScoreView, ScoredForecast } from "../report-artifact-view";

const RUN_PATH_PREFIX = "/runs/";
const RECENT_RUN_LIMIT = 5;
const RUN_TYPE_ORDER = ["daily", "weekly", "ticker"];
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
  readonly note: string;
}

export interface RunTrendPoint {
  readonly date: string;
  readonly runs: number;
  readonly forecasts: number;
  readonly sources: number;
  readonly dataGaps: number;
}

export interface CalibrationHeadline {
  readonly brierScore?: number;
  readonly brierSkillScore?: number;
  readonly resolvedCount: number;
  readonly generatedAt?: string;
}

export interface ReliabilityBin {
  readonly label: string;
  readonly pLow: number;
  readonly pHigh: number;
  readonly hitRate: number;
  readonly hitCount: number;
  readonly totalCount: number;
}

export interface CalibrationSliceRow {
  readonly key: string;
  readonly brierScore: number;
  readonly count: number;
}

export type CalibrationSliceGroup =
  | "byKind"
  | "byAssetClass"
  | "byJobType"
  | "byMarketUpdateCadence"
  | "byHorizonBucket";

const HORIZON_BUCKET_ORDER = ["1-5d", "6-10d", "11-15d", "16-20d"];

export function calibrationHeadline(detail: CalibrationDetail): CalibrationHeadline {
  const summary = detail.summary ?? {};
  const brierScore = readFiniteNumber(summary.brierScore);
  const brierSkillScore = readFiniteNumber(summary.brierSkillScore);
  const generatedAt = typeof summary.generatedAt === "string" ? summary.generatedAt : undefined;
  return {
    ...(brierScore !== undefined ? { brierScore } : {}),
    ...(brierSkillScore !== undefined ? { brierSkillScore } : {}),
    resolvedCount: readFiniteNumber(summary.resolvedCount) ?? 0,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
  };
}

export function reliabilityBins(detail: CalibrationDetail): readonly ReliabilityBin[] {
  const bins = detail.summary?.bins;
  if (!Array.isArray(bins)) {
    return [];
  }

  return bins
    .filter(
      (bin): bin is Record<string, unknown> =>
        typeof bin === "object" && bin !== null && !Array.isArray(bin),
    )
    .flatMap((bin) => {
      const pLow = readFiniteNumber(bin.pLow);
      const pHigh = readFiniteNumber(bin.pHigh);
      const hitRate = readFiniteNumber(bin.hitRate);
      const hitCount = readFiniteNumber(bin.hitCount);
      const totalCount = readFiniteNumber(bin.totalCount);
      const label = typeof bin.label === "string" ? bin.label : undefined;
      return pLow === undefined ||
        pHigh === undefined ||
        hitRate === undefined ||
        hitCount === undefined ||
        totalCount === undefined ||
        label === undefined
        ? []
        : [{ label, pLow, pHigh, hitRate, hitCount, totalCount }];
    })
    .toSorted((left, right) => left.pLow - right.pLow);
}

export function calibrationSlices(
  detail: CalibrationDetail,
  group: CalibrationSliceGroup,
): readonly CalibrationSliceRow[] {
  const slice = detail.summary?.[group];
  if (typeof slice !== "object" || slice === null || Array.isArray(slice)) {
    return [];
  }

  const rows = Object.entries(slice).flatMap(([key, metric]) => {
    if (typeof metric !== "object" || metric === null || Array.isArray(metric)) {
      return [];
    }

    const record = metric as Record<string, unknown>;
    const brierScore = readFiniteNumber(record.brierScore);
    const count = readFiniteNumber(record.count);
    return brierScore === undefined || count === undefined ? [] : [{ key, brierScore, count }];
  });

  return group === "byHorizonBucket"
    ? rows.toSorted((left, right) => horizonBucketRank(left.key) - horizonBucketRank(right.key))
    : rows.toSorted((left, right) => right.count - left.count);
}

function horizonBucketRank(bucket: string): number {
  const index = HORIZON_BUCKET_ORDER.indexOf(bucket);
  return index === -1 ? HORIZON_BUCKET_ORDER.length : index;
}

export const VERIFIED_SNAPSHOT_PATH = "normalized/verified-market-snapshot.json";

export interface SnapshotClose {
  readonly date: string;
  readonly close: number;
}

export interface SnapshotView {
  readonly symbol: string;
  readonly analysisDate?: string;
  readonly latestSessionDate?: string;
  readonly indicators: Readonly<Record<string, number>>;
  readonly recentCloses: readonly SnapshotClose[];
}

export interface CloseLinePoint {
  readonly x: number;
  readonly y: number;
  readonly date: string;
  readonly close: number;
}

export function verifiedSnapshotView(content: string): SnapshotView | undefined {
  const parsed = parseJson(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const symbol = typeof record.symbol === "string" ? record.symbol : undefined;
  const recentCloses = snapshotCloses(record.recentCloses);
  if (symbol === undefined || recentCloses.length < 2) {
    return undefined;
  }

  const analysisDate = typeof record.analysisDate === "string" ? record.analysisDate : undefined;
  const latestSessionDate =
    typeof record.latestSessionDate === "string" ? record.latestSessionDate : undefined;
  return {
    symbol,
    ...(analysisDate !== undefined ? { analysisDate } : {}),
    ...(latestSessionDate !== undefined ? { latestSessionDate } : {}),
    indicators: snapshotIndicators(record.indicators),
    recentCloses,
  };
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function snapshotCloses(value: unknown): readonly SnapshotClose[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const close = readFiniteNumber(record.close);
    return typeof record.date === "string" && close !== undefined
      ? [{ date: record.date, close }]
      : [];
  });
}

function snapshotIndicators(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const indicator = readFiniteNumber(entry);
      return indicator === undefined ? [] : [[key, indicator] as const];
    }),
  );
}

export function closeLinePoints(
  closes: readonly SnapshotClose[],
  plotLeft: number,
  plotWidth: number,
  plotTop: number,
  plotHeight: number,
): readonly CloseLinePoint[] {
  if (closes.length === 0) {
    return [];
  }

  const values = closes.map((entry) => entry.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return closes.map((entry, index) => ({
    x: plotLeft + (closes.length === 1 ? 0 : (index * plotWidth) / (closes.length - 1)),
    y:
      range === 0 ? plotTop + plotHeight / 2 : plotTop + ((max - entry.close) / range) * plotHeight,
    date: entry.date,
    close: entry.close,
  }));
}

export function horizonMarkers(
  forecasts: readonly { readonly horizonTradingDays?: number }[],
): readonly number[] {
  return [
    ...new Set(
      forecasts
        .map((forecast) => forecast.horizonTradingDays)
        .filter((horizon): horizon is number => horizon !== undefined && horizon > 0),
    ),
  ].toSorted((left, right) => left - right);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatClose(value: number): string {
  return Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(4);
}

export function jsonBlock(value: Record<string, unknown> | undefined): string {
  return value === undefined ? "Not available" : JSON.stringify(value, null, 2);
}

export function runLabel(run: RunSummary): string {
  const subject = run.symbol ?? run.assetClass ?? "unknown";
  return `${run.jobType ?? "run"} / ${subject}`;
}

export function runCountsLabel(run: RunSummary): string {
  return `${String(run.findingCount)} fnd · ${String(run.predictionCount)} fct · ${String(run.dataGapCount)} gap`;
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatDateMinute(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
}

export function runPath(runId: string): string {
  return `${RUN_PATH_PREFIX}${encodeURIComponent(runId)}`;
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
      const { sampleMessages } = route;
      const note =
        Array.isArray(sampleMessages) && typeof sampleMessages[0] === "string"
          ? sampleMessages[0]
          : "";

      return {
        provider: typeof route.provider === "string" ? route.provider : "unknown",
        route: typeof route.route === "string" ? route.route : "",
        degraded: gaps > 0,
        total: readCount(route, "total"),
        gaps,
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
