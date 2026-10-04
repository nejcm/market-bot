import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { INDEX_SCHEMA_VERSION } from "./run-artifact-index-schema";
import type { ArtifactFileRow, RunRow } from "./run-artifact-index-types";
import { MUTABLE_SIDECARS } from "./run-artifact-layout";

async function listRunDirNames(dataDir: string): Promise<readonly string[]> {
  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function summarizeMismatches(mismatches: readonly string[]): string {
  const more = mismatches.length > 1 ? ` (+${String(mismatches.length - 1)} more)` : "";
  return `${mismatches[0] ?? ""}${more}`;
}

function describeSidecar(
  file: { readonly size: number; readonly mtime: number } | undefined,
): string {
  return file === undefined ? "absent" : `size ${String(file.size)} mtime ${String(file.mtime)}`;
}

async function mutableSidecarMismatch(
  dataDir: string,
  runDirName: string,
  path: string,
  indexed: ArtifactFileRow | undefined,
): Promise<string | undefined> {
  const metadata = await stat(join(dataDir, runDirName, path)).catch(() => {});
  const disk = metadata?.isFile() ? { size: metadata.size, mtime: metadata.mtimeMs } : undefined;
  const indexedFile =
    indexed === undefined ? undefined : { size: indexed.size, mtime: indexed.modified_at };
  if (disk?.size === indexedFile?.size && disk?.mtime === indexedFile?.mtime) {
    return undefined;
  }
  return `${runDirName}/${path} indexed ${describeSidecar(indexedFile)} vs disk ${describeSidecar(disk)}`;
}

export async function indexIsFresh(
  dataDir: string,
  db: Database,
  warn: (message: string) => void,
  diskDirNames?: readonly string[],
): Promise<boolean> {
  const version = db.query("PRAGMA user_version").get() as { readonly user_version: number } | null;
  if (version?.user_version !== INDEX_SCHEMA_VERSION) {
    warn(
      `unsupported schema version ${String(version?.user_version ?? "unknown")}, falling back to disk scan; run bun run src/cli.ts index rebuild`,
    );
    return false;
  }

  const diskDirs =
    diskDirNames === undefined ? await listRunDirNames(dataDir) : [...diskDirNames].toSorted();
  const indexedDirs = (
    db.query("SELECT run_dir_name FROM runs ORDER BY run_dir_name").all() as readonly {
      readonly run_dir_name: string;
    }[]
  ).map((row) => row.run_dir_name);
  const diskDirSet = new Set(diskDirs);
  const indexedDirSet = new Set(indexedDirs);
  const dirMismatches = [
    ...diskDirs
      .filter((name) => !indexedDirSet.has(name))
      .map((name) => `${name} indexed absent vs disk present`),
    ...indexedDirs
      .filter((name) => !diskDirSet.has(name))
      .map((name) => `${name} indexed present vs disk absent`),
  ];
  if (dirMismatches.length > 0) {
    warn(
      `index stale (run directory set mismatch: ${summarizeMismatches(dirMismatches)}), falling back to disk scan`,
    );
    return false;
  }

  const runs = db.query("SELECT * FROM runs ORDER BY run_dir_name").all() as readonly RunRow[];
  const placeholders = MUTABLE_SIDECARS.map(() => "?").join(", ");
  const sidecars = db
    .query(
      `SELECT run_id, path, size, modified_at
       FROM artifact_files
       WHERE path IN (${placeholders})`,
    )
    .all(...MUTABLE_SIDECARS) as readonly ArtifactFileRow[];
  const sidecarsByKey = new Map(sidecars.map((row) => [`${row.run_id}:${row.path}`, row]));

  const mismatches = (
    await Promise.all(
      runs.flatMap((run) =>
        MUTABLE_SIDECARS.map((path) =>
          mutableSidecarMismatch(
            dataDir,
            run.run_dir_name,
            path,
            sidecarsByKey.get(`${run.run_id}:${path}`),
          ),
        ),
      ),
    )
  ).filter((mismatch) => mismatch !== undefined);
  if (mismatches.length > 0) {
    warn(
      `index stale (mutable sidecar mismatch: ${summarizeMismatches(mismatches)}), falling back to disk scan`,
    );
    return false;
  }
  return true;
}
