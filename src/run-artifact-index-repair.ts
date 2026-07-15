import {
  configuredRunArtifactIndexPath,
  readRunArtifactIndexStatus,
  rebuildRunArtifactIndex,
} from "./run-artifact-index";
import { openRunArtifactIndexDatabase } from "./run-artifact-index-schema";
import { indexIsFresh } from "./run-artifact-index-freshness";
import type { RebuildOptions } from "./run-artifact-index-types";

export interface RebuildIfStaleResult {
  readonly rebuilt: boolean;
}

/**
 * Trigger a one-shot full rebuild when an existing, schema-matched index has
 * drifted from disk. Non-fatal; callers must `.catch` independently.
 *
 * Guards:
 *  - state !== "available" → early return (disabled / missing / unsupported-schema / unreadable)
 *  - index is fresh        → early return (no work needed)
 *
 * Does NOT auto-create a missing index; ADR 0002 permits stale healing only for
 * an existing schema-compatible index.
 *
 * @param {string} dataDir - Canonical run artifacts directory.
 * @param {RebuildOptions} options - Optional override for the SQLite DB path.
 * @returns {Promise<RebuildIfStaleResult>} Object indicating whether a rebuild was performed.
 */
export async function rebuildRunArtifactIndexIfStale(
  dataDir: string,
  options: RebuildOptions = {},
): Promise<RebuildIfStaleResult> {
  // Resolve the path ONCE so status, freshness probe, and rebuild all use the same DB.
  // Prevents check-one-rebuild-another when the caller passes an explicit dbPath.
  const dbPath = options.dbPath ?? configuredRunArtifactIndexPath(dataDir);

  // Status guard — only act on an existing, schema-matched DB at THIS path.
  // Disabled / missing / unsupported-schema / unreadable all return early.
  if (readRunArtifactIndexStatus(dataDir, process.env, dbPath).state !== "available") {
    return { rebuilt: false };
  }

  // Freshness probe with a suppressing warn callback so the misleading
  // "falling back to disk scan" line is never emitted in this repair lane.
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

  // Full rebuild at the same path. Read handle is already closed so BEGIN IMMEDIATE acquires cleanly.
  process.stderr.write("Run artifact index: stale, rebuilding\n");
  const result = await rebuildRunArtifactIndex(dataDir, { dbPath });
  process.stderr.write(`Run artifact index: rebuilt ${String(result.sourceRunCount)} run(s)\n`);
  return { rebuilt: true };
}
