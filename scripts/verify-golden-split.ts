import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { format } from "oxfmt";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface GoldenOutput {
  readonly report: JsonValue;
  readonly analytics: JsonValue;
  readonly markdown: string;
  readonly normalized: Readonly<Record<string, JsonValue>>;
}

type GoldenState =
  | { readonly kind: "pre-rename"; readonly monolithPath: string }
  | { readonly kind: "transitional"; readonly monolithPath: string }
  | { readonly kind: "post-split"; readonly directory: string };

const BASELINE_REF = "af9d3d5";
const FIXTURE_ROOT = join(import.meta.dir, "..", "tests", "fixtures", "runs");
const FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
  "equity-fpi-ifrs-semiannual",
  "equity-fpi-quarterly",
  "equity-nbis-deep",
  "equity-web-fallback-deep",
] as const;
const TOP_LEVEL_KEYS = ["report", "analytics", "markdown", "normalized"] as const;
const textEncoder = new TextEncoder();

function fail(fixture: string, message: string): never {
  throw new Error(`${fixture}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseGolden(fixture: string, raw: string): GoldenOutput {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      fixture,
      `invalid baseline JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    fail(fixture, "key path $: expected an object");
  }
  const keys = Object.keys(parsed);
  if (JSON.stringify(keys) !== JSON.stringify(TOP_LEVEL_KEYS)) {
    fail(
      fixture,
      `key path $: expected keys in order ${TOP_LEVEL_KEYS.join(", ")}; received ${keys.join(", ")}`,
    );
  }
  if (typeof parsed.markdown !== "string") {
    fail(fixture, `key path $.markdown: expected string; received ${typeof parsed.markdown}`);
  }
  if (!isRecord(parsed.normalized)) {
    fail(fixture, "key path $.normalized: expected an object");
  }
  const normalizedKeys = Object.keys(parsed.normalized);
  const sortedKeys = normalizedKeys.toSorted();
  if (JSON.stringify(normalizedKeys) !== JSON.stringify(sortedKeys)) {
    fail(fixture, "key path $.normalized: keys are not lexicographically ordered");
  }
  for (const key of normalizedKeys) {
    if (!key.endsWith(".json") || key.includes("/") || key.includes("\\")) {
      fail(fixture, `key path $.normalized[${JSON.stringify(key)}]: unsafe sidecar filename`);
    }
  }
  return parsed as unknown as GoldenOutput;
}

async function baselineBytes(fixture: string): Promise<Uint8Array> {
  const path = `tests/fixtures/runs/${fixture}/golden-output.json`;
  const process = Bun.spawn(["git", "show", `${BASELINE_REF}:${path}`], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ]);
  if (status !== 0) {
    fail(fixture, `cannot read baseline ${BASELINE_REF}:${path}: ${stderr.trim()}`);
  }
  return new Uint8Array(stdout);
}

