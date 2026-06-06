import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scorePassOptions } from "../src/app";
import type { ModelProvider } from "../src/model/types";
import type { PersistedResearchJobResult } from "../src/research/orchestrator";
import { collectedSources, researchReport } from "./support/fixtures";

const dataDirs: string[] = [];
const originalDataDir = process.env.MARKET_BOT_DATA_DIR;
const originalCacheDir = process.env.MARKET_BOT_CACHE_DIR;
const originalApeWisdomFilter = process.env.MARKET_BOT_APEWISDOM_FILTER;

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.MARKET_BOT_DATA_DIR;
  } else {
    process.env.MARKET_BOT_DATA_DIR = originalDataDir;
  }
  if (originalCacheDir === undefined) {
    delete process.env.MARKET_BOT_CACHE_DIR;
  } else {
    process.env.MARKET_BOT_CACHE_DIR = originalCacheDir;
  }
  if (originalApeWisdomFilter === undefined) {
    delete process.env.MARKET_BOT_APEWISDOM_FILTER;
  } else {
    process.env.MARKET_BOT_APEWISDOM_FILTER = originalApeWisdomFilter;
  }

  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

describe("scorePassOptions", () => {
  test("disables scorer close cache when source cache is disabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: true,
      }),
    ).toEqual({});
  });

  test("uses cache dir for scorer close cache when cache is enabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: false,
      }),
    ).toEqual({ closeCacheDir: "data/cache" });
  });

  test("passes macro and IV provider keys to scorer options", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        fredApiKey: "fred-key",
        tradierApiToken: "tradier-token",
        cacheDir: "data/cache",
        cacheDisabled: false,
      }),
    ).toEqual({
      closeCacheDir: "data/cache",
      fredApiKey: "fred-key",
      tradierApiToken: "tradier-token",
    });
  });
});

describe("runCli", () => {
  test("scores prediction runs after persisting the new report", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-score-order-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];
    const provider: ModelProvider = {
      name: "test",
      generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
    };
    const runDir = join(dataDir, "run-1");

    const result = await runCli(["daily", "--asset", "equity"], {
      createProvider: () => provider,
      collectSources: async () => collectedSources(),
      persistResearchJob: async () => {
        calls.push("persist");
        return {
          report: researchReport({ runId: "run-1" }),
          markdown: "",
          trace: {},
          analytics: {},
          stageOutputs: [],
          collectedSources: collectedSources(),
          historicalContext: {},
          artifacts: {
            runDir,
            rawDir: join(runDir, "raw"),
            normalizedDir: join(runDir, "normalized"),
          },
        } as unknown as PersistedResearchJobResult;
      },
      runScorePass: async (receivedDataDir) => {
        calls.push("score");
        expect(receivedDataDir).toBe(dataDir);
        return { scored: 1, skipped: 0 };
      },
      buildAndWriteCalibration: async (receivedDataDir) => {
        calls.push("calibration");
        expect(receivedDataDir).toBe(dataDir);
        return null;
      },
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toBe(runDir);
    expect(calls).toEqual(["persist", "score", "calibration"]);
  });

  test("reports when calibration has no resolved predictions to write", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-app-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    await expect(runCli(["calibration"])).resolves.toBe(
      "Calibration summary not written: no resolved predictions found",
    );
  });

  test("ignores malformed alpha-search config for unrelated commands", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-calibration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    process.env.MARKET_BOT_APEWISDOM_FILTER = "all/stocks";

    await expect(runCli(["calibration"])).resolves.toBe(
      "Calibration summary not written: no resolved predictions found",
    );
  });

  test("validates alpha-search config for alpha-search commands", async () => {
    process.env.MARKET_BOT_APEWISDOM_FILTER = "all/stocks";

    await expect(runCli(["alpha-search", "--asset", "equity"])).rejects.toThrow(
      "Invalid ApeWisdom filter",
    );
  });

  test("cache prune reports cache pruning without raw snapshot redaction", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-prune-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    process.env.MARKET_BOT_CACHE_DIR = join(dataDir, "cache");

    await expect(runCli(["cache", "prune"])).resolves.toBe(
      "Cache prune complete: 0 raw day(s), 0 close file(s) pruned",
    );
  });

  test("runs history rebuild through CLI dispatch", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-history-rebuild-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    await expect(
      runCli(["history", "rebuild"], {
        rebuildHistoryArtifacts: async (receivedDataDir) => {
          expect(receivedDataDir).toBe(dataDir);
          return {
            historyDir: join(dataDir, "..", "history"),
            indexPath: join(dataDir, "..", "history", "index.json"),
            instrumentCount: 1,
            sourceRunCount: 2,
            malformedRunCount: 0,
          };
        },
      }),
    ).resolves.toBe("History rebuilt: 2 run(s), 1 instrument timeline(s), 0 malformed");
  });
});
