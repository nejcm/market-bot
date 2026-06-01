import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetClass } from "../domain/types";
import type { Observation } from "../forecast/observable";

export type FetchCloseFn = (
  symbol: string,
  assetClass: AssetClass,
  date: Date,
) => Promise<number | undefined>;

export type FetchWindowFn = (
  symbol: string,
  assetClass: AssetClass,
  from: Date,
  to: Date,
) => Promise<readonly Observation[]>;

interface CloseCacheEntry {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly date: string;
  readonly close: number;
  readonly cachedAt: string;
}

interface CloseWindowCacheEntry {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly from: string;
  readonly to: string;
  readonly observations: readonly Observation[];
  readonly cachedAt: string;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function cacheSymbol(symbol: string): string {
  return symbol.toLowerCase().replaceAll(/[^a-z0-9._-]/gu, "_");
}

function closeCachePath(
  cacheDir: string,
  symbol: string,
  assetClass: AssetClass,
  date: Date,
): string {
  return join(cacheDir, "closes", assetClass, cacheSymbol(symbol), `${ymd(date)}.json`);
}

function closeWindowCachePath(
  cacheDir: string,
  symbol: string,
  assetClass: AssetClass,
  from: Date,
  to: Date,
): string {
  return join(
    cacheDir,
    "close-windows",
    assetClass,
    cacheSymbol(symbol),
    `${ymd(from)}_${ymd(to)}.json`,
  );
}

async function readClose(path: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CloseCacheEntry;
    return Number.isFinite(entry.close) ? entry.close : undefined;
  } catch {
    return undefined;
  }
}

function isObservation(value: unknown): value is Observation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Observation).subject === "string" &&
    typeof (value as Observation).date === "string" &&
    Number.isFinite((value as Observation).value)
  );
}

async function readWindow(path: string): Promise<readonly Observation[] | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CloseWindowCacheEntry;
    return Array.isArray(entry.observations) && entry.observations.every(isObservation)
      ? entry.observations
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeClose(path: string, entry: CloseCacheEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(entry, undefined, 2)}\n`, "utf8");
  } catch {
    // Close-cache writes are best-effort; scoring can still continue without them.
  }
}

async function writeWindow(path: string, entry: CloseWindowCacheEntry): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(entry, undefined, 2)}\n`, "utf8");
  } catch {
    // Window-cache writes are best-effort; scoring can still continue without them.
  }
}

export async function fetchCloseWithCache(
  symbol: string,
  assetClass: AssetClass,
  date: Date,
  cacheDir: string | undefined,
  fetchClose: FetchCloseFn,
  now: Date = new Date(),
): Promise<number | undefined> {
  if (cacheDir === undefined) {
    return fetchClose(symbol, assetClass, date);
  }

  const path = closeCachePath(cacheDir, symbol, assetClass, date);
  const cached = await readClose(path);
  if (cached !== undefined) {
    return cached;
  }

  const close = await fetchClose(symbol, assetClass, date);
  if (close !== undefined) {
    await writeClose(path, {
      symbol,
      assetClass,
      date: ymd(date),
      close,
      cachedAt: now.toISOString(),
    });
  }

  return close;
}

export async function fetchWindowWithCache(
  symbol: string,
  assetClass: AssetClass,
  from: Date,
  to: Date,
  cacheDir: string | undefined,
  fetchWindow: FetchWindowFn,
  now: Date = new Date(),
): Promise<readonly Observation[]> {
  if (cacheDir === undefined) {
    return fetchWindow(symbol, assetClass, from, to);
  }

  const path = closeWindowCachePath(cacheDir, symbol, assetClass, from, to);
  const cached = await readWindow(path);
  if (cached !== undefined) {
    return cached;
  }

  const observations = await fetchWindow(symbol, assetClass, from, to);
  if (observations.length > 0) {
    await writeWindow(path, {
      symbol,
      assetClass,
      from: ymd(from),
      to: ymd(to),
      observations,
      cachedAt: now.toISOString(),
    });
  }

  return observations;
}
