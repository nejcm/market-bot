import type { RunSearchResult, RunSummary } from "../types";

export { predictions, scenarios, sources, stringArray, textItems } from "../report-artifact-view";

export interface SearchResultGroup {
  readonly run: RunSummary;
  readonly results: readonly RunSearchResult[];
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

export interface RunTrendPoint {
  readonly date: string;
  readonly runs: number;
  readonly forecasts: number;
  readonly sources: number;
  readonly dataGaps: number;
}

export function jsonBlock(value: Record<string, unknown> | undefined): string {
  return value === undefined ? "Not available" : JSON.stringify(value, null, 2);
}

export function runLabel(run: RunSummary): string {
  const subject = run.symbol ?? run.assetClass ?? "unknown";
  return `${run.jobType ?? "run"} / ${subject}`;
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function matchesQuery(run: RunSummary, text: string): boolean {
  const haystack = [run.runId, run.jobType, run.assetClass, run.symbol, run.depth, run.confidence]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();

  return haystack.includes(text.trim().toLowerCase());
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
