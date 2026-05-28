import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssetClass } from "../domain/types";

export type FetchCloseFn = (
  symbol: string,
  assetClass: AssetClass,
  date: Date,
) => Promise<number | undefined>;

interface CloseCacheEntry {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly date: string;
  readonly close: number;
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

async function readClose(path: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as CloseCacheEntry;
    return Number.isFinite(entry.close) ? entry.close : undefined;
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
