import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { runFixture } from ".";

export interface ReplayedRunOutput {
  readonly report: unknown;
  readonly normalized: Readonly<Record<string, unknown>>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readNormalizedArtifacts(runDir: string): Promise<Record<string, unknown>> {
  const normalizedDir = join(runDir, "normalized");
  const files = (await readdir(normalizedDir)).filter((file) => file.endsWith(".json")).toSorted();
  const entries = await Promise.all(
    files.map(async (file) => [file, await readJson(join(normalizedDir, file))] as const),
  );
  return Object.fromEntries(entries);
}

async function replay(fixtureName: string): Promise<ReplayedRunOutput> {
  const result = await runFixture(fixtureName, { llm: "replay" });
  try {
    return {
      report: await readJson(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.report)),
      normalized: await readNormalizedArtifacts(result.artifacts.runDir),
    };
  } finally {
    await result.cleanup();
  }
}

const replays = new Map<string, Promise<ReplayedRunOutput>>();

export function replayedRunOutput(fixtureName: string): Promise<ReplayedRunOutput> {
  const cached = replays.get(fixtureName) ?? replay(fixtureName);
  replays.set(fixtureName, cached);
  return cached;
}
