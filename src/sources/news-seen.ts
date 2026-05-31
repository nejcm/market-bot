import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResearchCommand } from "../cli/args";
import type { Source, SourceGap } from "../domain/types";
import { isRecord } from "./guards";
import { canonicalizeUrl } from "./news-utils";

export interface NewsSeenEntry {
  readonly lane: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly provider?: string;
}

interface NewsSeenIndex {
  readonly version: 1;
  readonly entries: readonly NewsSeenEntry[];
}

export interface FilterSeenNewsOptions {
  readonly path: string;
  readonly retentionDays: number;
  readonly command: ResearchCommand;
  readonly now: Date;
}

export interface FilterSeenNewsResult {
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface RecordSeenNewsOptions {
  readonly path: string;
  readonly retentionDays: number;
  readonly command: ResearchCommand;
  readonly runId: string;
  readonly seenAt: string;
  readonly sources: readonly Source[];
}

const INDEX_VERSION = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function newsSeenLane(command: ResearchCommand): string {
  if (command.jobType === "ticker") {
    return `ticker:${command.assetClass}:${command.symbol.trim().toUpperCase()}`;
  }

  return `${command.jobType}:${command.assetClass}`;
}

function ageDays(now: Date, then: string): number {
  const parsed = Date.parse(then);
  if (!Number.isFinite(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.floor((now.getTime() - parsed) / MS_PER_DAY);
}

function isFresh(entry: NewsSeenEntry, now: Date, retentionDays: number): boolean {
  return ageDays(now, entry.lastSeenAt) <= retentionDays;
}

function readEntry(value: unknown): NewsSeenEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.lane !== "string" ||
    typeof value.canonicalUrl !== "string" ||
    typeof value.title !== "string" ||
    typeof value.firstRunId !== "string" ||
    typeof value.lastRunId !== "string" ||
    typeof value.firstSeenAt !== "string" ||
    typeof value.lastSeenAt !== "string"
  ) {
    return undefined;
  }

  return {
    lane: value.lane,
    canonicalUrl: value.canonicalUrl,
    title: value.title,
    firstRunId: value.firstRunId,
    lastRunId: value.lastRunId,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
  };
}

export async function readNewsSeenEntries(path: string): Promise<readonly NewsSeenEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
      return [];
    }

    return parsed.entries
      .map(readEntry)
      .filter((entry): entry is NewsSeenEntry => entry !== undefined);
  } catch {
    return [];
  }
}

async function writeNewsSeenIndex(path: string, index: NewsSeenIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function toCanonical(source: Source): string | undefined {
  return source.canonicalUrl ?? canonicalizeUrl(source.url);
}

function newestFirst(left: Source, right: Source): number {
  return Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt);
}

export async function filterSeenNewsSources(
  sources: readonly Source[],
  options: FilterSeenNewsOptions,
): Promise<FilterSeenNewsResult> {
  const lane = newsSeenLane(options.command);
  const entries = await readNewsSeenEntries(options.path);
  const seen = new Set(
    entries
      .filter((entry) => entry.lane === lane && isFresh(entry, options.now, options.retentionDays))
      .map((entry) => entry.canonicalUrl),
  );

  const newsSources = sources.filter((source) => {
    const canonicalUrl = toCanonical(source);
    return canonicalUrl === undefined || !seen.has(canonicalUrl);
  });

  if (newsSources.length > 0 || sources.length === 0) {
    return { newsSources, sourceGaps: [] };
  }

  const repeatFallback = sources.toSorted(newestFirst).slice(0, 1);
  return {
    newsSources: repeatFallback,
    sourceGaps: [
      {
        source: "news-seen",
        message: `Persistent news dedupe suppressed ${String(sources.length)} repeat source(s) for ${lane}; kept one repeat fallback`,
      },
    ],
  };
}

function pruneEntries(
  entries: readonly NewsSeenEntry[],
  now: Date,
  retentionDays: number,
): readonly NewsSeenEntry[] {
  return entries.filter((entry) => isFresh(entry, now, retentionDays));
}

export async function recordSeenNewsSources(options: RecordSeenNewsOptions): Promise<void> {
  const lane = newsSeenLane(options.command);
  const now = new Date(options.seenAt);
  const existing = pruneEntries(
    await readNewsSeenEntries(options.path),
    now,
    options.retentionDays,
  );
  const entriesByKey = new Map<string, NewsSeenEntry>(
    existing.map((entry) => [`${entry.lane}\n${entry.canonicalUrl}`, entry] as const),
  );

  for (const source of options.sources.filter((item) => item.kind === "news")) {
    const canonicalUrl = toCanonical(source);
    if (canonicalUrl === undefined) {
      continue;
    }

    const key = `${lane}\n${canonicalUrl}`;
    const current = entriesByKey.get(key);
    const provider = source.provider ?? current?.provider;
    entriesByKey.set(key, {
      lane,
      canonicalUrl,
      title: source.title,
      firstRunId: current?.firstRunId ?? options.runId,
      lastRunId: options.runId,
      firstSeenAt: current?.firstSeenAt ?? options.seenAt,
      lastSeenAt: options.seenAt,
      ...(provider !== undefined ? { provider } : {}),
    });
  }

  const index: NewsSeenIndex = {
    version: INDEX_VERSION,
    entries: [...entriesByKey.values()].toSorted((left, right) =>
      `${left.lane}\n${left.canonicalUrl}`.localeCompare(`${right.lane}\n${right.canonicalUrl}`),
    ),
  };

  await writeNewsSeenIndex(options.path, index);
}
