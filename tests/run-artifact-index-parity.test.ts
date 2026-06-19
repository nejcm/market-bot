import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunSummaries, searchRunReports } from "../app/artifacts";
import { rebuildHistoryArtifacts, searchHistoryIndex } from "../src/history/artifacts";
import { rebuildRunArtifactIndex } from "../src/run-artifact-index";
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

function writeFixtureRun(dataDir: string, runId: string): void {
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
  writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
}

describe("run artifact index parity", () => {
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
      jobType: "ticker",
      section: "risks",
    });

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    const diskResults = await searchHistoryIndex(dataDir, {
      query: "risk",
      symbol: "AAPL",
      assetClass: "equity",
      jobType: "ticker",
      section: "risks",
    });

    expect(indexedResults.map((entry) => [entry.runId, entry.section, entry.text])).toEqual(
      diskResults.map((entry) => [entry.runId, entry.section, entry.text]),
    );
  });
});
