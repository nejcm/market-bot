import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResearchConsoleRequest, researchConsoleStaticPath } from "../app/server";
import { prediction, researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("research console app static assets", () => {
  test("resolves built files under dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const assetDir = join(distDir, "assets");
    mkdirSync(assetDir);
    const assetPath = join(assetDir, "index.js");
    writeFileSync(assetPath, "export {};\n", "utf8");

    expect(researchConsoleStaticPath("/assets/index.js", distDir)).toBe(assetPath);
  });

  test("falls back to index for client routes", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const indexPath = join(distDir, "index.html");
    writeFileSync(indexPath, "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/runs/abc", distDir)).toBe(indexPath);
  });

  test("rejects paths outside dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    writeFileSync(join(distDir, "index.html"), "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/../secret.txt", distDir)).toBeUndefined();
    expect(researchConsoleStaticPath("/%2e%2e/secret.txt", distDir)).toBeUndefined();
  });
});

describe("research console app API", () => {
  test("serves run summaries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-1");
    mkdirSync(runDir);
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-1", summary: "Summary" }));

    const response = await handleResearchConsoleRequest(new Request("http://127.0.0.1/api/runs"), {
      dataDir,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runs: [{ runId: "run-1", findingCount: 0, predictionCount: 0 }],
    });
  });

  test("serves run detail", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-2");
    mkdirSync(runDir);
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-2", summary: "Detail" }));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-2"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: { runId: "run-2" },
      report: { summary: "Detail" },
    });
  });

  test("serves verified snapshot through run detail", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-snapshot");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-snapshot",
        jobType: "ticker",
        assetClass: "equity",
        symbol: "AAPL",
      }),
    );
    writeJson(join(runDir, "normalized", "verified-market-snapshot.json"), {
      symbol: "AAPL",
      assetClass: "equity",
      analysisDate: "2026-06-05",
      fetchedAt: "2026-06-05T00:00:00.000Z",
      latestSessionDate: "2026-06-04",
      ohlcv: { date: "2026-06-04", open: 1, high: 2, low: 1, close: 2, volume: 3 },
      indicators: {},
      recentCloses: [
        { date: "2026-06-03", close: 1 },
        { date: "2026-06-04", close: 2 },
      ],
    });

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-snapshot"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly verifiedMarketSnapshot?: {
        readonly symbol?: string;
        readonly recentCloses?: readonly { readonly date: string; readonly close: number }[];
      };
    };
    expect(payload.verifiedMarketSnapshot?.symbol).toBe("AAPL");
    expect(payload.verifiedMarketSnapshot?.recentCloses?.[0]).toEqual({
      date: "2026-06-03",
      close: 1,
    });
  });

  test("returns not found for missing runs", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/missing"),
      { dataDir },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
  });

  test("serves provider health", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const healthDir = join(rootDir, "provider-health");
    mkdirSync(dataDir);
    mkdirSync(healthDir);
    writeJson(join(healthDir, "summary.json"), { verdict: "warn" });
    writeFileSync(join(healthDir, "summary.md"), "# Health\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/provider-health"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: { verdict: "warn" },
      markdown: "# Health\n",
    });
  });

  test("serves calibration summary", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const calibrationDir = join(rootDir, "calibration");
    mkdirSync(dataDir);
    mkdirSync(calibrationDir);
    writeJson(join(calibrationDir, "summary.json"), { resolvedCount: 13, brierScore: 0.2583 });
    writeFileSync(join(calibrationDir, "summary.md"), "# Calibration\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/calibration"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: { resolvedCount: 13, brierScore: 0.2583 },
      markdown: "# Calibration\n",
    });
  });

  test("serves alpha cohort summary", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const alphaDir = join(rootDir, "alpha-search");
    mkdirSync(dataDir);
    mkdirSync(alphaDir);
    writeJson(join(alphaDir, "cohorts.json"), { rejectedCandidateCount: 2 });
    writeFileSync(join(alphaDir, "cohorts.md"), "# Alpha Lead Cohorts\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/alpha-cohorts"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: { rejectedCandidateCount: 2 },
      markdown: "# Alpha Lead Cohorts\n",
    });
  });

  test("serves empty calibration detail when artifacts are absent", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/calibration"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
  });

  test("serves instrument timeline with normalized symbol and market-update forecasts", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-market");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-market",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-06-05T00:00:00.000Z",
        predictions: [
          prediction({
            id: "p-aapl",
            subject: "AAPL",
            measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
          }),
          prediction({
            id: "p-msft",
            claim: "MSFT malformed forecast.",
            subject: "MSFT",
            measurableAs: "not observable",
          }),
        ],
      }),
    );
    writeJson(join(runDir, "score.json"), {
      scores: [
        {
          predictionId: "p-aapl",
          runId: "run-market",
          resolved: true,
          outcome: "hit",
          observedAt: "2026-06-10T00:00:00.000Z",
          attemptCount: 1,
          evidence: {},
        },
      ],
    });
    writeJson(join(runDir, "normalized", "verified-market-snapshot.json"), {
      symbol: "MSFT",
      assetClass: "equity",
      analysisDate: "2026-06-05",
      fetchedAt: "2026-06-05T00:00:00.000Z",
      latestSessionDate: "2026-06-04",
      ohlcv: { date: "2026-06-04", open: 1, high: 2, low: 1, close: 2, volume: 3 },
      indicators: {},
      recentCloses: [
        { date: "2026-06-03", close: 1 },
        { date: "2026-06-04", close: 2 },
      ],
    });

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/instruments/equity/aapl/timeline"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      assetClass: "equity",
      symbol: "AAPL",
      entries: [
        {
          runId: "run-market",
          scope: "market-update",
          outcome: "event-true",
        },
      ],
      pricePoints: [],
      counts: { total: 1, eventTrue: 1 },
      warnings: { malformedPredictionCount: 0 },
    });
  });

  test("rejects invalid instrument asset class", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/instruments/forex/EURUSD/timeline"),
      { dataDir },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid instrument request" });
  });

  test("rejects invalid instrument symbols", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/instruments/equity/%20/timeline"),
      { dataDir },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid instrument request" });
  });

  test("serves run files by safe relative path", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-3");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeFileSync(join(runDir, "normalized", "source-gaps.json"), "[]\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-3/files?path=normalized%2Fsource-gaps.json"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "normalized/source-gaps.json",
      content: "[]\n",
    });
  });

  test("rejects unsafe run file paths", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-4");
    mkdirSync(runDir);

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-4/files?path=..%2Fsecret.txt"),
      { dataDir },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "File not found" });
  });

  test("serves structured run search results", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-5");
    mkdirSync(runDir);
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-5",
        summary: "Searchable report summary",
        symbol: "AAPL",
      }),
    );

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/search?query=searchable&symbol=AAPL"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ run: { runId: "run-5" }, section: "summary", label: "Summary" }],
    });
  });

  test("decodes special character structured search queries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-special");
    mkdirSync(runDir);
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-special",
        summary: "net+margin% expansion",
      }),
    );
    const params = new URLSearchParams({ query: "net+margin%" });

    const response = await handleResearchConsoleRequest(
      new Request(`http://127.0.0.1/api/search?${params.toString()}`),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      results: [{ run: { runId: "run-special" }, section: "summary" }],
    });
  });

  test("rejects empty structured search queries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/search?query=%20"),
      { dataDir },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Search query is required" });
  });

  test("caps structured search results and skips malformed reports", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const malformedDir = join(dataDir, "malformed");
    mkdirSync(malformedDir);
    writeFileSync(join(malformedDir, "report.json"), "{", "utf8");

    for (let index = 0; index < 101; index += 1) {
      const runDir = join(dataDir, `run-${String(index).padStart(3, "0")}`);
      mkdirSync(runDir);
      writeJson(
        join(runDir, "report.json"),
        researchReport({
          runId: `run-${String(index).padStart(3, "0")}`,
          generatedAt: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
          summary: "needle capped result",
        }),
      );
    }

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/search?query=needle"),
      { dataDir },
    );
    const payload = (await response.json()) as { readonly results?: readonly unknown[] };

    expect(response.status).toBe(200);
    expect(payload.results?.length).toBe(100);
  });
});
