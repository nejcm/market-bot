import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./guards";
import { RUN_ARTIFACT_FILES } from "./run-artifact-layout";

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

// An unreadable marker still counts, so the per-run reader reports that run malformed instead of aborting the scan.
async function markerPresent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    return !isNotFound(error);
  }
}

async function isRunDir(dir: string): Promise<boolean> {
  const [hasReport, hasFailure] = await Promise.all([
    markerPresent(join(dir, RUN_ARTIFACT_FILES.report)),
    markerPresent(join(dir, RUN_ARTIFACT_FILES.failure)),
  ]);
  return hasReport || hasFailure;
}

// Under a data dir not named `runs`, shared-state dirs sit beside the runs; only report.json or failure.json marks a run.
export async function listRunDirNames(dataDir: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
  const candidates = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const isRun = await Promise.all(candidates.map((entry) => isRunDir(join(dataDir, entry.name))));
  return candidates
    .filter((_, index) => isRun[index])
    .map((entry) => entry.name)
    .toSorted();
}

export function dataRootFromRunsDir(dataDir: string): string {
  const trimmedDataDir = dataDir.replace(/[\\/]+$/u, "");
  if (trimmedDataDir.split(/[\\/]/u).at(-1) !== "runs") {
    return dataDir;
  }

  const parentDir = trimmedDataDir.replace(/[\\/][^\\/]*$/u, "");
  if (parentDir === "") {
    return dataDir.charAt(0);
  }
  return parentDir === trimmedDataDir ? "." : parentDir;
}
