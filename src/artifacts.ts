import { mkdir, rename, writeFile } from "node:fs/promises";
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

// Stage in a sibling of dataDir and rename into place, so concurrent runs and index
// Rebuilds never see a half-written run dir; a killed run leaves only the hidden stage.
export async function publishRunArtifacts(
  dataDir: string,
  runId: string,
  write: (staged: RunArtifactPaths) => Promise<void>,
): Promise<RunArtifactPaths> {
  const staged = await prepareRunArtifacts(
    dirname(dataDir),
    `.${basename(dataDir)}-${runId}.partial`,
  );
  await write(staged);
  const runDir = join(dataDir, runId);
  await mkdir(dataDir, { recursive: true });
  await rename(staged.runDir, runDir);
  return { runDir, rawDir: join(runDir, RAW_DIR), normalizedDir: join(runDir, NORMALIZED_DIR) };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
