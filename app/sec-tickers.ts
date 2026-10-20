import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SEC_TICKERS_URL } from "../src/config/shared";
import { isRecord, readString } from "../src/guards";
import { secRequestInit } from "../src/sources/extended-evidence/sec-edgar";
import type { SymbolSearchResult } from "./types";

const SEC_TICKER_SEARCH_LIMIT = 8;
const SEC_TICKERS_FETCH_TIMEOUT_MS = 10_000;
const SEC_TICKERS_CACHE_FILE = "sec-tickers.json";

export type SecTickerListResult =
  | { readonly ok: true; readonly payload: unknown; readonly fetchedAt: string }
  | { readonly ok: false; readonly message: string };

export function secTickersCachePath(cacheDir: string): string {
  return join(cacheDir, SEC_TICKERS_CACHE_FILE);
}

interface SecTickersCacheFile {
  readonly fetchedAt: string;
  readonly payload: unknown;
}

function cacheIsCurrent(cache: unknown, now: Date): cache is SecTickersCacheFile {
  return (
    isRecord(cache) &&
    typeof cache.fetchedAt === "string" &&
    cache.fetchedAt.slice(0, 10) === now.toISOString().slice(0, 10) &&
    isRecord(cache.payload)
  );
}

export async function loadSecTickers(options: {
  readonly cacheDir: string;
  readonly fetchFn: typeof fetch;
  readonly secUserAgent?: string;
  readonly now?: Date;
}): Promise<SecTickerListResult> {
  const now = options.now ?? new Date();
  const cachePath = secTickersCachePath(options.cacheDir);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
      if (cacheIsCurrent(cached, now)) {
        return { ok: true, payload: cached.payload, fetchedAt: cached.fetchedAt };
      }
    } catch {
      // Unreadable cache file: fall through to a live fetch.
    }
  }

  const init = secRequestInit(options.secUserAgent);
  try {
    const response = await options.fetchFn(SEC_TICKERS_URL, {
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      signal: AbortSignal.timeout(SEC_TICKERS_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `SEC ticker list is unavailable (provider returned ${String(response.status)})`,
      };
    }
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      return { ok: false, message: "SEC ticker list is unavailable (malformed provider response)" };
    }
    const fetchedAt = now.toISOString();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify({ fetchedAt, payload })}\n`, "utf8");
    return { ok: true, payload, fetchedAt };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `SEC ticker list is unavailable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export function searchSecTickers(
  payload: unknown,
  query: string,
  limit: number = SEC_TICKER_SEARCH_LIMIT,
): readonly SymbolSearchResult[] {
  const normalized = query.trim().toUpperCase();
  if (normalized === "" || !isRecord(payload)) {
    return [];
  }

  const matches = Object.values(payload)
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .flatMap((entry) => {
      const ticker = readString(entry, "ticker")?.toUpperCase();
      const name = readString(entry, "title");
      if (ticker === undefined) {
        return [];
      }
      const upperName = name?.toUpperCase();
      if (
        !ticker.startsWith(normalized) &&
        (upperName === undefined || !upperName.includes(normalized))
      ) {
        return [];
      }
      return [{ symbol: ticker, ...(name !== undefined ? { name } : {}) }];
    });

  return matches
    .toSorted(
      (left, right) =>
        searchRank(left, normalized) - searchRank(right, normalized) ||
        left.symbol.localeCompare(right.symbol),
    )
    .slice(0, limit);
}

function searchRank(result: SymbolSearchResult, query: string): number {
  if (result.symbol.startsWith(query)) {
    return 0;
  }
  return result.name?.toUpperCase().startsWith(query) === true ? 1 : 2;
}
