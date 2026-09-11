import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  INDEX_SCHEMA_VERSION,
  listRunSummariesFromIndex,
  loadConditionalCalibrationCountsFromIndex,
  loadResolvedPairsFromIndex,
  loadRunSubsystemOutcomesFromIndex,
  readRunArtifactIndexStatus,
  rebuildRunArtifactIndex,
  searchHistoryEntriesFromIndex,
  searchRunReportsFromIndex,
  writeThroughRunArtifactIndex,
} from "../src/run-artifact-index";
import { rebuildRunArtifactIndexIfStale } from "../src/run-artifact-index-repair";
import type { SubsystemOutcome } from "../src/research/subsystem-outcomes";
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
  options: {
    readonly writeScore?: boolean;
    readonly outcomes?: readonly SubsystemOutcome[];
  } = {},
): void {
  const runDir = join(dataDir, runId);
  mkdirSync(join(runDir, "normalized"), { recursive: true });
  writeJson(
    join(runDir, "report.json"),
    researchReport({
      runId,
      jobType: "equity",
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
      predictionShortfall: { emittedCount: 1, targetCount: 2, missingCount: 1 },
      dataGaps: ["needle gap"],
      extras: { depth: "deep" },
    }),
  );
  if (options.writeScore ?? true) {
    writeJson(join(runDir, "score.json"), { runId, scores: [] });
  }
  if (options.outcomes !== undefined) {
    writeJson(join(runDir, "outcomes.json"), options.outcomes);
  }
  writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
}

