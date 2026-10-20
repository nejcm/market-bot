import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataRootFromRunsDir } from "../src/data-paths";
import type { Star, StarKind } from "./types";

export function consoleDbPath(dataDir: string): string {
  return join(dataRootFromRunsDir(dataDir), "console", "console.sqlite");
}

export function openConsoleDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
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
  return db;
}

export interface ProfileRow {
  readonly payload: unknown;
  readonly fetchedAt: string;
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

export function withConsoleDb<T>(dbPath: string, run: (db: Database) => T): T {
  const db = openConsoleDb(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
