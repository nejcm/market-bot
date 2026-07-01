import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseObservableExpression } from "../src/forecast/observable";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";
import {
  loadFixture,
  runFixture,
  type FixtureMeta,
  type RunFixtureResult,
} from "./support/run-fixtures";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const FIXTURES = ["equity-aapl-brief", "equity-aapl-deep"] as const;
const VOLATILE_KEYS = new Set([
  "runId",
  "generatedAt",
  "startedAt",
  "completedAt",
  "tokenEstimate",
  "costEstimateUsd",
  "effectiveConfigHash",
  "dirtySourceHash",
]);

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

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
      Object.entries(value).map(([key, item]) => [
        key,
        VOLATILE_KEYS.has(key) ? `<${key}>` : scrub(item),
      ]),
    );
  }
  if (typeof value === "string") {
    return value.replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}/gu, "<run-id>");
  }
  return value;
}

async function scrubbedArtifacts(runDir: string): Promise<JsonValue> {
  const markdown = await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8");
  return scrub({
    report: await readJson(join(runDir, RUN_ARTIFACT_FILES.report)),
    analytics: await readJson(join(runDir, RUN_ARTIFACT_FILES.analytics)),
    markdown,
    normalized: await readNormalizedArtifacts(runDir),
  });
}

async function expectedGolden(name: string): Promise<JsonValue> {
  return readJson(join(import.meta.dir, "fixtures", "runs", name, "golden-output.json"));
}

function assertInvariants(result: RunFixtureResult, name: string, meta: FixtureMeta): void {
  const report = validateResearchReport(result.report);
  assertSafeReportLanguage(report);
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
  expect(result.sourcePlan).toBeDefined();
  expect(result.evidenceLanes.summary.plannedLaneCount).toBeGreaterThan(0);
  expect(result.analytics.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
  if (name.endsWith("-deep")) {
    expect(result.stageOutputs.map((output) => output.stage)).toEqual(
      expect.arrayContaining(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    if ((meta.challengerModels ?? []).length > 0) {
      expect(result.trace.forecastDisagreement?.challengerModelCount).toBe(
        meta.challengerModels?.length,
      );
    }
  }
}

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const result = await runFixture(name, { llm: "replay" });
      runResults.push(result);

      assertInvariants(result, name, fixture.meta);
      expect(await scrubbedArtifacts(result.artifacts.runDir)).toEqual(await expectedGolden(name));
    });
  }
});
