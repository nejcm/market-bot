import { constants } from "node:fs";
import { access, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NORMALIZED_DIR, RAW_DIR } from "./run-artifact-layout";

export interface RunArtifactPaths {
  readonly runDir: string;
  readonly rawDir: string;
  readonly normalizedDir: string;
}

export function createRunId(now: Date = new Date()): string {
  return `${now.toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function prepareRunArtifacts(
  dataDir: string,
  runId: string,
): Promise<RunArtifactPaths> {
  const runDir = join(dataDir, runId);
  const rawDir = join(runDir, RAW_DIR);
  const normalizedDir = join(runDir, NORMALIZED_DIR);

  await mkdir(rawDir, { recursive: true });
  await mkdir(normalizedDir, { recursive: true });

  return {
    runDir,
    rawDir,
    normalizedDir,
  };
}

// The stage sits beside the real runs dir so the rename never crosses a filesystem and
// Scanners of the runs dir never see it; a killed run leaves only the hidden stage.
async function runStagingParent(dataDir: string): Promise<{ runsDir: string; parent: string }> {
  await mkdir(dataDir, { recursive: true });
  const runsDir = await realpath(dataDir);
  const parent = dirname(runsDir);
  const [runsStat, parentStat] = await Promise.all([stat(runsDir), stat(parent)]);
  if (runsStat.dev !== parentStat.dev || parent === runsDir) {
    throw new Error(
      `Run staging needs ${runsDir} to share a filesystem with its parent; point MARKET_BOT_DATA_DIR below the mount point`,
    );
  }
  await access(parent, constants.W_OK).catch((error: unknown) => {
    throw new Error(`Run staging needs ${parent} to be writable`, { cause: error });
  });
  return { runsDir, parent };
}

// Fails before any provider spend instead of at the final rename.
export async function assertRunStagingUsable(dataDir: string): Promise<void> {
  await runStagingParent(dataDir);
}

export async function publishRunArtifacts(
  dataDir: string,
  runId: string,
  write: (staged: RunArtifactPaths) => Promise<void>,
): Promise<RunArtifactPaths> {
  const { runsDir, parent } = await runStagingParent(dataDir);
  const staged = await prepareRunArtifacts(parent, `.${basename(runsDir)}-${runId}.partial`);
  await write(staged);
  const runDir = join(dataDir, runId);
  await rename(staged.runDir, runDir);
  return { runDir, rawDir: join(runDir, RAW_DIR), normalizedDir: join(runDir, NORMALIZED_DIR) };
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, data, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
