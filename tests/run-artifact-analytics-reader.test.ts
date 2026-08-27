import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAnalytics } from "../src/run-artifact-analytics-reader";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "market-bot-analytics-reader-"));
  tmpDirs.push(dir);
  return dir;
}

describe("readAnalytics", () => {
  test("reports analytics.json as absent when it is missing", async () => {
    await expect(readAnalytics(await tempRunDir())).resolves.toEqual({ status: "absent" });
  });

  test("reports analytics.json as malformed when it is invalid", async () => {
    const runDir = await tempRunDir();
    await writeFile(join(runDir, RUN_ARTIFACT_FILES.analytics), "{not-json", "utf8");

    await expect(readAnalytics(runDir)).resolves.toEqual({ status: "malformed" });
  });

  test("reads a valid analytics.json object", async () => {
    const runDir = await tempRunDir();
    const analytics = { version: 2, runId: "run-1" };
    await writeFile(
      join(runDir, RUN_ARTIFACT_FILES.analytics),
      `${JSON.stringify(analytics)}\n`,
      "utf8",
    );

    await expect(readAnalytics(runDir)).resolves.toEqual({ status: "ok", value: analytics });
  });

  test.each([
    ["array", []],
    ["null", null],
    ["string", "x"],
    ["number", 42],
  ] as const)("preserves valid %s JSON values", async (_name, value) => {
    const runDir = await tempRunDir();
    await writeFile(
      join(runDir, RUN_ARTIFACT_FILES.analytics),
      `${JSON.stringify(value)}\n`,
      "utf8",
    );

    await expect(readAnalytics(runDir)).resolves.toEqual({ status: "ok", value });
  });
});
