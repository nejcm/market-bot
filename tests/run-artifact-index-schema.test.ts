import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  openRunArtifactIndexDatabase,
  resetRunArtifactIndexSchema,
} from "../src/run-artifact-index-schema";

function foreignKeysEnabled(db: Database): boolean {
  const row = db.query("PRAGMA foreign_keys").get() as { readonly foreign_keys: number } | null;
  return row?.foreign_keys === 1;
}

function insertRun(db: Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (
      run_id, run_dir_name, finding_count, prediction_count, source_count, data_gap_count,
      has_score, report_status, score_status, outcomes_status
    ) VALUES (?, ?, 0, 0, 0, 0, 0, 'ok', 'absent', 'ok')`,
  ).run(runId, runId);
}

function insertOutcome(db: Database, runId: string, subsystem = "web-gather"): void {
  db.prepare(
    `INSERT INTO subsystem_outcomes (
      run_id, subsystem, expectation, outcome, code
    ) VALUES (?, ?, 'expected', 'produced', 'produced')`,
  ).run(runId, subsystem);
}

describe("Run Artifact Index schema foreign keys", () => {
  test("enables foreign_keys on a fresh writable database", () => {
    const db = openRunArtifactIndexDatabase(":memory:", false);
    expect(foreignKeysEnabled(db)).toBe(true);
    db.close();
  });

  test("rejects an orphan subsystem_outcomes row", () => {
    const db = openRunArtifactIndexDatabase(":memory:", false);
    resetRunArtifactIndexSchema(db);

    expect(() => insertOutcome(db, "missing-run")).toThrow(/FOREIGN KEY constraint failed/iu);
    db.close();
  });

  test("deleting a runs row cascades to subsystem_outcomes", () => {
    const db = openRunArtifactIndexDatabase(":memory:", false);
    resetRunArtifactIndexSchema(db);
    insertRun(db, "run-a");
    insertOutcome(db, "run-a");

    db.prepare("DELETE FROM runs WHERE run_id = ?").run("run-a");

    expect(
      db.query("SELECT COUNT(*) AS count FROM subsystem_outcomes").get() as {
        readonly count: number;
      },
    ).toEqual({ count: 0 });
    db.close();
  });
});
