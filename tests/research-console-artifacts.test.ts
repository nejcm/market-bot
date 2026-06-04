import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRunSummaries,
  readProviderHealth,
  readRunDetail,
  readRunFile,
  searchRunReports,
} from "../app/artifacts";
import { researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("research console app artifacts", () => {
  test("indexes run summaries from report artifacts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-a");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        keyFindings: [{ text: "Finding", sourceIds: ["s1"] }],
        predictions: [
          {
            id: "p1",
            claim: "SPY closes higher.",
            kind: "direction",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
            horizonTradingDays: 5,
            probability: 0.6,
            sourceIds: ["s1"],
          },
        ],
        sources: [
          { id: "s1", title: "Source", fetchedAt: "2026-06-01T00:00:00.000Z", kind: "news" },
        ],
        dataGaps: ["Missing provider"],
        extras: { depth: "deep" },
      }),
    );
    writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
    writeJson(join(runDir, "score.json"), { scores: [] });
    writeJson(join(runDir, "normalized", "source-gaps.json"), []);

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        jobType: "daily",
        assetClass: "equity",
        depth: "deep",
        confidence: "medium",
        findingCount: 1,
        predictionCount: 1,
        sourceCount: 1,
        dataGapCount: 1,
        hasScore: true,
        availableFiles: ["normalized/source-gaps.json", "report.json", "report.md", "score.json"],
      },
    ]);
  });

  test("tolerates runs with missing or malformed reports", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-b");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), "{", "utf8");

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-b",
        findingCount: 0,
        predictionCount: 0,
        sourceCount: 0,
        dataGapCount: 0,
        hasScore: false,
        availableFiles: ["report.json"],
      },
    ]);
  });

  test("reads structured run detail and markdown fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-c");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-c", summary: "Summary" }));
    writeFileSync(join(runDir, "report.md"), "# Markdown\n", "utf8");
    writeJson(join(runDir, "analytics.json"), { version: 1 });
    writeJson(join(runDir, "trace.json"), { stages: ["source-collection"] });
    writeJson(join(runDir, "score.json"), { scores: [] });

    const detail = await readRunDetail(dataDir, "run-c");

    expect(detail?.summary.runId).toBe("run-c");
    expect(detail?.report?.summary).toBe("Summary");
    expect(detail?.markdown).toBe("# Markdown\n");
    expect(detail?.analytics).toEqual({ version: 1 });
    expect(detail?.trace).toEqual({ stages: ["source-collection"] });
    expect(detail?.score).toEqual({ scores: [] });
  });

  test("reads run files inside the run directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-d");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeFileSync(join(runDir, "normalized", "source-gaps.json"), "[]\n", "utf8");

    await expect(readRunFile(dataDir, "run-d", "normalized/source-gaps.json")).resolves.toEqual({
      path: "normalized/source-gaps.json",
      content: "[]\n",
    });
  });

  test("rejects unsafe run ids and file paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-e");
    mkdirSync(runDir, { recursive: true });

    await expect(readRunDetail(dataDir, "../secret")).resolves.toBeUndefined();
    await expect(readRunDetail(dataDir, ".")).resolves.toBeUndefined();
    await expect(readRunFile(dataDir, "run-e", "../secret.txt")).resolves.toBeUndefined();
    await expect(readRunFile(dataDir, "run-e", "")).resolves.toBeUndefined();
  });

  test("rejects oversized run files", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-f");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "large.txt"), "x".repeat(5_000_001), "utf8");

    await expect(readRunFile(dataDir, "run-f", "large.txt")).resolves.toBeUndefined();
  });

  test("reads provider health sibling artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const healthDir = join(rootDir, "provider-health");
    mkdirSync(dataDir);
    mkdirSync(healthDir);
    writeJson(join(healthDir, "summary.json"), { verdict: "pass" });
    writeFileSync(join(healthDir, "summary.md"), "# Provider Health\n", "utf8");

    await expect(readProviderHealth(dataDir)).resolves.toEqual({
      summary: { verdict: "pass" },
      markdown: "# Provider Health\n",
    });
  });

  test("searches structured report sections", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-g");
    mkdirSync(runDir);
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-g",
        summary: "needle summary",
        keyFindings: [{ text: "needle finding", sourceIds: ["s1"] }],
        predictions: [
          {
            id: "p1",
            claim: "needle forecast",
            kind: "direction",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
            horizonTradingDays: 5,
            probability: 0.6,
            sourceIds: ["s2"],
          },
        ],
        sources: [
          {
            id: "s3",
            title: "needle source",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
        dataGaps: ["needle gap"],
      }),
    );

    const results = await searchRunReports(dataDir, { query: "needle" });

    expect(results.map((result) => result.section)).toEqual([
      "summary",
      "keyFindings",
      "predictions",
      "sources",
      "dataGaps",
    ]);
    expect(results.map((result) => result.sourceIds)).toEqual([[], ["s1"], ["s2"], ["s3"], []]);
  });

  test("filters structured report search by run metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const equityDir = join(dataDir, "run-h");
    const cryptoDir = join(dataDir, "run-i");
    mkdirSync(equityDir);
    mkdirSync(cryptoDir);
    writeJson(
      join(equityDir, "report.json"),
      researchReport({
        runId: "run-h",
        jobType: "ticker",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-06-01T00:00:00.000Z",
        summary: "needle equity",
      }),
    );
    writeJson(
      join(cryptoDir, "report.json"),
      researchReport({
        runId: "run-i",
        jobType: "daily",
        assetClass: "crypto",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "needle crypto",
      }),
    );

    const results = await searchRunReports(dataDir, {
      query: "needle",
      symbol: "aapl",
      assetClass: "equity",
      jobType: "ticker",
      from: "2026-06-01",
      to: "2026-06-01",
    });

    expect(results.map((result) => result.run.runId)).toEqual(["run-h"]);
  });

  test("ignores malformed reports during structured search", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-j");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "report.json"), "{", "utf8");

    await expect(searchRunReports(dataDir, { query: "needle" })).resolves.toEqual([]);
  });
});
