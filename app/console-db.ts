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
  return db;
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
