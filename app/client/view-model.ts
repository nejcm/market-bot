import type { RunSearchResult, RunSummary } from "../types";

export interface TextWithSources {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface ScenarioView {
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface PredictionView {
  readonly id: string;
  readonly claim: string;
  readonly kind?: string;
  readonly probability?: number;
  readonly horizonTradingDays?: number;
  readonly sourceIds: readonly string[];
}

export interface SourceView {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly provider?: string;
  readonly url?: string;
}

export interface SearchResultGroup {
  readonly run: RunSummary;
  readonly results: readonly RunSearchResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
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

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readSourceIds(record: Record<string, unknown>): readonly string[] {
  const { sourceIds } = record;
  return Array.isArray(sourceIds)
    ? sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
    : [];
}

export function textItems(
  report: Record<string, unknown> | undefined,
  key: string,
): readonly TextWithSources[] {
  const value = report?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const text = readString(item, "text");
      return text === undefined ? [] : [{ text, sourceIds: readSourceIds(item) }];
    });
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
        : [{ name, description, sourceIds: readSourceIds(item) }];
    });
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
      const claim = readString(item, "claim");
      const kind = readString(item, "kind");
      const probability = readNumber(item, "probability");
      const horizonTradingDays = readNumber(item, "horizonTradingDays");
      return id === undefined || claim === undefined
        ? []
        : [
            {
              id,
              claim,
              ...(kind !== undefined ? { kind } : {}),
              ...(probability !== undefined ? { probability } : {}),
              ...(horizonTradingDays !== undefined ? { horizonTradingDays } : {}),
              sourceIds: readSourceIds(item),
            },
          ];
    });
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

export function stringArray(
  report: Record<string, unknown> | undefined,
  key: string,
): readonly string[] {
  const value = report?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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

    group.results.push(result);
  }

  return [...groups.values()];
}
