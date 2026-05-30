import { readdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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
  readonly cacheKey: string;
  readonly adapter: string;
  readonly fetchedAt: string;
  readonly cachedDate: string;
  readonly payload: unknown;
}

const CACHE_KEY_VERSION = "v2";
const CREDENTIAL_QUERY_PARAMS = new Set(["api_key", "api_token", "token"]);

export interface PruneCacheOptions {
  readonly dir: string;
  readonly now: Date;
  readonly rawRetentionDays: number;
  readonly closeRetentionDays: number;
}

export interface PruneCacheResult {
  readonly rawDaysPruned: number;
  readonly closeFilesPruned: number;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalRequest(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.username = "";
    parsed.password = "";

    const sorted = new URLSearchParams();
    [...parsed.searchParams.entries()]
      .filter(([key]) => !CREDENTIAL_QUERY_PARAMS.has(key.toLowerCase()))
      .toSorted(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyOrder = leftKey.localeCompare(rightKey);
        return keyOrder === 0 ? leftValue.localeCompare(rightValue) : keyOrder;
      })
      .forEach(([key, value]) => sorted.append(key, value));
    parsed.search = sorted.toString();

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

async function cacheKey(url: string, adapter: string): Promise<string> {
  return sha256Hex(`${CACHE_KEY_VERSION}\n${adapter}\n${canonicalRequest(url)}`);
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
  return async (url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs, init) => {
    if (options.disabled) {
      return inner(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs, init);
    }

    const today = utcDateString(options.now());
    const sha = await cacheKey(url, adapter);
    const todayPath = entryPath(options.dir, today, sha);

    const cached = await readEntry(todayPath);
    if (cached !== undefined) {
      return toFetchJsonResult(cached, adapter);
    }

    const result = await inner(url, adapter, fetchedAt, timeoutMs, fetchImpl, retryDelaysMs, init);

    if ("rawSnapshot" in result) {
      await writeEntry(todayPath, {
        cacheKey: sha,
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

function isWithinDir(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

async function pruneRawCache(options: PruneCacheOptions): Promise<number> {
  const today = utcDateString(options.now);
  const dateDirs = listDateDirs(options.dir).filter(
    (date) => dateDiffDays(today, date) > options.rawRetentionDays,
  );

  const results = await Promise.all(
    dateDirs.map(async (dateDir) => {
      const target = join(options.dir, dateDir);
      if (!isWithinDir(options.dir, target)) {
        return 0;
      }
      await rm(target, { recursive: true, force: true });
      return 1;
    }),
  );

  return results.reduce<number>((total, count) => total + count, 0);
}

function listCloseCacheFiles(dir: string): readonly string[] {
  const root = join(dir, "closes");
  const files: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }

    const entries = (() => {
      try {
        return readdirSync(current, { withFileTypes: true });
      } catch {
        return [];
      }
    })();

    for (const entry of entries) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(next);
      } else if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/u.test(entry.name)) {
        files.push(next);
      }
    }
  }

  return files;
}

async function pruneCloseCache(options: PruneCacheOptions): Promise<number> {
  const today = utcDateString(options.now);

  const results = await Promise.all(
    listCloseCacheFiles(options.dir).map(async (file) => {
      if (!isWithinDir(options.dir, file)) {
        return 0;
      }

      const cachedDate = basename(file, ".json");
      if (dateDiffDays(today, cachedDate) <= options.closeRetentionDays) {
        return 0;
      }

      await unlink(file).catch(() => {});
      await rm(dirname(file), { recursive: false, force: true }).catch(() => {});
      return 1;
    }),
  );

  return results.reduce<number>((total, count) => total + count, 0);
}

export async function pruneCache(options: PruneCacheOptions): Promise<PruneCacheResult> {
  return {
    rawDaysPruned: await pruneRawCache(options),
    closeFilesPruned: await pruneCloseCache(options),
  };
}
