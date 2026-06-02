import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildProviderHealthSummary,
  writeProviderHealthSummary,
} from "../src/health/provider-health";

let tmpDir = "";
let dataDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "provider-health-test-"));
  dataDir = join(tmpDir, "runs");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

describe("provider health", () => {
  test("summarizes real-run validation and provider gaps", async () => {
    await writeJson(join(dataDir, "run-1", "report.json"), {
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    });
    await writeJson(join(dataDir, "run-1", "normalized", "source-gaps.json"), [
      {
        source: "yahoo-regime",
        message: "yahoo-regime source request failed with status 401",
      },
      {
        source: "marketaux-news",
        message: "missing MARKET_BOT_MARKETAUX_API_TOKEN",
      },
    ]);
    await writeJson(join(dataDir, "run-1", "analytics.json"), {
      newsDedupe: {
        persistentSuppressedNewsSourceCount: 4,
        repeatFallbackKeptCount: 1,
      },
      evidenceQuality: {
        marketContext: { itemCount: 0, gapCount: 1 },
      },
    });
    await writeJson(join(dataDir, "run-1", "score.json"), {
      scores: [{ predictionId: "pred-1", resolved: true }],
    });

    await writeJson(join(dataDir, "run-2", "report.json"), {
      runId: "run-2",
      generatedAt: "2026-06-02T00:00:00.000Z",
      jobType: "ticker",
      assetClass: "equity",
      symbol: "AAPL",
    });
    await writeJson(join(dataDir, "run-2", "normalized", "source-gaps.json"), [
      {
        source: "massive-supplemental-market",
        provider: "massive",
        message: "massive-supplemental-market source request failed with status 403",
      },
    ]);
    await writeJson(join(dataDir, "run-2", "analytics.json"), {
      depth: "deep",
      evidenceQuality: {
        extendedEvidence: { itemCount: 2, gapCount: 0 },
      },
    });
    await writeJson(join(tmpDir, "calibration", "summary.json"), { generatedAt: "now" });

    const summary = await buildProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    expect(summary.runCount).toBe(2);
    expect(summary.realRunValidation).toMatchObject({
      marketUpdateRuns: 1,
      tickerRuns: 1,
      deepTickerRuns: 1,
      extendedEvidenceRuns: 1,
      marketContextRuns: 1,
      persistentNewsSuppressed: 4,
      repeatFallbackKept: 1,
      scoredRuns: 1,
      resolvedPredictions: 1,
      calibrationPresent: true,
    });
    expect(summary.gapOverview).toEqual({
      total: 3,
      missingCredential: 1,
      fetchFailed: 1,
      yahooAuth: 1,
      other: 0,
    });
    expect(summary.routes.find((route) => route.route === "yahoo-regime")).toMatchObject({
      provider: "yahoo",
      total: 1,
      yahooAuth: 1,
      statuses: { "401": 1 },
    });
  });

  test("writes json and markdown health views", async () => {
    await writeJson(join(dataDir, "run-1", "report.json"), {
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      jobType: "daily",
      assetClass: "crypto",
      depth: "brief",
    });

    const result = await writeProviderHealthSummary(dataDir, new Date("2026-06-02T12:00:00.000Z"));

    await expect(readFile(result.jsonPath, "utf8")).resolves.toContain('"runCount": 1');
    await expect(readFile(result.markdownPath, "utf8")).resolves.toContain("# Provider Health");
  });
});
