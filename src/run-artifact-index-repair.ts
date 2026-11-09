import { runArtifactIndexDbPath } from "./config";
import { readRunArtifactIndexStatus, rebuildRunArtifactIndex } from "./run-artifact-index";
import { openRunArtifactIndexDatabase } from "./run-artifact-index-schema";
import { indexIsFresh } from "./run-artifact-index-freshness";
import type { RebuildOptions } from "./run-artifact-index-types";

export interface RebuildIfStaleResult {
  readonly rebuilt: boolean;
}

// Rebuilds an existing, schema-matched index that drifted from disk, never a missing one (ADR 0002).
// Non-fatal by contract, so callers `.catch` it.
export async function rebuildRunArtifactIndexIfStale(
  dataDir: string,
  options: RebuildOptions = {},
): Promise<RebuildIfStaleResult> {
  // Status, probe, and rebuild share one path, so an explicit dbPath is checked and rebuilt alike.
  const dbPath = options.dbPath ?? runArtifactIndexDbPath(dataDir);

  if (readRunArtifactIndexStatus(dataDir, process.env, dbPath).state !== "available") {
    return { rebuilt: false };
  }

  // Silent warn callback: the "falling back to disk scan" line would mislead in this lane.
  const db = openRunArtifactIndexDatabase(dbPath, true);
  let fresh = false;
  try {
    fresh = await indexIsFresh(dataDir, db, () => {});
  } finally {
    db.close();
  }

  if (fresh) {
    return { rebuilt: false };
  }

  // The read handle is closed first so BEGIN IMMEDIATE acquires cleanly.
  process.stderr.write("Run artifact index: stale, rebuilding\n");
  const result = await rebuildRunArtifactIndex(dataDir, { dbPath });
  process.stderr.write(`Run artifact index: rebuilt ${String(result.sourceRunCount)} run(s)\n`);
  return { rebuilt: true };
}
