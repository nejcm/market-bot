import { readdirSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import { isYahooMarketDataAdapter, yahooCacheFallbackDays } from "./yahoo-resilience";
import type { FetchSourceResult, RawSourceSnapshot, SourceRequest } from "./types";

type CacheableFetchFn<TPayload = unknown> = (
  request: SourceRequest,
) => Promise<FetchSourceResult<TPayload> | SourceGap>;

interface CachedPayloadValidator<TPayload> {
  readonly isPayload: (payload: unknown) => payload is TPayload;
  readonly invalidMessage: string;
}

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

const CACHE_KEY_VERSION = "v3";
const CREDENTIAL_QUERY_PARAMS = new Set(["api_key", "api_token", "token", "access_token"]);
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const FRESHNESS_BUDGETS_MS = {
  live: 15 * MINUTE_MS,
  news: 60 * MINUTE_MS,
  reference: DAY_MS,
} as const;

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

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalRequestUrl(url: string): string {
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
        const keyOrder = compareText(leftKey, rightKey);
        return keyOrder === 0 ? compareText(leftValue, rightValue) : keyOrder;
      })
      .forEach(([key, value]) => sorted.append(key, value));
    parsed.search = sorted.toString();

    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

function requestMethod(init: RequestInit | undefined): string {
  return (init?.method ?? "GET").toUpperCase();
}

async function cacheableRequestFingerprint(request: SourceRequest): Promise<
  | {
      readonly method: string;
      readonly bodyHash: string;
    }
  | undefined
> {
  const method = requestMethod(request.init);
  const body = request.init?.body;
  if (method === "GET" || method === "HEAD") {
    return { method, bodyHash: "" };
  }
  if (body === undefined || body === null) {
    return { method, bodyHash: "" };
  }
  if (typeof body !== "string") {
    return undefined;
  }
  return { method, bodyHash: await sha256Hex(body) };
}

function cacheKeyVersionForAdapter(_adapter: string): string {
  return CACHE_KEY_VERSION;
}

async function cacheKey(request: SourceRequest): Promise<string | undefined> {
  const fingerprint = await cacheableRequestFingerprint(request);
  if (fingerprint === undefined) {
    return undefined;
  }
  return sha256Hex(
    `${cacheKeyVersionForAdapter(request.adapter)}\n${request.adapter}\n${fingerprint.method}\n${fingerprint.bodyHash}\n${canonicalRequestUrl(request.url)}`,
  );
}

export async function makeCacheKeyForTest(
  url: string,
  adapter: string,
  init?: RequestInit,
): Promise<string | undefined> {
  return cacheKey({ url, adapter, init });
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

function cacheEntryMetadataGap(adapter: string): SourceGap {
  return sourceGap({
    source: adapter,
    message: "cached entry metadata was invalid",
    cause: "provider-data-missing",
    evidenceQualityImpact: "core-cap",
  });
}

function isValidCacheEntryMetadata(
  entry: CacheEntry,
  expected: { readonly cacheKey: string; readonly adapter: string; readonly cachedDate: string },
): boolean {
  return (
    entry.cacheKey === expected.cacheKey &&
    entry.adapter === expected.adapter &&
    entry.cachedDate === expected.cachedDate &&
    !Number.isNaN(new Date(entry.fetchedAt).getTime())
  );
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
      .toSorted((a, b) => compareText(b, a));
  } catch {
    return [];
  }
}

async function findStaleFallback(
  dir: string,
  sha: string,
  today: string,
  fallbackDays: number,
  adapter: string,
  sameDayEntry?: CacheEntry,
): Promise<CacheEntry | undefined> {
  const candidateDirs = listDateDirs(dir).filter(
    (d) => d < today && dateDiffDays(today, d) <= fallbackDays,
  );

  const entries = await Promise.all(
    candidateDirs.map(async (d) => ({ date: d, entry: await readEntry(entryPath(dir, d, sha)) })),
  );

  const sameDayCandidate =
    sameDayEntry === undefined ? [] : ([{ date: today, entry: sameDayEntry }] as const);
  return [...sameDayCandidate, ...entries]
    .map(({ date, entry }) =>
      entry !== undefined &&
      isValidCacheEntryMetadata(entry, { cacheKey: sha, adapter, cachedDate: date })
        ? entry
        : undefined,
    )
    .find((e): e is CacheEntry => e !== undefined);
}

