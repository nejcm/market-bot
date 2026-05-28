import { readdirSync } from "node:fs";
import type { SourceGap } from "../domain/types";
import type { FetchJsonResult, FetchOrGapFn, RawSourceSnapshot } from "./types";

export type { FetchOrGapFn };

export interface CacheOptions {
  readonly dir: string;
  readonly disabled: boolean;
  readonly fallbackDays: number;
  readonly now: () => Date;
  readonly onStaleFallback: (gap: SourceGap) => void;
}

interface CacheEntry {
  readonly url: string;
  readonly adapter: string;
  readonly fetchedAt: string;
  readonly cachedDate: string;
  readonly payload: unknown;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function entryPath(dir: string, date: string, sha: string): string {
  return `${dir}/${date}/${sha}.json`;
}

function dateDiffDays(later: string, earlier: string): number {
  const diff = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.round(diff / (24 * 60 * 60 * 1000));
}

async function readEntry(path: string): Promise<CacheEntry | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return undefined;
    }

    return (await file.json()) as CacheEntry;
  } catch {
    return undefined;
  }
}

async function writeEntry(path: string, entry: CacheEntry): Promise<void> {
  try {
    await Bun.write(path, JSON.stringify(entry));
  } catch {
    // Cache write failures are non-fatal; the run continues without caching.
  }
}

function listDateDirs(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(d.name))
      .map((d) => d.name)
      .toSorted((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

async function findStaleFallback(
  dir: string,
  sha: string,
  today: string,
  fallbackDays: number,
): Promise<CacheEntry | undefined> {
  const candidateDirs = listDateDirs(dir).filter(
    (d) => d < today && dateDiffDays(today, d) <= fallbackDays,
  );

  const entries = await Promise.all(candidateDirs.map((d) => readEntry(entryPath(dir, d, sha))));

  return entries.find((e): e is CacheEntry => e !== undefined);
}

function toFetchJsonResult(entry: CacheEntry, adapter: string): FetchJsonResult {
  const rawSnapshot: RawSourceSnapshot = {
    id: `raw-${adapter}-${entry.fetchedAt}`,
    adapter,
    fetchedAt: entry.fetchedAt,
    payload: entry.payload,
  };

  return { rawSnapshot, payload: entry.payload };
}

export function withCache(inner: FetchOrGapFn, options: CacheOptions): FetchOrGapFn {
  return async (url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs) => {
    if (options.disabled) {
      return inner(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs);
    }

    const today = utcDateString(options.now());
    const sha = await sha256Hex(url);
    const todayPath = entryPath(options.dir, today, sha);

    const cached = await readEntry(todayPath);
    if (cached !== undefined) {
      return toFetchJsonResult(cached, adapter);
    }

    const result = await inner(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs);

    if ("rawSnapshot" in result) {
      await writeEntry(todayPath, {
        url,
        adapter,
        fetchedAt: result.rawSnapshot.fetchedAt,
        cachedDate: today,
        payload: result.payload,
      });

      return result;
    }

    const stale = await findStaleFallback(options.dir, sha, today, options.fallbackDays);
    if (stale !== undefined) {
      const ageDays = dateDiffDays(today, stale.cachedDate);
      options.onStaleFallback({
        source: adapter,
        message: `cache-fallback adapter=${adapter} stalenessDays=${ageDays}`,
      });

      return toFetchJsonResult(stale, adapter);
    }

    return result;
  };
}
