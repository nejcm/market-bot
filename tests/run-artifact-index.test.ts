import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  INDEX_SCHEMA_VERSION,
  listRunSummariesFromIndex,
  loadResolvedPairsFromIndex,
  readRunArtifactIndexStatus,
  rebuildRunArtifactIndex,
  searchHistoryEntriesFromIndex,
  searchRunReportsFromIndex,
  writeThroughRunArtifactIndex,
} from "../src/run-artifact-index";
import { rebuildRunArtifactIndexIfStale } from "../src/run-artifact-index-repair";
import { buildAndWriteCalibration } from "../src/scoring/index";
import { prediction, predictionScore, researchReport, newsSource } from "./support/fixtures";

const tmpDirs: string[] = [];
const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

afterEach(async () => {
  process.stderr.write = originalStderrWrite;
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

function captureStderr(): string[] {
  const chunks: string[] = [];
  process.stderr.write = ((chunk) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return chunks;
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
  test("reports unsupported schema with rebuild guidance", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA user_version = 4");
    db.close();

    expect(readRunArtifactIndexStatus(dataDir)).toEqual({
      state: "unsupported-schema",
      dbPath,
      expectedSchemaVersion: INDEX_SCHEMA_VERSION,
      currentSchemaVersion: 4,
      rebuildCommand: "bun run src/cli.ts index rebuild",
      message: `Run Artifact Index schema 4 is unsupported; expected ${String(
        INDEX_SCHEMA_VERSION,
      )}. Run bun run src/cli.ts index rebuild.`,
    });
  });

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
    const stderr = captureStderr();

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
    expect(stderr.join("")).toContain("run directory set mismatch");
  });

  test("returns undefined when a mutable sidecar is added after rebuild", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a", { writeScore: false });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    writeJson(join(dataDir, "run-a", "score.json"), { runId: "run-a", scores: [] });
    const stderr = captureStderr();

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
    expect(stderr.join("")).toContain("mutable sidecar mismatch");
  });

  test("warns when write-through is skipped because the index database is missing", async () => {
    const { dataDir } = await tempDataDir();
    const stderr = captureStderr();

    await writeThroughRunArtifactIndex(dataDir, ["run-a"], {
      dbPath: join(dataDir, "missing.sqlite"),
    });

    expect(stderr.join("")).toContain("index database missing");
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

  test("serves resolved prediction pairs for calibration", async () => {
    const { dataDir, dbPath, rootDir } = await tempDataDir();
    const runDir = join(dataDir, "run-cal");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-cal",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-06-01T00:00:00.000Z",
        predictions: [
          prediction({
            id: "p-cal",
            probability: 0.7,
            horizonTradingDays: 5,
          }),
        ],
      }),
    );
    writeJson(join(runDir, "score.json"), {
      runId: "run-cal",
      scores: [
        predictionScore("hit", {
          predictionId: "p-cal",
          runId: "run-cal",
          observedAt: "2026-06-02T00:00:00.000Z",
        }),
      ],
    });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const pairs = await loadResolvedPairsFromIndex(dataDir);
    expect(pairs).toHaveLength(1);
    expect(pairs?.[0]?.prediction.id).toBe("p-cal");
    expect(pairs?.[0]?.score.outcome).toBe("hit");

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const summary = await buildAndWriteCalibration(dataDir, new Date("2026-06-03T00:00:00.000Z"));
    expect(summary?.resolvedCount).toBe(1);
    expect(summary?.brierScore).toBeCloseTo(0.09, 2);
    delete process.env.MARKET_BOT_INDEX_DISABLE;

    const indexedSummary = await buildAndWriteCalibration(
      dataDir,
      new Date("2026-06-03T00:00:00.000Z"),
    );
    expect(indexedSummary?.resolvedCount).toBe(summary?.resolvedCount);
    expect(indexedSummary?.brierScore).toBe(summary?.brierScore);

    const calibrationPath = join(rootDir, "calibration", "summary.json");
    expect(existsSync(calibrationPath)).toBe(true);
  });

  test("returns undefined when the index is disabled", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    process.env.MARKET_BOT_INDEX_DISABLE = "1";

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toBeUndefined();
  });

  test("rebuilds when duplicate source ids appear in one report", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "run-dup-sources");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-dup-sources",
        jobType: "alpha-search",
        assetClass: "equity",
        generatedAt: "2026-06-01T00:00:00.000Z",
        sources: [
          newsSource({
            id: "apewisdom-all-stocks-CTS",
            title: "ApeWisdom CTS social momentum rank 21",
            provider: "apewisdom",
            kind: "discussion",
          }),
          newsSource({
            id: "apewisdom-all-stocks-CTS",
            title: "ApeWisdom CTS social momentum rank 22",
            provider: "apewisdom",
            kind: "discussion",
          }),
        ],
      }),
    );
    writeJson(join(runDir, "score.json"), { runId: "run-dup-sources", scores: [] });

    const result = await rebuildRunArtifactIndex(dataDir, { dbPath });

    expect(result.sourceRunCount).toBe(1);
    expect(result.malformedRunCount).toBe(0);
    await expect(listRunSummariesFromIndex(dataDir)).resolves.toEqual([
      expect.objectContaining({ runId: "run-dup-sources", sourceCount: 2 }),
    ]);
  });

  test("rebuilds when duplicate prediction ids appear in one report", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "run-dup-predictions");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-dup-predictions",
        generatedAt: "2026-06-01T00:00:00.000Z",
        predictions: [
          prediction({
            id: "p-dup",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
          }),
          prediction({
            id: "p-dup",
            subject: "QQQ",
            measurableAs: "close(QQQ, +5) > close(QQQ, 0)",
          }),
        ],
      }),
    );
    writeJson(join(runDir, "score.json"), { runId: "run-dup-predictions", scores: [] });

    const result = await rebuildRunArtifactIndex(dataDir, { dbPath });

    expect(result.sourceRunCount).toBe(1);
    expect(result.malformedRunCount).toBe(0);
    const historyResults = await searchHistoryEntriesFromIndex(dataDir, {
      query: "QQQ closes higher",
      section: "predictions",
    });
    expect(
      historyResults?.some((entry) =>
        entry.text.includes("QQQ closes higher than today over 5 trading days"),
      ),
    ).toBe(true);
  });

  test("falls back to stored claim when legacy measurableAs is unparseable", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "run-legacy-prediction");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-legacy-prediction",
        generatedAt: "2026-06-01T00:00:00.000Z",
        predictions: [
          prediction({
            id: "p-legacy",
            claim: "legacy stored forecast",
            measurableAs: "legacy custom predicate",
          }),
        ],
      }),
    );
    writeJson(join(runDir, "score.json"), { runId: "run-legacy-prediction", scores: [] });

    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const historyResults = await searchHistoryEntriesFromIndex(dataDir, {
      query: "legacy stored forecast",
      section: "predictions",
    });
    expect(historyResults?.map((entry) => entry.text)).toEqual(["legacy stored forecast"]);
  });
});

