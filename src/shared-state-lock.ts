import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataRootFromRunsDir } from "./data-paths";
import { isRecord } from "./guards";
import { progress } from "./progress";

const MIN_WAIT_MS = 50;
const MAX_WAIT_MS = 1000;

function tryBeginExclusive(db: Database): boolean {
  try {
    db.exec("BEGIN EXCLUSIVE");
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "SQLITE_BUSY") {
      return false;
    }
    throw error;
  }
}

// Cross-process mutex: an exclusive SQLite transaction holds a kernel file lock the OS
// Releases when the holder dies, so a killed run never leaves a stale lock. Not reentrant.
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const db = new Database(lockPath);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    for (
      let waitMs = MIN_WAIT_MS;
      !tryBeginExclusive(db);
      waitMs = Math.min(waitMs * 2, MAX_WAIT_MS)
    ) {
      if (waitMs === MIN_WAIT_MS) {
        progress(`waiting for lock ${lockPath}`);
      }
      // oxlint-disable-next-line no-await-in-loop -- Polling waits on another process.
      await Bun.sleep(waitMs);
    }
    try {
      return await run();
    } finally {
      db.exec("COMMIT");
    }
  } finally {
    db.close();
  }
}

// Serializes score passes, calibration, index and history writes across CLI processes.
export function withSharedStateLock<T>(dataDir: string, run: () => Promise<T>): Promise<T> {
  return withFileLock(join(dataRootFromRunsDir(dataDir), "shared-state.lock"), run);
}
