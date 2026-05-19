import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResearchReport, RunTrace } from "./domain/types";

export interface RunArtifacts {
  readonly runDir: string;
  readonly rawDir: string;
  readonly normalizedDir: string;
}

export function createRunId(now: Date = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function prepareRunArtifacts(dataDir: string, runId: string): Promise<RunArtifacts> {
  const runDir = join(dataDir, runId);
  const rawDir = join(runDir, "raw");
  const normalizedDir = join(runDir, "normalized");

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

export async function writeRunOutputs(artifacts: RunArtifacts, report: ResearchReport, markdown: string, trace: RunTrace): Promise<void> {
  await writeJson(join(artifacts.runDir, "report.json"), report);
  await writeFile(join(artifacts.runDir, "report.md"), markdown, "utf8");
  await writeJson(join(artifacts.runDir, "trace.json"), trace);
}
