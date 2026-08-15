import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "oxfmt";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface GoldenOutput {
  readonly [key: string]: JsonValue;
  readonly report: JsonValue;
  readonly analytics: JsonValue;
  readonly markdown: string;
  readonly normalized: Readonly<Record<string, JsonValue>>;
}

const GOLDEN_ROOT_FILES = ["analytics.json", "report.json", "report.md"] as const;

export const VOLATILE_KEYS: ReadonlySet<string> = new Set([
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

function entryKind(entry: { isDirectory(): boolean; isFile(): boolean }): "dir" | "file" | "other" {
  if (entry.isDirectory()) {
    return "dir";
  }
  if (entry.isFile()) {
    return "file";
  }
  return "other";
}

async function readGoldenDirectoryEntries(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  const actual = entries.map((entry) => `${entryKind(entry)}:${entry.name}`).toSorted();
  const expected = [
    ...GOLDEN_ROOT_FILES.map((name) => `file:${name}`),
    "dir:normalized",
  ].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Invalid golden output at ${path}: expected entries ${expected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
}

async function readNormalizedGolden(path: string): Promise<Readonly<Record<string, JsonValue>>> {
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries.map((entry) => entry.name);
  const invalidEntry = entries.find((entry) => !entry.isFile() || !entry.name.endsWith(".json"));
  if (invalidEntry !== undefined) {
    throw new Error(`Invalid golden output at ${path}: unexpected entry ${invalidEntry.name}`);
  }
  const sortedNames = names.toSorted();
  const entriesByName = await Promise.all(
    sortedNames.map(async (name) => [name, await readJson(join(path, name))] as const),
  );
  return Object.fromEntries(entriesByName);
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
        .map(([key, item]) => [
          key,
          VOLATILE_KEYS.has(key) || (key === "durationMs" && "stage" in value)
            ? `<${key}>`
            : scrub(item),
        ]),
    );
  }
  if (typeof value === "string") {
    return value.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/gu, "<run-id>");
  }
  return value;
}

export function goldenOutputDirectory(fixtureName: string): string {
  return join(import.meta.dir, "../../fixtures/runs", fixtureName, "golden-output");
}

export async function scrubbedRunArtifacts(runDir: string): Promise<GoldenOutput> {
  const markdown = await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8");
  return scrub({
    report: await readJson(join(runDir, RUN_ARTIFACT_FILES.report)),
    analytics: await readJson(join(runDir, RUN_ARTIFACT_FILES.analytics)),
    markdown,
    normalized: await readNormalizedArtifacts(runDir),
  }) as GoldenOutput;
}

export async function readGoldenOutput(fixtureName: string): Promise<GoldenOutput> {
  const directory = goldenOutputDirectory(fixtureName);
  await readGoldenDirectoryEntries(directory);
  const normalized = await readNormalizedGolden(join(directory, "normalized"));
  return {
    report: await readJson(join(directory, "report.json")),
    analytics: await readJson(join(directory, "analytics.json")),
    markdown: await readFile(join(directory, "report.md"), "utf8"),
    normalized,
  };
}

async function formatJson(path: string, value: JsonValue): Promise<string> {
  const formatted = await format(path, JSON.stringify(value, null, 2));
  if (formatted.errors.length > 0) {
    throw new Error(
      `Failed to format golden output ${path}: ${formatted.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  return formatted.code;
}

export async function writeGoldenOutput(
  runDir: string,
  fixtureName: string,
  validate: (path: string, content: string) => void,
): Promise<readonly string[]> {
  const directory = goldenOutputDirectory(fixtureName);
  const normalizedDirectory = join(directory, "normalized");
  const golden = await scrubbedRunArtifacts(runDir);
  const normalizedNames = Object.keys(golden.normalized).toSorted();
  const pending = await Promise.all([
    formatJson(join(directory, "report.json"), golden.report).then(
      (content) => [join(directory, "report.json"), content] as const,
    ),
    formatJson(join(directory, "analytics.json"), golden.analytics).then(
      (content) => [join(directory, "analytics.json"), content] as const,
    ),
    Promise.resolve([join(directory, "report.md"), golden.markdown] as const),
    ...normalizedNames.map((name) =>
      formatJson(join(normalizedDirectory, name), golden.normalized[name]!).then(
        (content) => [join(normalizedDirectory, name), content] as const,
      ),
    ),
  ]);
  // Code-unit order, matching the plain `.toSorted()` the test expects.
  const files = pending.toSorted(([left], [right]) => Number(left > right) - Number(left < right));
  for (const [path, content] of files) {
    validate(path, content);
  }
  await rm(directory, { recursive: true, force: true });
  await mkdir(normalizedDirectory, { recursive: true });
  await Promise.all(files.map(([path, content]) => writeFile(path, content, "utf8")));
  return files.map(([path]) => path);
}
