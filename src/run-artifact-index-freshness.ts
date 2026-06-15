import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { INDEX_SCHEMA_VERSION } from "./run-artifact-index-schema";
import type { ArtifactFileRow, RunRow } from "./run-artifact-index-types";

const MUTABLE_SIDECARS = new Set([
  "score.json",
  "miss-autopsy.json",
  "alpha-validation.json",
  "normalized/candidate-profiles.json",
]);

async function listRunDirNames(dataDir: string): Promise<readonly string[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

async function mutableSidecarMatches(
  dataDir: string,
  runDirName: string,
  row: ArtifactFileRow,
): Promise<boolean> {
  const filePath = join(dataDir, runDirName, row.path);
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && metadata.size === row.size && metadata.mtimeMs === row.modified_at;
  } catch {
    return false;
  }
}

export async function indexIsFresh(
  dataDir: string,
  db: Database,
  warn: (message: string) => void,
): Promise<boolean> {
  const version = db.query("PRAGMA user_version").get() as { readonly user_version: number } | null;
  if (version?.user_version !== INDEX_SCHEMA_VERSION) {
    warn(
      `unsupported schema version ${String(version?.user_version ?? "unknown")}, falling back to disk scan`,
    );
    return false;
  }

  const diskDirs = await listRunDirNames(dataDir);
  const indexedDirs = (
    db.query("SELECT run_dir_name FROM runs ORDER BY run_dir_name").all() as readonly {
      readonly run_dir_name: string;
    }[]
  ).map((row) => row.run_dir_name);
  if (JSON.stringify(diskDirs) !== JSON.stringify(indexedDirs)) {
    warn("index stale (run directory set mismatch), falling back to disk scan");
    return false;
  }

  const runs = db.query("SELECT * FROM runs ORDER BY run_dir_name").all() as readonly RunRow[];
  const sidecars = db
    .query(
      `SELECT run_id, path, size, modified_at
       FROM artifact_files
       WHERE path IN ('score.json', 'miss-autopsy.json', 'alpha-validation.json', 'normalized/candidate-profiles.json')`,
    )
    .all() as readonly ArtifactFileRow[];
  const sidecarsByKey = new Map(sidecars.map((row) => [`${row.run_id}:${row.path}`, row]));

  const checks = runs.flatMap((run) =>
    [...MUTABLE_SIDECARS].map(async (path) => {
      const indexed = sidecarsByKey.get(`${run.run_id}:${path}`);
      const diskPath = join(dataDir, run.run_dir_name, path);
      const exists = await stat(diskPath)
        .then((metadata) => metadata.isFile())
        .catch(() => false);
      if (!exists && indexed === undefined) {
        return true;
      }
      return (
        indexed !== undefined && (await mutableSidecarMatches(dataDir, run.run_dir_name, indexed))
      );
    }),
  );

  const results = await Promise.all(checks);
  if (!results.every(Boolean)) {
    warn("index stale (mutable sidecar mismatch), falling back to disk scan");
    return false;
  }
  return true;
}
