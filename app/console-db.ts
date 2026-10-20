import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRootFromRunsDir } from "../src/data-paths";
import type { RunNote, Star, StarKind } from "./types";

export function consoleDbPath(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), "console", "console.sqlite");
}

export function openConsoleDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
    CREATE TABLE IF NOT EXISTS stars (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      symbol TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS watchlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_items (
      watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      asset_class TEXT NOT NULL,
      symbol TEXT NOT NULL,
      position INTEGER,
      PRIMARY KEY (watchlist_id, asset_class, symbol)
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS run_earnings_dates (
      run_id TEXT PRIMARY KEY,
      dates_json TEXT NOT NULL
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    )
  `);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

export function getNote(db: Database, kind: StarKind, key: string): RunNote | null {
  return db
    .query("SELECT kind, key, body, updated_at AS updatedAt FROM notes WHERE kind = ? AND key = ?")
    .get(kind, key) as RunNote | null;
}

export function putNote(db: Database, kind: StarKind, key: string, body: string): RunNote | null {
  if (body === "") {
    db.prepare("DELETE FROM notes WHERE kind = ? AND key = ?").run(kind, key);
    return null;
  }
  const updatedAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO notes (kind, key, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).run(kind, key, body, updatedAt);
  return { kind, key, body, updatedAt };
}

export interface ProfileRow {
  readonly payload: unknown;
  readonly fetchedAt: string;
}

export function getRunEarningsDates(db: Database, runId: string): readonly string[] | undefined {
  const row = db
    .query("SELECT dates_json AS datesJson FROM run_earnings_dates WHERE run_id = ?")
    .get(runId) as { readonly datesJson: string } | null;
  if (row === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(row.datesJson);
    return Array.isArray(parsed) && parsed.every((date) => typeof date === "string") ? parsed : [];
  } catch {
    // Unreadable stored dates: treat as an empty list rather than a cache hit.
    return [];
  }
}

export function putRunEarningsDates(db: Database, runId: string, dates: readonly string[]): void {
  db.prepare("INSERT OR IGNORE INTO run_earnings_dates (run_id, dates_json) VALUES (?, ?)").run(
    runId,
    JSON.stringify(dates),
  );
}

export function listStars(db: Database): readonly Star[] {
  return db
    .query(
      "SELECT kind, key, created_at AS createdAt FROM stars ORDER BY created_at DESC, kind, key",
    )
    .all() as readonly Star[];
}

export function addStar(db: Database, kind: StarKind, key: string): Star {
  const createdAt = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO stars (kind, key, created_at) VALUES (?, ?, ?)").run(
    kind,
    key,
    createdAt,
  );
  const row = db
    .query("SELECT kind, key, created_at AS createdAt FROM stars WHERE kind = ? AND key = ?")
    .get(kind, key) as Star | null;
  if (row === null) {
    throw new Error("Star insert failed");
  }
  return row;
}

export function removeStar(db: Database, kind: StarKind, key: string): boolean {
  return db.prepare("DELETE FROM stars WHERE kind = ? AND key = ?").run(kind, key).changes > 0;
}

export function getProfileRow(db: Database, symbol: string): ProfileRow | undefined {
  const row = db
    .query("SELECT payload, fetched_at AS fetchedAt FROM profiles WHERE symbol = ?")
    .get(symbol) as { readonly payload: string; readonly fetchedAt: string } | null;
  if (row === null) {
    return undefined;
  }
  try {
    return { payload: JSON.parse(row.payload) as unknown, fetchedAt: row.fetchedAt };
  } catch {
    // Unreadable stored payload: treat as absent so the caller refetches.
    return undefined;
  }
}

export function putProfileRow(
  db: Database,
  symbol: string,
  payload: unknown,
  fetchedAt: string,
): void {
  db.prepare(
    "INSERT INTO profiles (symbol, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
  ).run(symbol, JSON.stringify(payload), fetchedAt);
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

export function createWatchlist(db: Database, name: string): WatchlistRecord {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO watchlists (name, created_at) VALUES (?, ?)")
    .run(name, createdAt);
  return { id: Number(result.lastInsertRowid), name, createdAt };
}

export function getWatchlist(db: Database, id: number): WatchlistRecord | undefined {
  const row = db
    .query("SELECT id, name, created_at AS createdAt FROM watchlists WHERE id = ?")
    .get(id) as WatchlistRecord | null;
  return row ?? undefined;
}

export function renameWatchlist(db: Database, id: number, name: string): boolean {
  return db.prepare("UPDATE watchlists SET name = ? WHERE id = ?").run(name, id).changes > 0;
}

export function deleteWatchlist(db: Database, id: number): boolean {
  return db.prepare("DELETE FROM watchlists WHERE id = ?").run(id).changes > 0;
}

// Default (asset_class, symbol) order until a reorder writes positions; new items then append.
export function listWatchlistItems(db: Database, id: number): readonly WatchlistItemRecord[] {
  return db
    .query(
      "SELECT asset_class AS assetClass, symbol, position FROM watchlist_items WHERE watchlist_id = ? ORDER BY position IS NULL, position, asset_class, symbol",
    )
    .all(id) as readonly WatchlistItemRecord[];
}

export function addWatchlistItem(
  db: Database,
  id: number,
  assetClass: string,
  symbol: string,
): WatchlistItemRecord {
  const positioned = db
    .query("SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND position IS NOT NULL LIMIT 1")
    .get(id);
  const position =
    positioned === null
      ? null
      : (
          db
            .query(
              "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM watchlist_items WHERE watchlist_id = ?",
            )
            .get(id) as { readonly next: number }
        ).next;
  db.prepare(
    "INSERT OR IGNORE INTO watchlist_items (watchlist_id, asset_class, symbol, position) VALUES (?, ?, ?, ?)",
  ).run(id, assetClass, symbol, position);
  const row = db
    .query(
      "SELECT asset_class AS assetClass, symbol, position FROM watchlist_items WHERE watchlist_id = ? AND asset_class = ? AND symbol = ?",
    )
    .get(id, assetClass, symbol) as WatchlistItemRecord | null;
  if (row === null) {
    throw new Error("Watchlist item insert failed");
  }
  return row;
}

export function removeWatchlistItem(
  db: Database,
  id: number,
  assetClass: string,
  symbol: string,
): boolean {
  return (
    db
      .prepare(
        "DELETE FROM watchlist_items WHERE watchlist_id = ? AND asset_class = ? AND symbol = ?",
      )
      .run(id, assetClass, symbol).changes > 0
  );
}

export function reorderWatchlistItems(
  db: Database,
  id: number,
  items: readonly { readonly assetClass: string; readonly symbol: string }[],
): void {
  const update = db.prepare(
    "UPDATE watchlist_items SET position = ? WHERE watchlist_id = ? AND asset_class = ? AND symbol = ?",
  );
  db.transaction(() => {
    items.forEach((item, index) => update.run(index + 1, id, item.assetClass, item.symbol));
  })();
}

export function withConsoleDb<T>(dbPath: string, run: (db: Database) => T): T {
  const db = openConsoleDb(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
