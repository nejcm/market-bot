import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { listRunSummaries, searchRunReports } from "../app/artifacts";
import { buildProviderHealthSummary } from "../src/health/provider-health";
import { rebuildHistoryArtifacts, searchHistoryIndex } from "../src/history/artifacts";
import {
  INDEX_SCHEMA_VERSION,
  loadRunSubsystemOutcomesFromIndex,
  rebuildRunArtifactIndex,
  scanRunSubsystemOutcomesFromDisk,
} from "../src/run-artifact-index";
import type { SubsystemOutcome } from "../src/research/subsystem-outcomes";
import { prediction, researchReport } from "./support/fixtures";

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
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "EBUSY" ||
        attempt === 19
      ) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
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
  readonly dataDir: string;
  readonly dbPath: string;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "market-bot-index-parity-"));
  tmpDirs.push(rootDir);
  const dataDir = join(rootDir, "runs");
  const dbPath = join(rootDir, "index.sqlite");
  mkdirSync(dataDir);
  process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
  delete process.env.MARKET_BOT_INDEX_DISABLE;
  return { dataDir, dbPath };
}

function searchResultKey(entry: {
  readonly run: { readonly runId: string };
  readonly section: string;
  readonly label: string;
}): string {
  return [entry.run.runId, entry.section, entry.label].join("\0");
}

function searchResultProjection(entry: {
  readonly run: { readonly runId: string };
  readonly section: string;
  readonly label: string;
  readonly snippet: string;
  readonly sourceIds: readonly string[];
}): {
  readonly runId: string;
  readonly section: string;
  readonly label: string;
  readonly snippet: string;
  readonly sourceIds: readonly string[];
} {
  return {
    runId: entry.run.runId,
    section: entry.section,
    label: entry.label,
    snippet: entry.snippet,
    sourceIds: entry.sourceIds,
  };
}

function writeFixtureRun(dataDir: string, runDirName: string, runId: string = runDirName): void {
  const runDir = join(dataDir, runDirName);
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
      dataGaps: ["needle gap"],
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [
          {
            category: "valuation",
            title: "AAPL Valuation Evidence",
            summary: "needle valuation EV/annualized revenue 12.3x",
            sourceIds: ["extended-valuation-aapl"],
            observedAt: "2026-06-01T00:00:00.000Z",
            metrics: { evToAnnualizedRevenue: 12.3 },
          },
        ],
        gaps: [],
      },
      extras: { depth: "deep" },
    }),
  );
  writeJson(join(runDir, "score.json"), { runId, scores: [] });
  writeJson(join(runDir, "outcomes.json"), [
    {
      subsystem: "web-gather",
      expectation: "optional",
      outcome: "produced",
      code: "produced",
      stage: "web-gather",
      count: 2,
      detail: { acceptedSourceCount: 2 },
    },
  ] satisfies readonly SubsystemOutcome[]);
  writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
}

describe("run artifact index parity", () => {
  test("indexed outcomes equal sidecar outcomes", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    writeFixtureRun(dataDir, "z-dir", "a-report");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const db = new Database(dbPath);
    const duplicate = db.prepare(`
      INSERT INTO subsystem_outcomes (
        run_id, subsystem, expectation, outcome, code, stage, count, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() =>
      duplicate.run("run-a", "web-gather", "optional", "empty", "duplicate", null, null, null),
    ).toThrow();
    duplicate.finalize();
    db.close();

    const indexed = await loadRunSubsystemOutcomesFromIndex(dataDir);
    const sidecar = await scanRunSubsystemOutcomesFromDisk(dataDir);

    expect(indexed).toEqual(sidecar);
    expect(indexed?.map((outcome) => outcome.runId)).toEqual(["a-report", "run-a"]);
  });

  test("provider health reads fresh outcome rows through the index projection", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    const db = new Database(dbPath);
    const update = db.prepare(
      "UPDATE subsystem_outcomes SET code = ? WHERE run_id = ? AND subsystem = ?",
    );
    update.run("indexed-produced", "run-a", "web-gather");
    update.finalize();
    db.close();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.subsystemOutcomes.byCode).toEqual({ "indexed-produced": 1 });
  });

  test("provider health outcome reads degrade to disk on index version mismatch", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    const db = new Database(dbPath, { create: true });
    db.exec(`PRAGMA user_version = ${String(INDEX_SCHEMA_VERSION - 1)}`);
    db.close();
    const stderr = captureStderr();

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.subsystemOutcomes.count).toBe(1);
    expect(summary.subsystemOutcomes.ledgerStatus).toEqual({ ok: 1, absent: 0, malformed: 0 });
    expect(stderr.join("")).toContain(
      `unsupported schema version ${String(INDEX_SCHEMA_VERSION - 1)}, falling back to disk scan`,
    );
  });

  test("console list and search match disk fallback", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    writeFixtureRun(dataDir, "run-b");
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const indexedSummaries = await listRunSummaries(dataDir);
    const indexedSearch = await searchRunReports(dataDir, { query: "needle" });

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const diskSummaries = await listRunSummaries(dataDir);
    const diskSearch = await searchRunReports(dataDir, { query: "needle" });

    expect(indexedSummaries).toEqual(diskSummaries);
    expect(
      indexedSearch
        .toSorted((left, right) => searchResultKey(left).localeCompare(searchResultKey(right)))
        .map((entry) => searchResultProjection(entry)),
    ).toEqual(
      diskSearch
        .toSorted((left, right) => searchResultKey(left).localeCompare(searchResultKey(right)))
        .map((entry) => searchResultProjection(entry)),
    );
  });

  test("console search section order matches disk fallback for dataGaps and extendedEvidence", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const indexedSearch = await searchRunReports(dataDir, { query: "needle" });

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const diskSearch = await searchRunReports(dataDir, { query: "needle" });

    const indexSections = indexedSearch.map((result) => result.section);
    const diskSections = diskSearch.map((result) => result.section);

    expect(indexSections).toEqual(diskSections);
    expect(indexSections.indexOf("dataGaps")).toBeLessThan(
      indexSections.indexOf("extendedEvidence"),
    );
    expect(diskSections.indexOf("dataGaps")).toBeLessThan(diskSections.indexOf("extendedEvidence"));
  });

  test("console search matches disk fallback for multi-word and partial queries", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    for (const query of ["needle source", "needl", "NEEDLE"]) {
      const indexedSearch = await searchRunReports(dataDir, { query });
      process.env.MARKET_BOT_INDEX_DISABLE = "1";
      const diskSearch = await searchRunReports(dataDir, { query });
      delete process.env.MARKET_BOT_INDEX_DISABLE;

      expect(indexedSearch.map((entry) => searchResultKey(entry)).toSorted()).toEqual(
        diskSearch.map((entry) => searchResultKey(entry)).toSorted(),
      );
    }
  });

  test("history search matches JSON index fallback", async () => {
    const { dataDir, dbPath } = await tempDataDir();
    writeFixtureRun(dataDir, "run-a");
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const indexedResults = await searchHistoryIndex(dataDir, {
      query: "risk",
      symbol: "AAPL",
      assetClass: "equity",
      jobType: "equity",
      section: "risks",
    });

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const diskResults = await searchHistoryIndex(dataDir, {
      query: "risk",
      symbol: "AAPL",
      assetClass: "equity",
      jobType: "equity",
      section: "risks",
    });

    expect(indexedResults.map((entry) => [entry.runId, entry.section, entry.text])).toEqual(
      diskResults.map((entry) => [entry.runId, entry.section, entry.text]),
    );
  });
});
