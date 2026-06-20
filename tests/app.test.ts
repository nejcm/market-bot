import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlphaSearchWorkflowResult } from "../src/alpha-search/workflow";
import { runCli, scorePassOptions } from "../src/app";
import type { ModelProvider } from "../src/model/types";
import type { PersistedResearchJobResult } from "../src/research/orchestrator";
import { collectedSources, researchReport } from "./support/fixtures";

// Minimal run-quality analytics that renderRunAnalyticsConsole can summarize without
// Throwing. These doubles cast the result through `unknown`, so full type fidelity is
// Unnecessary; only the fields the stderr summary reads need to be present.
const analyticsStub = {
  jobType: "daily",
  runId: "run-1",
  evidenceQuality: { confidence: "low", dataGapCount: 0 },
  predictions: {
    count: 0,
    targetCount: 0,
    targetMet: true,
    informativeCount: 0,
    nearBaseRateCount: 0,
    signalTargetMet: true,
    mixWarnings: [],
  },
};

const dataDirs: string[] = [];
const originalDataDir = process.env.MARKET_BOT_DATA_DIR;
const originalCacheDir = process.env.MARKET_BOT_CACHE_DIR;
const originalApeWisdomFilter = process.env.MARKET_BOT_APEWISDOM_FILTER;
const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;

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
          analytics: analyticsStub,
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
        return { scored: 1, skipped: 0, touchedRunDirs: [] };
      },
      buildAndWriteCalibration: async (receivedDataDir) => {
        calls.push("calibration");
        expect(receivedDataDir).toBe(dataDir);
        return null;
      },
      writeThroughRunArtifactIndex: async (receivedDataDir, runDirs) => {
        calls.push("index");
        expect(receivedDataDir).toBe(dataDir);
        expect(runDirs).toEqual(["run-1"]);
      },
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toBe(runDir);
    expect(calls).toEqual(["persist", "score", "calibration", "index"]);
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

  test("updates the run artifact index after alpha-search", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-alpha-index-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];
    const runDir = join(dataDir, "alpha-run");

    const result = await runCli(["alpha-search", "--asset", "equity"], {
      runAlphaSearchWorkflow: async () => {
        calls.push("alpha-search");
        return {
          report: researchReport({ runId: "alpha-run", jobType: "alpha-search" }),
          markdown: "",
          trace: {},
          analytics: analyticsStub,
          artifacts: {
            runDir,
            rawDir: join(runDir, "raw"),
            normalizedDir: join(runDir, "normalized"),
          },
        } as unknown as AlphaSearchWorkflowResult;
      },
      writeThroughRunArtifactIndex: async (receivedDataDir, runDirs) => {
        calls.push("index");
        expect(receivedDataDir).toBe(dataDir);
        expect(runDirs).toEqual(["alpha-run"]);
      },
    });

    expect(result).toBe(runDir);
    expect(calls).toEqual(["alpha-search", "index"]);
  });

  test("resolves registered thematic research subject before persistence", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-research-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "research-run");

    await runCli(["research", "semis"], {
      createProvider: () => ({
        name: "test" as const,
        generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
      }),
      collectSources: async (command) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "semis",
          subjectKey: "semiconductors",
          predictionProxySymbol: "SMH",
        });
        return collectedSources();
      },
      persistResearchJob: async ({ command }) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "semis",
          subjectKey: "semiconductors",
          predictionProxySymbol: "SMH",
        });
        return {
          report: researchReport({ runId: "research-run", jobType: "research" }),
          markdown: "",
          trace: {},
          analytics: analyticsStub,
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
      runScorePass: async () => ({ scored: 0, skipped: 0, touchedRunDirs: [] }),
      buildAndWriteCalibration: async () => null,
      writeThroughRunArtifactIndex: async () => {},
      rebuildRunArtifactIndexIfStale: async () => ({ rebuilt: false }),
    });
  });

  test("keeps unregistered thematic research subject runnable without proxy", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-research-unresolved-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "research-run");

    await runCli(["research", "frontier", "widgets"], {
      createProvider: () => ({
        name: "test" as const,
        generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
      }),
      collectSources: async (command) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "frontier widgets",
        });
        expect("subjectKey" in command).toBe(false);
        expect("predictionProxySymbol" in command).toBe(false);
        return collectedSources();
      },
      persistResearchJob: async ({ command }) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "frontier widgets",
        });
        expect("subjectKey" in command).toBe(false);
        expect("predictionProxySymbol" in command).toBe(false);
        return {
          report: researchReport({ runId: "research-run", jobType: "research" }),
          markdown: "",
          trace: {},
          analytics: analyticsStub,
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
      runScorePass: async () => ({ scored: 0, skipped: 0, touchedRunDirs: [] }),
      buildAndWriteCalibration: async () => null,
      writeThroughRunArtifactIndex: async () => {},
      rebuildRunArtifactIndexIfStale: async () => ({ rebuilt: false }),
    });
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

  test("runs index rebuild through CLI dispatch", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-index-rebuild-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    await expect(
      runCli(["index", "rebuild"], {
        rebuildRunArtifactIndex: async (receivedDataDir, options) => {
          expect(receivedDataDir).toBe(dataDir);
          expect(options?.dbPath).toBe(join(dataDir, "index.sqlite"));
          return {
            dbPath: join(dataDir, "index.sqlite"),
            sourceRunCount: 2,
            malformedRunCount: 1,
            artifactFileCount: 6,
            searchEntryCount: 10,
          };
        },
      }),
    ).resolves.toBe("Index rebuilt: 2 run(s), 1 malformed, 6 file(s), 10 search entries");
  });

  test("invokes stale-rebuild follow-up after write-through on a research run", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-stale-rebuild-order-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];
    const runDir = join(dataDir, "run-1");
    // Capture rebuild args, then assert after runCli resolves.
    // Throws inside the callback are swallowed by updateRunArtifactIndex's .catch.
    const staleRebuildArgs: { readonly dataDir: string; readonly options: unknown }[] = [];

    const result = await runCli(["daily", "--asset", "equity"], {
      createProvider: () => ({
        name: "test" as const,
        generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
      }),
      collectSources: async () => collectedSources(),
      persistResearchJob: async () => {
        calls.push("persist");
        return {
          report: researchReport({ runId: "run-1" }),
          markdown: "",
          trace: {},
          analytics: analyticsStub,
          stageOutputs: [],
          collectedSources: collectedSources(),
          historicalContext: {},
          artifacts: {
            runDir,
            rawDir: join(runDir, "raw"),
            normalizedDir: join(runDir, "normalized"),
          },
        } as never;
      },
      runScorePass: async () => {
        calls.push("score");
        return { scored: 0, skipped: 0, touchedRunDirs: [] };
      },
      buildAndWriteCalibration: async () => {
        calls.push("calibration");
        return null;
      },
      writeThroughRunArtifactIndex: async () => {
        calls.push("index");
      },
      rebuildRunArtifactIndexIfStale: async (receivedDataDir, options) => {
        calls.push("stale-rebuild");
        staleRebuildArgs.push({ dataDir: receivedDataDir, options });
        return { rebuilt: false };
      },
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toBe(runDir);
    expect(calls).toEqual(["persist", "score", "calibration", "index", "stale-rebuild"]);
    expect(staleRebuildArgs).toHaveLength(1);
    expect(staleRebuildArgs[0]?.dataDir).toBe(dataDir);
    // The CLI forwards the resolved index dbPath (config defaults it from dataDir).
    expect(staleRebuildArgs[0]?.options).toEqual({ dbPath: join(dataDir, "index.sqlite") });
  });

  test("stale-rebuild error does not abort the research run", async () => {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const dataDir = join(
      tmpdir(),
      `market-bot-stale-rebuild-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "run-1");

    try {
      const result = await runCli(["daily", "--asset", "equity"], {
        createProvider: () => ({
          name: "test" as const,
          generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
        }),
        collectSources: async () => collectedSources(),
        persistResearchJob: async () =>
          ({
            report: researchReport({ runId: "run-1" }),
            markdown: "",
            trace: {},
            analytics: analyticsStub,
            stageOutputs: [],
            collectedSources: collectedSources(),
            historicalContext: {},
            artifacts: {
              runDir,
              rawDir: join(runDir, "raw"),
              normalizedDir: join(runDir, "normalized"),
            },
          }) as never,
        runScorePass: async () => ({ scored: 0, skipped: 0, touchedRunDirs: [] }),
        buildAndWriteCalibration: async () => null,
        writeThroughRunArtifactIndex: async () => {},
        rebuildRunArtifactIndexIfStale: async () => {
          throw new Error("simulated repair failure");
        },
        now: () => new Date("2026-06-01T00:00:00.000Z"),
      });

      // Run must succeed despite the repair error.
      expect(result).toBe(runDir);
      expect(stderrChunks.join("")).toContain("stale-rebuild failed");
      expect(stderrChunks.join("")).toContain("simulated repair failure");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });
});
