import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRunSummariesFromIndex,
  rebuildRunArtifactIndex,
  searchHistoryEntriesFromIndex,
  searchRunReportsFromIndex,
  writeThroughRunArtifactIndex,
} from "../src/run-artifact-index";
import { prediction, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];
const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;

afterEach(async () => {
  if (originalIndexDbPath === undefined) {
    delete process.env.MARKET_BOT_INDEX_DB_PATH;
  } else {
    process.env.MARKET_BOT_INDEX_DB_PATH = originalIndexDbPath;
  }
  if (originalIndexDisable === undefined) {
    delete process.env.MARKET_BOT_INDEX_DISABLE;
  } else {
    process.env.MARKET_BOT_INDEX_DISABLE = originalIndexDisable;
  }
  await Promise.all(tmpDirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isBusyError(error) || attempt === 19) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}

function isBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EBUSY"
  );
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function tempDataDir(): Promise<{
  readonly rootDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "market-bot-index-"));
  tmpDirs.push(rootDir);
  const dataDir = join(rootDir, "runs");
  const dbPath = join(rootDir, "index.sqlite");
  mkdirSync(dataDir);
  process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
  return { rootDir, dataDir, dbPath };
}

function writeRun(
  dataDir: string,
  runId: string,
  options: { readonly writeScore?: boolean } = {},
): void {
  const runDir = join(dataDir, runId);
  mkdirSync(join(runDir, "normalized"), { recursive: true });
  writeJson(
    join(runDir, "report.json"),
    researchReport({
      runId,
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
      summary: "needle summary",
      keyFindings: [{ text: "needle finding", sourceIds: ["s1"] }],
      risks: [{ text: "needle risk", sourceIds: ["s1"] }],
      predictions: [
        prediction({
          id: "p1",
          claim: "needle forecast",
          subject: "AAPL",
          sourceIds: ["s2"],
        }),
      ],
      sources: [
        {
          id: "s3",
          title: "needle source",
          fetchedAt: "2026-06-01T00:00:00.000Z",
          kind: "news",
          provider: "yahoo",
          assetClass: "equity",
          symbol: "AAPL",
        },
      ],
      dataGaps: ["needle gap"],
      extras: { depth: "deep" },
    }),
  );
  if (options.writeScore ?? true) {
    writeJson(join(runDir, "score.json"), { runId, scores: [] });
  }
  writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
}

describe("run artifact index", () => {
  test("rebuilds SQLite metadata and serves console/history search", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");

    const result = await rebuildRunArtifactIndex(dataDir, { dbPath });

    expect(result.sourceRunCount).toBe(1);
    expect(result.malformedRunCount).toBe(0);
    expect(result.artifactFileCount).toBe(3);
    expect(result.searchEntryCount).toBeGreaterThan(0);

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        jobType: "ticker",
        assetClass: "equity",
        symbol: "AAPL",
        depth: "deep",
        confidence: "medium",
        findingCount: 1,
        predictionCount: 1,
        sourceCount: 1,
        dataGapCount: 1,
        hasScore: true,
        availableFiles: ["normalized", "report.json", "report.md", "score.json"].filter(
          (path) => path !== "normalized",
        ),
      },
    ]);

    const consoleResults = await searchRunReportsFromIndex(dataDir, { query: "needle" });
    expect(consoleResults?.map((entry) => entry.section)).toEqual([
      "summary",
      "keyFindings",
      "risks",
      "predictions",
      "sources",
      "dataGaps",
    ]);

    const historyResults = await searchHistoryEntriesFromIndex(dataDir, {
      query: "risk",
      symbol: "AAPL",
      assetClass: "equity",
      jobType: "ticker",
      section: "risks",
    });
    expect(historyResults?.map((entry) => entry.runId)).toEqual(["run-a"]);
  });

  test("returns undefined when the run directory set is stale", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    mkdirSync(join(dataDir, "run-new"));

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
  });

  test("returns undefined when a mutable sidecar is added after rebuild", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a", { writeScore: false });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    writeJson(join(dataDir, "run-a", "score.json"), { runId: "run-a", scores: [] });

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
  });

  test("write-through updates a mutable sidecar row in an existing index", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a", { writeScore: false });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    writeJson(join(dataDir, "run-a", "score.json"), { runId: "run-a", scores: [] });

    await writeThroughRunArtifactIndex(dataDir, [join(dataDir, "run-a")], { dbPath });

    const [summary] = (await listRunSummariesFromIndex(dataDir)) ?? [];
    expect(summary?.hasScore).toBe(true);
    expect(summary?.availableFiles).toContain("score.json");
  });

  test("returns undefined when the index is disabled", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    process.env.MARKET_BOT_INDEX_DISABLE = "1";

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
  });
});