function freshnessBudgetMs(adapter: string): number {
  if (
    adapter.includes("news") ||
    adapter === "apewisdom" ||
    adapter.startsWith("exa-search") ||
    adapter.includes("social")
  ) {
    return FRESHNESS_BUDGETS_MS.news;
  }
  if (
    adapter.startsWith("sec-") ||
    adapter.startsWith("fred") ||
    adapter.startsWith("nasdaq-") ||
    adapter.startsWith("cboe-") ||
    adapter.startsWith("exa-contents") ||
    adapter.startsWith("glassnode") ||
    adapter.includes("expirations") ||
    adapter.includes("events")
  ) {
    return FRESHNESS_BUDGETS_MS.reference;
  }
  return FRESHNESS_BUDGETS_MS.live;
}

function isFresh(entry: CacheEntry, adapter: string, now: Date): boolean {
  return now.getTime() - new Date(entry.fetchedAt).getTime() <= freshnessBudgetMs(adapter);
}

function toFetchResult<TPayload>(
  entry: CacheEntry,
  adapter: string,
  payload: TPayload,
  cacheStatus?: RawSourceSnapshot["cacheStatus"],
): FetchSourceResult<TPayload> {
  const rawSnapshot: RawSourceSnapshot = {
    id: `raw-${adapter}-${entry.fetchedAt}`,
    adapter,
    fetchedAt: entry.fetchedAt,
    payload: entry.payload,
    ...(cacheStatus !== undefined ? { cacheStatus } : {}),
  };

  return { rawSnapshot, payload };
}

function toCachedResult<TPayload>(
  entry: CacheEntry,
  adapter: string,
  validator: CachedPayloadValidator<TPayload> | undefined,
  cacheStatus: NonNullable<RawSourceSnapshot["cacheStatus"]>,
): FetchSourceResult<TPayload> | SourceGap {
  if (validator !== undefined && !validator.isPayload(entry.payload)) {
    return sourceGap({
      source: adapter,
      message: validator.invalidMessage,
      cause: "provider-data-missing",
      evidenceQualityImpact: "core-cap",
    });
  }

  let { payload } = entry;
  if (cacheStatus === "stale-fallback") {
    payload = typeof entry.payload === "string" ? "" : undefined;
  }
  return toFetchResult(entry, adapter, payload as TPayload, cacheStatus);
}

export function withCache<TPayload = unknown>(
  inner: CacheableFetchFn<TPayload>,
  options: CacheOptions,
  validator?: CachedPayloadValidator<TPayload>,
): CacheableFetchFn<TPayload> {
  return async (request) => {
    const { adapter } = request;
    if (options.disabled) {
      return inner(request);
    }

    const now = options.now();
    const today = utcDateString(now);
    const sha = await cacheKey(request);
    if (sha === undefined) {
      return inner(request);
    }
    const todayPath = entryPath(options.dir, today, sha);

    const cached = await readEntry(todayPath);
    let validCached = cached;
    if (cached !== undefined) {
      if (
        isValidCacheEntryMetadata(cached, {
          cacheKey: sha,
          adapter,
          cachedDate: today,
        })
      ) {
        if (isFresh(cached, adapter, now)) {
          return toCachedResult(cached, adapter, validator, "current");
        }
      } else {
        // Treat a corrupt/tampered entry as a cache miss.
        // Emit an audit gap, then fall through to a live fetch.
        options.onStaleFallback(cacheEntryMetadataGap(adapter));
        validCached = undefined;
      }
    }

    const result = await inner(request);

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

    const effectiveFallbackDays = isYahooMarketDataAdapter(adapter)
      ? yahooCacheFallbackDays(options.fallbackDays)
      : options.fallbackDays;
    const stale = await findStaleFallback(
      options.dir,
      sha,
      today,
      effectiveFallbackDays,
      adapter,
      validCached,
    );
    if (stale !== undefined) {
      const ageDays = dateDiffDays(today, stale.cachedDate);
      options.onStaleFallback(
        sourceGap({
          source: adapter,
          message: `cache-fallback adapter=${adapter} stalenessDays=${ageDays}`,
          capability: "cache",
          cause: "stale-fallback",
          evidenceQualityImpact: "core-cap",
        }),
      );

      return toCachedResult(stale, adapter, validator, "stale-fallback");
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
  const roots = [join(dir, "closes"), join(dir, "close-windows")];
  const files: string[] = [];
  const pending = [...roots];

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
      } else if (
        entry.isFile() &&
        /^\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?\.json$/u.test(entry.name)
      ) {
        files.push(next);
      }
    }
  }

  return files;
}

function cachedCloseDate(file: string): string {
  return basename(file, ".json").split("_").at(-1) ?? "";
}

async function pruneCloseCache(options: PruneCacheOptions): Promise<number> {
  const today = utcDateString(options.now);

  const results = await Promise.all(
    listCloseCacheFiles(options.dir).map(async (file) => {
      if (!isWithinDir(options.dir, file)) {
        return 0;
      }

      const cachedDate = cachedCloseDate(file);
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
