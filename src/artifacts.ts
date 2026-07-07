import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
