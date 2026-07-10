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

// Alpha-search analytics has its own shape; the stderr summary reads alphaSearch and
// SourceFunnel counts. Only those fields need to be present on this double.
const alphaAnalyticsStub = {
  jobType: "alpha-search",
  runId: "alpha-run",
  sourceFunnel: {
    reportSources: { total: 0 },
    sourceGaps: { total: 0 },
    dataGaps: { total: 0 },
  },
  alphaSearch: {
    socialCandidateCount: 0,
    secCandidateCount: 0,
    validLeadCount: 0,
    researchLeadCount: 0,
    rejectedCandidateCount: 0,
    fundamentalGapCount: 0,
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
  test("passes force only from the explicit score command", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-score-force-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const receivedForces: (boolean | undefined)[] = [];

    await runCli(["score", "--force"], {
      runScorePass: async (_dataDir, _now, options) => {
        receivedForces.push(options?.force);
        return { scored: 0, skipped: 0, touchedRunDirs: [] };
      },
      buildAndWriteCalibration: async () => null,
      writeThroughRunArtifactIndex: async () => {},
      rebuildRunArtifactIndexIfStale: async () => ({ rebuilt: false }),
    });

    expect(receivedForces).toEqual([true]);
  });

  test("runs a best-effort score pass before the run and again after persisting", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-score-order-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];
    const indexedRunDirs: (readonly string[])[] = [];
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
        // The pre-run pass resolves an older run; the post-run pass finds
        // Nothing new. Both sets of touched dirs must reach the index.
        return calls.filter((call) => call === "score").length === 1
          ? { scored: 1, skipped: 0, touchedRunDirs: ["old-run"] }
          : { scored: 0, skipped: 0, touchedRunDirs: [] };
      },
      buildAndWriteCalibration: async (receivedDataDir) => {
        calls.push("calibration");
        expect(receivedDataDir).toBe(dataDir);
        return null;
      },
      writeThroughRunArtifactIndex: async (receivedDataDir, runDirs) => {
        calls.push("index");
        expect(receivedDataDir).toBe(dataDir);
        indexedRunDirs.push(runDirs);
      },
      rebuildRunArtifactIndexIfStale: async () => ({ rebuilt: false }),
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result).toBe(runDir);
    expect(calls).toEqual(["score", "index", "persist", "score", "calibration", "index"]);
    expect(indexedRunDirs).toEqual([["old-run"], ["run-1"]]);
  });

  test("indexes pre-run score mutations before a later collection failure", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-prerun-index-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];

    await expect(
      runCli(["daily", "--asset", "equity"], {
        createProvider: () => ({
          name: "test" as const,
          generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
        }),
        runScorePass: async () => {
          calls.push("score");
          return { scored: 1, skipped: 0, touchedRunDirs: ["old-run"] };
        },
        writeThroughRunArtifactIndex: async (_receivedDataDir, runDirs) => {
          calls.push("index");
          expect(runDirs).toEqual(["old-run"]);
        },
        rebuildRunArtifactIndexIfStale: async () => {
          calls.push("stale-rebuild");
          return { rebuilt: false };
        },
        collectSources: async () => {
          calls.push("collect");
          throw new Error("simulated collection failure");
        },
        now: () => new Date("2026-06-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("simulated collection failure");

    expect(calls).toEqual(["score", "index", "stale-rebuild", "collect"]);
  });

  test("freezes the Source Plan before source collection begins", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-plan-order-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const events: string[] = [];
    let clockCalls = 0;
    const provider: ModelProvider = {
      name: "test",
      generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
    };
    const runDir = join(dataDir, "run-1");
    let receivedSourcePlan: unknown;

    await runCli(["equity", "AAPL", "--deep"], {
      createProvider: () => provider,
      collectSources: async () => {
        events.push("collect");
        return collectedSources();
      },
      persistResearchJob: async (input) => {
        events.push("persist");
        receivedSourcePlan = input.sourcePlan;
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
      runScorePass: async () => ({ scored: 0, skipped: 0, touchedRunDirs: [] }),
      buildAndWriteCalibration: async () => null,
      writeThroughRunArtifactIndex: async () => {},
      now: () => {
        clockCalls += 1;
        events.push(`clock-${String(clockCalls)}`);
        return new Date(Date.UTC(2026, 5, 1, 0, 0, clockCalls));
      },
    });

    // Clock-1 is the pre-run score pass; clock-2 is the plan's capture, which
    // Happens before the collect call, which happens before persistence
    // Receives the frozen plan.
    expect(events.indexOf("clock-2")).toBeLessThan(events.indexOf("collect"));
    expect(events.indexOf("collect")).toBeLessThan(events.indexOf("persist"));
    expect(receivedSourcePlan).toMatchObject({
      version: 2,
      generatedAt: "2026-06-01T00:00:02.000Z",
      run: { jobType: "equity", symbol: "AAPL", depth: "deep" },
    });
  });

  test("writes an explicit empty calibration dashboard with no resolved v3 predictions", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-app-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    const output = await runCli(["calibration"]);
    expect(output).toContain("Resolved:    0 predictions");
    expect(output).toContain("Hit rate:    0.0%");
    expect(output).toContain("Small sample (0 of 5 minimum)");
  });

  test("ignores malformed alpha-search config for unrelated commands", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-calibration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    process.env.MARKET_BOT_APEWISDOM_FILTER = "all/stocks";

    const output = await runCli(["calibration"]);
    expect(output).toContain("Resolved:    0 predictions");
    expect(output).toContain("Small sample (0 of 5 minimum)");
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
          analytics: alphaAnalyticsStub,
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

  test("resolves embedded thematic subject before persistence", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-research-embedded-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "research-run");

    await runCli(["research", "Top-10", "list", "of", "promising", "biotech", "stocks"], {
      createProvider: () => ({
        name: "test" as const,
        generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
      }),
      collectSources: async (command) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "Top-10 list of promising biotech stocks",
          subjectKey: "biotech",
          predictionProxySymbol: "XBI",
        });
        return collectedSources();
      },
      persistResearchJob: async ({ command }) => {
        expect(command).toMatchObject({
          jobType: "research",
          subject: "Top-10 list of promising biotech stocks",
          subjectKey: "biotech",
          predictionProxySymbol: "XBI",
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
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const dataDir = join(
      tmpdir(),
      `market-bot-research-unresolved-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "research-run");

    try {
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

      const stderr = stderrChunks.join("");
      expect(stderr).toContain('Research subject unresolved: "frontier widgets".');
      expect(stderr).toContain("Supported subjects: Semiconductors, Software");
      expect(stderr).not.toContain("Closest match:");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
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

  test("rebuilds stale history before executing history search", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-history-search-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];

    await expect(
      runCli(["history", "search", "--query", "risk"], {
        rebuildHistoryArtifacts: async () => {
          calls.push("rebuild");
          return {
            historyDir: join(dataDir, "..", "history"),
            indexPath: join(dataDir, "..", "history", "index.json"),
            instrumentCount: 0,
            sourceRunCount: 0,
            malformedRunCount: 0,
          };
        },
        searchHistoryIndex: async () => {
          calls.push("search");
          return [];
        },
      }),
    ).resolves.toBe("No history results found");
    expect(calls).toEqual(["rebuild", "search"]);
  });

  test("rebuilds stale history before executing thesis delta", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-history-delta-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const calls: string[] = [];

    const output = await runCli(["history", "thesis-delta", "AAPL"], {
      rebuildHistoryArtifacts: async () => {
        calls.push("rebuild");
        return {
          historyDir: join(dataDir, "..", "history"),
          indexPath: join(dataDir, "..", "history", "index.json"),
          instrumentCount: 1,
          sourceRunCount: 2,
          malformedRunCount: 0,
        };
      },
      buildThesisDelta: async () => {
        calls.push("delta");
        return {
          version: 1,
          generatedAt: "2026-06-28T00:00:00.000Z",
          instrumentKey: "equity:AAPL",
          symbol: "AAPL",
          assetClass: "equity",
          fromRunId: "old",
          toRunId: "new",
          fromGeneratedAt: "2026-06-01T00:00:00.000Z",
          toGeneratedAt: "2026-06-28T00:00:00.000Z",
          sections: {},
        };
      },
    });

    expect(calls).toEqual(["rebuild", "delta"]);
    expect(output).toContain("Research Thesis Delta: equity:AAPL");
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
    expect(calls).toEqual(["score", "persist", "score", "calibration", "index", "stale-rebuild"]);
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

  test("pre-run score pass failure logs to stderr and does not abort the research run", async () => {
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    const dataDir = join(
      tmpdir(),
      `market-bot-prerun-score-error-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    const runDir = join(dataDir, "run-1");
    let scoreCalls = 0;
    const events: string[] = [];

    try {
      const result = await runCli(["daily", "--asset", "equity"], {
        createProvider: () => ({
          name: "test" as const,
          generate: async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }),
        }),
        collectSources: async () => collectedSources(),
        persistResearchJob: async () => {
          events.push("persist");
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
          scoreCalls += 1;
          events.push(`score-${String(scoreCalls)}`);
          if (scoreCalls === 1) {
            throw new Error("simulated pre-run score failure");
          }
          return { scored: 0, skipped: 0, touchedRunDirs: [] };
        },
        buildAndWriteCalibration: async () => null,
        writeThroughRunArtifactIndex: async () => {
          events.push("index");
        },
        rebuildRunArtifactIndexIfStale: async () => {
          events.push("stale-rebuild");
          return { rebuilt: false };
        },
        now: () => new Date("2026-06-01T00:00:00.000Z"),
      });

      // Run must succeed despite the pre-run score error; the post-run pass
      // Still executes as the safety net.
      expect(result).toBe(runDir);
      expect(scoreCalls).toBe(2);
      expect(events).toEqual([
        "score-1",
        "index",
        "stale-rebuild",
        "persist",
        "score-2",
        "index",
        "stale-rebuild",
      ]);
      expect(stderrChunks.join("")).toContain("Pre-run score pass failed");
      expect(stderrChunks.join("")).toContain("simulated pre-run score failure");
    } finally {
      process.stderr.write = originalStderrWrite;
    }
  });
});