describe("run artifact index", () => {
  test("indexes a Failed Run Artifact without report projections", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "failed-run");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "failure.json"), { schemaVersion: 1 });
    writeJson(join(runDir, "outcomes.json"), [
      {
        subsystem: "final-synthesis",
        expectation: "expected",
        outcome: "failed",
        code: "final-synthesis-rejected",
        stage: "final-synthesis",
        count: 2,
        detail: { reportRepairReprompts: 2 },
      },
    ] satisfies readonly SubsystemOutcome[]);
    writeJson(join(runDir, "rejected-report.json"), { summary: "rejected" });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const db = new Database(dbPath, { readonly: true });
    const row = db.query<{ report_status: string }, []>("SELECT report_status FROM runs").get();
    const searchCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM search_entries")
      .get();
    const predictionCount = db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM predictions")
      .get();
    db.close();

    const summaries = await listRunSummariesFromIndex(dataDir);
    const outcomes = await loadRunSubsystemOutcomesFromIndex(dataDir);
    expect(row?.report_status).toBe("failed");
    expect(searchCount?.count).toBe(0);
    expect(predictionCount?.count).toBe(0);
    expect(outcomes).toEqual([
      {
        runId: "failed-run",
        status: "ok",
        outcomes: [
          {
            runId: "failed-run",
            subsystem: "final-synthesis",
            expectation: "expected",
            outcome: "failed",
            code: "final-synthesis-rejected",
            stage: "final-synthesis",
            count: 2,
            detail: { reportRepairReprompts: 2 },
          },
        ],
      },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries?.[0]?.availableFiles).toContain("failure.json");
  });

  test("round trips replacement outcomes through index rows and projection", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const historical = {
      subsystem: "web-gather",
      expectation: "optional",
      outcome: "empty",
      code: "validation-exhausted",
    } satisfies SubsystemOutcome;
    writeRun(dataDir, "run-a", {
      outcomes: [historical],
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    await expect(loadRunSubsystemOutcomesFromIndex(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        status: "ok",
        outcomes: [{ runId: "run-a", ...historical }],
      },
    ]);

    const replacement = [
      {
        subsystem: "prediction-completion",
        expectation: "expected",
        outcome: "produced",
        code: "produced",
        count: 3,
        detail: { acceptedSourceCount: 3 },
      },
    ] satisfies readonly SubsystemOutcome[];
    writeJson(join(dataDir, "run-a", "outcomes.json"), replacement);
    await writeThroughRunArtifactIndex(dataDir, [join(dataDir, "run-a")], { dbPath });

    await expect(loadRunSubsystemOutcomesFromIndex(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        status: "ok",
        outcomes: replacement.map((outcome) => ({ runId: "run-a", ...outcome })),
      },
    ]);
  });

  test("does not observe a write-through that commits after freshness on the same connection", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-a", {
      outcomes: [
        {
          subsystem: "web-gather",
          expectation: "optional",
          outcome: "produced",
          code: "produced",
        },
      ],
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const freshnessModule = await import("../src/run-artifact-index-freshness");
    const originalIsFresh = freshnessModule.indexIsFresh;
    const freshnessSpy = spyOn(freshnessModule, "indexIsFresh").mockImplementation(
      async (dataDirArg, db, warn, diskDirNames) => {
        const fresh = await originalIsFresh(dataDirArg, db, warn, diskDirNames);
        if (!fresh) {
          return false;
        }
        writeRun(dataDir, "run-b", {
          outcomes: [
            {
              subsystem: "web-gather",
              expectation: "optional",
              outcome: "produced",
              code: "produced",
            },
          ],
        });
        await writeThroughRunArtifactIndex(dataDir, [join(dataDir, "run-b")], { dbPath });
        return true;
      },
    );

    try {
      const ledgers = await loadRunSubsystemOutcomesFromIndex(dataDir, ["run-a"]);
      expect(freshnessSpy).toHaveBeenCalled();
      expect(ledgers?.map((ledger) => ledger.runId)).toEqual(["run-a"]);
    } finally {
      freshnessSpy.mockRestore();
    }
  });

  test("keeps absent and malformed outcome ledgers distinct", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "absent");
    writeRun(dataDir, "malformed");
    writeJson(join(dataDir, "malformed", "outcomes.json"), { outcomes: [] });
    writeRun(dataDir, "duplicate", {
      outcomes: [
        {
          subsystem: "web-gather",
          expectation: "optional",
          outcome: "produced",
          code: "produced",
        },
        {
          subsystem: "web-gather",
          expectation: "optional",
          outcome: "empty",
          code: "no-accepted-requests",
        },
      ],
    });

    const result = await rebuildRunArtifactIndex(dataDir, { dbPath });

    expect(result.malformedRunCount).toBe(2);
    await expect(loadRunSubsystemOutcomesFromIndex(dataDir)).resolves.toEqual([
      { runId: "absent", status: "absent", outcomes: [] },
      { runId: "duplicate", status: "malformed", outcomes: [] },
      { runId: "malformed", status: "malformed", outcomes: [] },
    ]);
  });

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
      message: `Run Artifact Index schema version 4 is not compatible with the current expected version ${String(
        INDEX_SCHEMA_VERSION,
      )}. The index will not be auto-migrated or auto-rebuilt. To update, run: bun run src/cli.ts index rebuild`,
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
    const db = new Database(dbPath, { readonly: true });
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
    db.close();
    expect(columns.map((column) => column.name)).toContain("evidence_quality");
    expect(columns.map((column) => column.name)).not.toContain("confidence");

    await expect(listRunSummariesFromIndex(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        depth: "deep",
        confidence: "medium",
        findingCount: 1,
        predictionCount: 1,
        sourceCount: 1,
        dataGapCount: 2,
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
      jobType: "equity",
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
          prediction({
            id: "p-void",
            kind: "conditional",
            subject: "QQQ",
            measurableAs:
              "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
            horizonTradingDays: 10,
            probability: 0.62,
          }),
          prediction({ id: "p-v2" }),
          prediction({ id: "p-unversioned" }),
          prediction({
            id: "p-void-v2",
            kind: "conditional",
            subject: "QQQ",
            measurableAs:
              "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
            horizonTradingDays: 10,
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
          scoringVersion: 3,
        }),
        {
          predictionId: "p-void",
          runId: "run-cal",
          status: "voided",
          resolved: true,
          outcome: undefined,
          observedAt: "2026-06-02T00:00:00.000Z",
          attemptCount: 1,
          scoringVersion: 3,
          evidence: { reason: "conditional antecedent did not occur" },
        },
        predictionScore("miss", {
          predictionId: "p-v2",
          runId: "run-cal",
          scoringVersion: 2,
        }),
        predictionScore("miss", {
          predictionId: "p-unversioned",
          runId: "run-cal",
        }),
        {
          predictionId: "p-void-v2",
          runId: "run-cal",
          status: "voided",
          resolved: true,
          outcome: undefined,
          observedAt: "2026-06-02T00:00:00.000Z",
          attemptCount: 1,
          scoringVersion: 2,
          evidence: { reason: "conditional antecedent did not occur" },
        },
      ],
    });
    writeJson(join(runDir, "miss-autopsy.json"), {
      version: 1,
      runId: "run-cal",
      generatedAt: "2026-06-03T00:00:00.000Z",
      autopsies: [
        {
          predictionId: "p-cal",
          runId: "run-cal",
          observedAt: "2026-06-02T00:00:00.000Z",
          scoreOutcome: "hit",
          probability: 0.7,
          forecastError: "underpredicted",
          cause: "insufficient_evidence",
          rationale: "Material forecast error without deterministic cause.",
          supportingSignals: ["persisted artifacts do not identify a deterministic cause"],
          evidence: {},
        },
      ],
    });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const pairs = await loadResolvedPairsFromIndex(dataDir);
    expect(pairs).toHaveLength(1);
    expect(pairs?.[0]?.prediction.id).toBe("p-cal");
    expect(pairs?.[0]?.score.outcome).toBe("hit");
    // The index row itself carries the autopsy cause, so a warm index never
    // Re-reads run directories to recover it.
    expect(pairs?.[0]?.missAutopsyCause).toBe("insufficient_evidence");
    await expect(loadConditionalCalibrationCountsFromIndex(dataDir)).resolves.toEqual({
      activatedCount: 0,
      voidedCount: 1,
    });

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const summary = await buildAndWriteCalibration(dataDir, new Date("2026-06-03T00:00:00.000Z"));
    expect(summary?.resolvedCount).toBe(1);
    expect(summary?.brierScore).toBeCloseTo(0.09, 2);
    expect(summary?.byMissAutopsyCause).toEqual({ insufficient_evidence: 1 });
    expect(summary?.conditionalPredictions).toEqual({ activatedCount: 0, voidedCount: 1 });
    delete process.env.MARKET_BOT_INDEX_DISABLE;

    const indexedSummary = await buildAndWriteCalibration(
      dataDir,
      new Date("2026-06-03T00:00:00.000Z"),
    );
    expect(indexedSummary?.resolvedCount).toBe(summary?.resolvedCount);
    expect(indexedSummary?.brierScore).toBe(summary?.brierScore);
    expect(indexedSummary?.byMissAutopsyCause).toEqual(summary?.byMissAutopsyCause);
    expect(indexedSummary?.conditionalPredictions).toEqual(summary?.conditionalPredictions);

    const calibrationPath = join(rootDir, "calibration", "summary.json");
    expect(existsSync(calibrationPath)).toBe(true);
  });

  test("replaces a legacy-only calibration summary with an empty v3 summary", async () => {
    const { dataDir, dbPath, rootDir } = await tempDataDir();
    const runDir = join(dataDir, "run-legacy-calibration");
    const calibrationDir = join(rootDir, "calibration");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(calibrationDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-legacy-calibration",
        predictions: [prediction({ id: "p-v2" })],
      }),
    );
    writeJson(join(runDir, "score.json"), {
      runId: "run-legacy-calibration",
      scores: [
        predictionScore("hit", {
          predictionId: "p-v2",
          runId: "run-legacy-calibration",
          scoringVersion: 2,
        }),
      ],
    });
    writeJson(join(calibrationDir, "summary.json"), {
      resolvedCount: 1,
      brierScore: 0.1,
      brierSkillScore: 0.6,
    });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const summary = await buildAndWriteCalibration(dataDir, new Date("2026-06-03T00:00:00.000Z"));

    expect(summary?.resolvedCount).toBe(0);
    expect(summary?.hitRate).toBeUndefined();
    expect(summary).not.toHaveProperty("brierSkillScore");
    const persisted = JSON.parse(
      await Bun.file(join(calibrationDir, "summary.json")).text(),
    ) as Record<string, unknown>;
    expect(persisted.resolvedCount).toBe(0);
    expect(persisted).not.toHaveProperty("brierSkillScore");
    // The legacy 0.1 Brier must not be replaced by a 0 that reads as perfect.
    expect(persisted).not.toHaveProperty("brierScore");
    expect(persisted).not.toHaveProperty("hitRate");
  });

  test("falls back to disk for calibration when the index is still schema v9", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeRun(dataDir, "run-v9");
    writeJson(join(dataDir, "run-v9", "score.json"), {
      runId: "run-v9",
      scores: [
        predictionScore("hit", {
          predictionId: "p1",
          runId: "run-v9",
          scoringVersion: 3,
        }),
      ],
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const oldIndex = new Database(dbPath);
    oldIndex.exec("ALTER TABLE scores DROP COLUMN miss_autopsy_cause; PRAGMA user_version = 9");
    oldIndex.close();

    await expect(rebuildRunArtifactIndexIfStale(dataDir, { dbPath })).resolves.toEqual({
      rebuilt: false,
    });
    const stderr = captureStderr();
    const summary = await buildAndWriteCalibration(dataDir, new Date("2026-06-03T00:00:00.000Z"));

    expect(summary?.resolvedCount).toBe(1);
    expect(summary?.hitRate).toBe(1);
    expect(summary?.brierScore).toBeCloseTo(0.1225, 4);
    expect(stderr.join("")).toContain(
      "unsupported schema version 9, falling back to disk scan; run bun run src/cli.ts index rebuild",
    );
    const unchangedIndex = new Database(dbPath, { readonly: true });
    expect(
      unchangedIndex.query("PRAGMA user_version").get() as { readonly user_version: number },
    ).toEqual({ user_version: 9 });
    expect(
      unchangedIndex
        .query<{ readonly name: string }, []>("PRAGMA table_info(scores)")
        .all()
        .map(({ name }) => name),
    ).not.toContain("miss_autopsy_cause");
    unchangedIndex.close();
  });

  test("carries the forecast-time market regime label through the index", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "run-regime");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-regime",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-06-01T00:00:00.000Z",
        predictions: [prediction({ id: "p-regime", probability: 0.7, horizonTradingDays: 5 })],
        extras: {
          marketRegime: {
            assetClass: "equity",
            label: "risk-off",
            proxyCount: 3,
            drivers: ["breadth"],
            sourceIds: ["s1"],
          },
        },
      }),
    );
    writeJson(join(runDir, "score.json"), {
      runId: "run-regime",
      scores: [
        predictionScore("hit", {
          predictionId: "p-regime",
          runId: "run-regime",
          observedAt: "2026-06-02T00:00:00.000Z",
          scoringVersion: 3,
        }),
      ],
    });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const pairs = await loadResolvedPairsFromIndex(dataDir);
    expect(pairs?.[0]?.marketRegimeLabel).toBe("risk-off");
  });

  test("buckets a market-overview pair by the run horizon, not the prediction horizon", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    const runDir = join(dataDir, "run-overview");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-overview",
        jobType: "market-overview",
        assetClass: "equity",
        generatedAt: "2026-06-01T00:00:00.000Z",
        // Run horizon 15 (=> 11-15d) but the prediction's own horizon is 3
        // (=> 1-5d). Calibration must bucket by the run horizon so the slice
        // Matches the disk path regardless of index freshness.
        horizonTradingDays: 15,
        predictions: [prediction({ id: "p-overview", probability: 0.7, horizonTradingDays: 3 })],
      }),
    );
    writeJson(join(runDir, "score.json"), {
      runId: "run-overview",
      scores: [
        predictionScore("hit", {
          predictionId: "p-overview",
          runId: "run-overview",
          observedAt: "2026-06-02T00:00:00.000Z",
          scoringVersion: 3,
        }),
      ],
    });

    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const pairs = await loadResolvedPairsFromIndex(dataDir);
    expect(pairs?.[0]?.marketUpdateHorizonBucket).toBe("11-15d");
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

    // Miss-autopsy sidecar written after the rebuild — triggers sidecar mismatch.
    writeJson(join(dataDir, "run-a", "miss-autopsy.json"), {
      version: 1,
      runId: "run-a",
      generatedAt: "2026-05-20T00:00:00.000Z",
      autopsies: [],
    });

    const result = await rebuildRunArtifactIndexIfStale(dataDir, { dbPath });

    expect(result).toEqual({ rebuilt: true });

    // The sidecar row is now reflected.
    const summaries = await listRunSummariesFromIndex(dataDir);
    expect(summaries?.[0]?.availableFiles).toContain("miss-autopsy.json");
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
