import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const VOLATILE_KEYS = new Set([
  "runId",
  "generatedAt",
  "startedAt",
  "completedAt",
  "tokenEstimate",
  "costEstimateUsd",
  "effectiveConfigHash",
  "dirtySourceHash",
  "codeVersion",
]);

const OPTIONAL_VOLATILE_KEYS = new Set(["dirtySourceHash"]);

async function readJson(path: string): Promise<JsonValue> {
  return JSON.parse(await readFile(path, "utf8")) as JsonValue;
}

async function readNormalizedArtifacts(runDir: string): Promise<Record<string, JsonValue>> {
  const normalizedDir = join(runDir, "normalized");
  const normalizedFiles = await readdir(normalizedDir);
  const files = normalizedFiles.filter((file) => file.endsWith(".json")).toSorted();
  const entries = await Promise.all(
    files.map(async (file) => [file, await readJson(join(normalizedDir, file))] as const),
  );
  return Object.fromEntries(entries);
}

function scrub(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => scrub(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !OPTIONAL_VOLATILE_KEYS.has(key))
        .map(([key, item]) => [key, VOLATILE_KEYS.has(key) ? `<${key}>` : scrub(item)]),
    );
  }
  if (typeof value === "string") {
    return value.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/gu, "<run-id>");
  }
  return value;
}

export function goldenOutputPath(fixtureName: string): string {
  return join(import.meta.dir, "../../fixtures/runs", fixtureName, "golden-output.json");
}

export async function scrubbedRunArtifacts(runDir: string): Promise<JsonValue> {
  const markdown = await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8");
  return scrub({
    report: await readJson(join(runDir, RUN_ARTIFACT_FILES.report)),
    analytics: await readJson(join(runDir, RUN_ARTIFACT_FILES.analytics)),
    markdown,
    normalized: await readNormalizedArtifacts(runDir),
  });
}

export async function readGoldenOutput(fixtureName: string): Promise<JsonValue> {
  return readJson(goldenOutputPath(fixtureName));
}

export async function writeGoldenOutput(runDir: string, fixtureName: string): Promise<void> {
  await writeFile(
    goldenOutputPath(fixtureName),
    `${JSON.stringify(await scrubbedRunArtifacts(runDir), null, 2)}\n`,
    "utf8",
  );
}
