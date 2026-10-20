import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataRootFromRunsDir } from "./data-paths";

export function consoleDbPath(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), "console", "console.sqlite");
}

export interface WatchlistRecord {
  readonly id: number;
  readonly name: string;
  readonly createdAt: string;
}

export interface WatchlistItemRecord {
  readonly assetClass: string;
  readonly symbol: string;
  readonly position: number | null;
}

export function listWatchlists(db: Database): readonly WatchlistRecord[] {
  return db
    .query("SELECT id, name, created_at AS createdAt FROM watchlists ORDER BY id")
    .all() as readonly WatchlistRecord[];
}

// Default (asset_class, symbol) order until a reorder writes positions; new items then append.
export function listWatchlistItems(db: Database, id: number): readonly WatchlistItemRecord[] {
  return db
    .query(
      "SELECT asset_class AS assetClass, symbol, position FROM watchlist_items WHERE watchlist_id = ? ORDER BY position IS NULL, position, asset_class, symbol",
    )
    .all(id) as readonly WatchlistItemRecord[];
}

// Read-only: CLI readers never create, lock for writing, or migrate the console store.
export function readWatchlistsNamed(
  dataDir: string,
  name: string,
): {
  readonly matches: readonly WatchlistRecord[];
  readonly items: readonly WatchlistItemRecord[];
} {
  const dbPath = consoleDbPath(dataDir);
  if (!existsSync(dbPath)) {
    return { matches: [], items: [] };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasWatchlists =
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watchlists'").get() !==
      null;
    const matches = hasWatchlists
      ? listWatchlists(db).filter((watchlist) => watchlist.name === name)
      : [];
    return {
      matches,
      items: matches.length === 1 ? listWatchlistItems(db, matches[0]!.id) : [],
    };
  } finally {
    db.close();
  }
}