describe("rebuildRunArtifactIndexIfStale", () => {
  test("heals a stale index caused by a run-directory-set mismatch", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    // Simulate drift: a new run dir appears on disk but was never write-through'd.
    mkdirSync(join(dataDir, "run-new"));

    const stderr = captureStderr();
    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: true });
    const stderrText = stderr.join("");
    expect(stderrText).toContain("stale, rebuilding");
    expect(stderrText).not.toContain("falling back to disk scan");

    // Index is fresh after repair and includes the new directory.
    const summaries = await listRunSummariesFromIndex(dataDir);
    expect(summaries).toBeDefined();
    expect(summaries?.map((s) => s.runId)).toContain("run-new");
  });

  test("heals a stale index caused by a mutable sidecar mismatch", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a", { writeScore: false });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    // Score sidecar written after the rebuild — triggers sidecar mismatch.
    writeJson(join(dataDir, "run-a", "score.json"), { runId: "run-a", scores: [] });

    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: true });

    // The sidecar row is now reflected.
    const summaries = await listRunSummariesFromIndex(dataDir);
    expect(summaries?.[0]?.hasScore).toBe(true);
  });

  test("no-op when the index is already fresh", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const stderr = captureStderr();
    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: false });
    expect(stderr.join("")).not.toContain("rebuilding");
  });

  test("no-op when the database is missing (no auto-create)", async () => {
    const { dataDir } = await tempDataDir();
    writeRun(dataDir, "run-a");
    const missingDbPath = join(dataDir, "..", "nonexistent.sqlite");

    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath: missingDbPath });

    expect(result).toEqual({ rebuilt: false });
    expect(existsSync(missingDbPath)).toBe(false);
  });

  test("no-op when the schema version is unsupported (no auto-migrate)", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA user_version = 1");
    db.close();

    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: false });
    // Schema must be untouched.
    const db2 = new Database(dbPath, { readonly: true });
    const version = db2.query("PRAGMA user_version").get() as { readonly user_version: number };
    db2.close();
    expect(version.user_version).toBe(1);
  });

  test("no-op when the index is disabled via MARKET_BOT_INDEX_DISABLE", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    // Create drift: a new run dir appears on disk.
    mkdirSync(join(dataDir, "run-new"));

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: false });
  });

  test("honors an explicit options.dbPath differing from the env default", async () => {
    const { dataDir } = await tempDataDir();
    // Put the real DB at a custom path, different from the env-default.
    const customDbPath = join(dataDir, "..", "custom-index.sqlite");
    writeRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath: customDbPath });
    // Drift on disk: env default points elsewhere, orchestrator must use customDbPath.
    mkdirSync(join(dataDir, "run-new"));

    process.env.MARKET_BOT_INDEX_DB_PATH = join(dataDir, "..", "other.sqlite");

    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath: customDbPath });

    expect(result).toEqual({ rebuilt: true });
    // Verify the rebuild landed at the custom path, not the env default.
    expect(existsSync(customDbPath)).toBe(true);
  });
});
