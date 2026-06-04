import type { RunSearchResult, RunSummary } from "../types";

export { predictions, scenarios, sources, stringArray, textItems } from "../report-artifact-view";

export interface SearchResultGroup {
  readonly run: RunSummary;
  readonly results: readonly RunSearchResult[];
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