async function formattedJson(path: string, value: JsonValue): Promise<string> {
  const formatted = await format(path, JSON.stringify(value, null, 2));
  if (formatted.errors.length > 0) {
    throw new Error(
      `oxfmt failed for ${path}: ${formatted.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return formatted.code;
}

async function writeSplitGolden(directory: string, golden: GoldenOutput): Promise<void> {
  const normalizedDir = join(directory, "normalized");
  await mkdir(normalizedDir, { recursive: true });
  await Promise.all([
    formattedJson(join(directory, "report.json"), golden.report).then((value) =>
      writeFile(join(directory, "report.json"), value, "utf8"),
    ),
    formattedJson(join(directory, "analytics.json"), golden.analytics).then((value) =>
      writeFile(join(directory, "analytics.json"), value, "utf8"),
    ),
    writeFile(join(directory, "report.md"), golden.markdown, "utf8"),
    ...Object.entries(golden.normalized).map(async ([name, value]) => {
      const path = join(normalizedDir, name);
      await writeFile(path, await formattedJson(path, value), "utf8");
    }),
  ]);
}

async function readJson(fixture: string, path: string, keyPath: string): Promise<JsonValue> {
  const raw = await readText(fixture, path, keyPath);
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    fail(
      fixture,
      `key path ${keyPath}: invalid JSON in ${relative(FIXTURE_ROOT, path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readText(fixture: string, path: string, keyPath: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail(
      fixture,
      `key path ${keyPath}: cannot read ${relative(FIXTURE_ROOT, path)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readSplitGolden(fixture: string, directory: string): Promise<GoldenOutput> {
  const directoryEntries = await readdir(directory, { withFileTypes: true });
  const rootEntries = directoryEntries
    .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`)
    .toSorted();
  const expectedRootEntries = [
    "file:analytics.json",
    "dir:normalized",
    "file:report.json",
    "file:report.md",
  ].toSorted();
  if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
    fail(
      fixture,
      `key path $: split directory entries differ; expected ${expectedRootEntries.join(", ")}; received ${rootEntries.join(", ")}`,
    );
  }

  const normalizedDir = join(directory, "normalized");
  const normalizedEntries = await readdir(normalizedDir, { withFileTypes: true });
  const invalidEntry = normalizedEntries.find(
    (entry) => !entry.isFile() || !entry.name.endsWith(".json"),
  );
  if (invalidEntry !== undefined) {
    fail(fixture, `key path $.normalized: unexpected entry ${invalidEntry.name}`);
  }
  const normalizedNames = normalizedEntries.map((entry) => entry.name).toSorted();
  const normalized = Object.fromEntries(
    await Promise.all(
      normalizedNames.map(async (name) => [
        name,
        await readJson(fixture, join(normalizedDir, name), `$.normalized[${JSON.stringify(name)}]`),
      ]),
    ),
  );
  return {
    report: await readJson(fixture, join(directory, "report.json"), "$.report"),
    analytics: await readJson(fixture, join(directory, "analytics.json"), "$.analytics"),
    markdown: await readText(fixture, join(directory, "report.md"), "$.markdown"),
    normalized,
  };
}

function firstJsonDifference(expected: unknown, actual: unknown, path = "$"): string | undefined {
  if (Object.is(expected, actual)) {
    return undefined;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}.length`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstJsonDifference(expected[index], actual[index], `${path}[${index}]`);
      if (difference !== undefined) {
        return difference;
      }
    }
    return undefined;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    const keyCount = Math.max(expectedKeys.length, actualKeys.length);
    for (let index = 0; index < keyCount; index += 1) {
      if (expectedKeys[index] !== actualKeys[index]) {
        return `${path}.${expectedKeys[index] ?? actualKeys[index] ?? "<key>"}`;
      }
      const key = expectedKeys[index];
      if (key !== undefined) {
        const difference = firstJsonDifference(expected[key], actual[key], `${path}.${key}`);
        if (difference !== undefined) {
          return difference;
        }
      }
    }
    return undefined;
  }
  return path;
}

function firstDifferingByte(expected: Uint8Array, actual: Uint8Array): number | undefined {
  const length = Math.min(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] !== actual[index]) {
      return index;
    }
  }
  return expected.length === actual.length ? undefined : length;
}

async function assertEquivalent(
  fixture: string,
  expectedBytes: Uint8Array,
  expected: GoldenOutput,
  actual: GoldenOutput,
): Promise<void> {
  const legacyPath = join(FIXTURE_ROOT, fixture, "golden-output.json");
  const serialized = await formattedJson(legacyPath, actual as unknown as JsonValue);
  const actualBytes = textEncoder.encode(serialized);
  const byte = firstDifferingByte(expectedBytes, actualBytes);
  if (byte === undefined) {
    return;
  }
  const keyPath = firstJsonDifference(expected, actual) ?? "$ <serialization-only>";
  const expectedByte = expectedBytes[byte];
  const actualByte = actualBytes[byte];
  fail(
    fixture,
    `first differing byte ${byte} (zero-based), key path ${keyPath}; expected ${
      expectedByte === undefined ? "<EOF>" : `0x${expectedByte.toString(16).padStart(2, "0")}`
    }, received ${actualByte === undefined ? "<EOF>" : `0x${actualByte.toString(16).padStart(2, "0")}`}`,
  );
}

async function pathKind(
  fixture: string,
  path: string,
): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const value = await stat(path);
    if (value.isFile()) {
      return "file";
    }
    if (value.isDirectory()) {
      return "directory";
    }
    return "other";
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return "missing";
    }
    fail(fixture, `cannot inspect ${relative(FIXTURE_ROOT, path)}: ${String(error)}`);
  }
}

async function detectGoldenState(
  fixture: string,
  legacyPath: string,
  splitDirectory: string,
): Promise<GoldenState> {
  const [legacyKind, splitKind] = await Promise.all([
    pathKind(fixture, legacyPath),
    pathKind(fixture, splitDirectory),
  ]);
  if (legacyKind === "file" && splitKind === "missing") {
    return { kind: "pre-rename", monolithPath: legacyPath };
  }
  if (legacyKind !== "missing") {
    fail(fixture, `unexpected legacy golden path type or ambiguous layout: ${legacyKind}`);
  }
  if (splitKind !== "directory") {
    fail(fixture, `expected golden-output/ directory; received ${splitKind}`);
  }

  const entries = await readdir(splitDirectory, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isFile() === true && entries[0].name === "report.json") {
    return {
      kind: "transitional",
      monolithPath: join(splitDirectory, "report.json"),
    };
  }
  return { kind: "post-split", directory: splitDirectory };
}

async function verifyFixture(fixture: string, tempRoot: string): Promise<string> {
  const expectedBytes = await baselineBytes(fixture);
  const expectedRaw = new TextDecoder().decode(expectedBytes);
  const expected = parseGolden(fixture, expectedRaw);
  const legacyPath = join(FIXTURE_ROOT, fixture, "golden-output.json");
  const splitDirectory = join(FIXTURE_ROOT, fixture, "golden-output");
  const state = await detectGoldenState(fixture, legacyPath, splitDirectory);

  if (state.kind !== "post-split") {
    const worktreeBytes = new Uint8Array(await readFile(state.monolithPath));
    const byte = firstDifferingByte(expectedBytes, worktreeBytes);
    if (byte !== undefined) {
      fail(fixture, `worktree monolith differs from ${BASELINE_REF} at byte ${byte}`);
    }
  }

  const result =
    state.kind === "post-split"
      ? {
          source: "post-split directory",
          reconstructed: await readSplitGolden(fixture, state.directory),
        }
      : await (async () => {
          const monolith = parseGolden(fixture, await readFile(state.monolithPath, "utf8"));
          const temporarySplit = join(tempRoot, fixture, "golden-output");
          await writeSplitGolden(temporarySplit, monolith);
          const temporaryState = await detectGoldenState(
            fixture,
            join(tempRoot, fixture, "golden-output.json"),
            temporarySplit,
          );
          if (temporaryState.kind !== "post-split") {
            fail(fixture, `temporary split classified as ${temporaryState.kind}`);
          }
          return {
            source: state.kind === "pre-rename" ? "pre-rename monolith" : "transitional monolith",
            reconstructed: await readSplitGolden(fixture, temporaryState.directory),
          };
        })();

  await assertEquivalent(fixture, expectedBytes, expected, result.reconstructed);
  return `PASS ${fixture}: ${result.source} reconstructs ${expectedBytes.byteLength} baseline bytes exactly`;
}

const tempRoot = await mkdtemp(join(tmpdir(), "market-bot-golden-split-oracle-"));
try {
  const lines = await Promise.all(FIXTURES.map((fixture) => verifyFixture(fixture, tempRoot)));
  process.stdout.write(`${lines.join("\n")}\n`);
  process.stdout.write(
    `PASS all ${FIXTURES.length} fixtures match pre-split baseline ${BASELINE_REF}\n`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
