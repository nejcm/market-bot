import type { RunSummary } from "../types";

interface InstrumentRunGroup {
  readonly key: string;
  readonly assetClass: string;
  readonly symbol: string;
  readonly head: RunSummary;
  readonly pastRuns: readonly RunSummary[];
}

export type InstrumentRunHistoryEntry =
  | { readonly kind: "group"; readonly group: InstrumentRunGroup }
  | { readonly kind: "run"; readonly run: RunSummary };

export interface InstrumentRunHistoryRow {
  readonly kind: "standalone" | "head" | "past";
  readonly run: RunSummary;
  readonly group?: InstrumentRunGroup;
  readonly expanded?: boolean;
}

function instrumentKey(
  assetClass: string | undefined,
  symbol: string | undefined,
): string | undefined {
  const classKey = assetClass?.trim();
  const symbolKey = symbol?.trim();
  return classKey === undefined || classKey === "" || symbolKey === undefined || symbolKey === ""
    ? undefined
    : `${classKey}:${symbolKey.toUpperCase()}`;
}

function generatedTime(run: RunSummary): number {
  if (run.generatedAt === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const date = new Date(run.generatedAt);
  return Number.isNaN(date.getTime()) ? Number.NEGATIVE_INFINITY : date.getTime();
}

function newestFirst(left: number, right: number): number {
  return left === right ? 0 : right - left;
}

function entryTime(entry: InstrumentRunHistoryEntry): number {
  return entry.kind === "group" ? generatedTime(entry.group.head) : generatedTime(entry.run);
}

// Every Run Artifact for one Instrument, newest first; runs without an Instrument stand alone.
export function instrumentRunHistory(
  runs: readonly RunSummary[],
): readonly InstrumentRunHistoryEntry[] {
  const buckets = new Map<string, { assetClass: string; symbol: string; runs: RunSummary[] }>();
  for (const run of runs) {
    const key = instrumentKey(run.assetClass, run.symbol);
    if (key === undefined) {
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { assetClass: run.assetClass ?? "", symbol: run.symbol ?? "", runs: [run] });
      continue;
    }
    bucket.runs.push(run);
  }

  const entries: InstrumentRunHistoryEntry[] = [];
  const emitted = new Set<string>();
  for (const run of runs) {
    const key = instrumentKey(run.assetClass, run.symbol);
    if (key === undefined) {
      entries.push({ kind: "run", run });
      continue;
    }
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      continue;
    }
    const members = bucket.runs.toSorted((left, right) =>
      newestFirst(generatedTime(left), generatedTime(right)),
    );
    const [head] = members;
    if (head === undefined) {
      continue;
    }
    entries.push({
      kind: "group",
      group: {
        key,
        assetClass: bucket.assetClass,
        symbol: bucket.symbol,
        head,
        pastRuns: members.slice(1),
      },
    });
  }

  return entries.toSorted((left, right) => newestFirst(entryTime(left), entryTime(right)));
}

export function instrumentRunHistoryRows(
  entries: readonly InstrumentRunHistoryEntry[],
  expandedGroups: readonly string[],
): readonly InstrumentRunHistoryRow[] {
  const rows: InstrumentRunHistoryRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "run") {
      rows.push({ kind: "standalone", run: entry.run });
      continue;
    }
    const expanded = expandedGroups.includes(entry.group.key);
    rows.push({ kind: "head", run: entry.group.head, group: entry.group, expanded });
    if (!expanded) {
      continue;
    }
    for (const run of entry.group.pastRuns) {
      rows.push({ kind: "past", run });
    }
  }
  return rows;
}

// Every run for one Instrument, newest first, or an empty list when it has none.
export function instrumentRunHistoryFor(
  entries: readonly InstrumentRunHistoryEntry[],
  assetClass: string,
  symbol: string,
): readonly RunSummary[] {
  const key = instrumentKey(assetClass, symbol);
  if (key === undefined) {
    return [];
  }
  for (const entry of entries) {
    if (entry.kind === "group" && entry.group.key === key) {
      return [entry.group.head, ...entry.group.pastRuns];
    }
  }
  return [];
}

// Key of the group that holds `runId` as a past run, when one does.
export function instrumentRunHistoryGroupKey(
  entries: readonly InstrumentRunHistoryEntry[],
  runId: string,
): string | undefined {
  for (const entry of entries) {
    if (entry.kind === "group" && entry.group.pastRuns.some((run) => run.runId === runId)) {
      return entry.group.key;
    }
  }
  return undefined;
}
