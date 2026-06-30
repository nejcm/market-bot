import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HistoryOptions } from "../src/config";
import {
  createHistoricalContextReader,
  loadHistoricalContext,
} from "../src/research/historical-context";
import { researchIdentityExtras } from "../src/research/research-subject-identity";
import { marketSnapshot, prediction, predictionScore, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-history-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeRun(input: {
  readonly dataDir: string;
  readonly runDirName: string;
  readonly report: ReturnType<typeof researchReport>;
  readonly snapshots?: readonly unknown[];
  readonly score?: unknown;
}): Promise<void> {
  const runDir = join(input.dataDir, input.runDirName);
  await writeJson(join(runDir, "report.json"), input.report);
  if (input.snapshots !== undefined) {
    await writeJson(join(runDir, "normalized", "market-snapshots.json"), input.snapshots);
  }
  if (input.score !== undefined) {
    await writeJson(join(runDir, "score.json"), input.score);
  }
}

function options(overrides: Partial<HistoryOptions> = {}): HistoryOptions {
  return {
    tickerRecentLimit: 1,
    marketRecentLimit: 1,
    recentDays: 30,
    anchorMonths: [3],
    missCorrectionLimit: 0,
    ...overrides,
  };
}

describe("loadHistoricalContext", () => {
  test("selects recent and anchor ticker history, market history, scores, and sources", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    const scoredPrediction = prediction({ id: "pred-aapl", subject: "AAPL" });

    await writeRun({
      dataDir,
      runDirName: "ticker-recent",
      report: researchReport({
        runId: "ticker-recent",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-20T00:00:00.000Z",
        summary: "Recent AAPL detail.",
        keyFindings: [{ text: "AAPL demand improved.", sourceIds: ["news-1"] }],
        predictions: [scoredPrediction],
      }),
      snapshots: [marketSnapshot({ symbol: "AAPL", price: 200, changePercent24h: 3 })],
      score: {
        scoredAt: "2026-05-28T00:00:00.000Z",
        scores: [
          predictionScore("hit", {
            predictionId: "pred-aapl",
            runId: "ticker-recent",
          }),
        ],
      },
    });
    await writeRun({
      dataDir,
      runDirName: "ticker-recent-over-cap",
      report: researchReport({
        runId: "ticker-recent-over-cap",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-10T00:00:00.000Z",
        summary: "Older recent AAPL detail.",
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "ticker-anchor",
      report: researchReport({
        runId: "ticker-anchor",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-01-15T00:00:00.000Z",
        summary: "Anchor AAPL detail.",
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "market-recent",
      report: researchReport({
        runId: "market-recent",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-18T00:00:00.000Z",
        summary: "Recent equity market.",
      }),
      snapshots: [
        marketSnapshot({ symbol: "AAPL", price: 195, changePercent24h: 2 }),
        marketSnapshot({ sourceId: "market-msft", symbol: "MSFT", price: 410 }),
      ],
    });
    await writeRun({
      dataDir,
      runDirName: "wrong-symbol",
      report: researchReport({
        runId: "wrong-symbol",
        jobType: "equity",
        assetClass: "equity",
        symbol: "MSFT",
        generatedAt: "2026-05-25T00:00:00.000Z",
      }),
    });
    await mkdir(join(dataDir, "malformed"), { recursive: true });
    await writeFile(join(dataDir, "malformed", "report.json"), "{bad-json", "utf8");
    await writeRun({
      dataDir: join(dirname(dataDir), "cache"),
      runDirName: "cache-run",
      report: researchReport({
        runId: "cache-run",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-30T00:00:00.000Z",
      }),
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: { historyOptions: options() },
      now,
    });

    expect(context.runs.map((run) => run.runId)).toEqual([
      "ticker-recent",
      "market-recent",
      "ticker-anchor",
    ]);
    expect(context.runs[0]?.predictions[0]).toMatchObject({
      id: "pred-aapl",
      scoreStatus: "resolved",
      scoreOutcome: "hit",
    });
    expect(context.runs[1]?.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL"]);
    expect(context.sources.map((source) => source.id)).toEqual([
      "history-report-ticker-recent",
      "history-report-market-recent",
      "history-report-ticker-anchor",
    ]);
    expect(context.audit).toMatchObject({
      malformedRunCount: 1,
      candidateRunCount: 4,
      selectedRunCount: 3,
      recentSelectedCount: 2,
      anchorSelectedCount: 1,
    });
    expect(context.runs.map((run) => run.runId)).not.toContain("cache-run");
  });

  test("carries compacted resolution evidence for misses only, whitelisting primitives", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "ticker-miss",
      report: researchReport({
        runId: "ticker-miss",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-20T00:00:00.000Z",
        predictions: [
          prediction({ id: "pred-miss", subject: "AAPL" }),
          prediction({ id: "pred-hit", subject: "AAPL" }),
        ],
      }),
      score: {
        scoredAt: "2026-05-28T00:00:00.000Z",
        scores: [
          predictionScore("miss", {
            predictionId: "pred-miss",
            runId: "ticker-miss",
            evidence: {
              close0: 180.5,
              closeN: 172.3,
              nested: { x: 1 },
              flag: true,
              returnPercent: -0.0454,
              startDate: "2026-05-20",
              endDate: "2026-05-28",
              source: "yahoo",
              extraPrimitive: "omitted",
            },
          }),
          predictionScore("hit", {
            predictionId: "pred-hit",
            runId: "ticker-miss",
            evidence: { close0: 1, closeN: 2 },
          }),
        ],
      },
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: { historyOptions: options() },
      now,
    });

    const preds = context.runs[0]?.predictions ?? [];
    const miss = preds.find((entry) => entry.id === "pred-miss");
    const hit = preds.find((entry) => entry.id === "pred-hit");
    expect(miss?.scoreEvidence).toEqual({
      close0: 180.5,
      closeN: 172.3,
      returnPercent: -0.0454,
      startDate: "2026-05-20",
      endDate: "2026-05-28",
      source: "yahoo",
    });
    expect(hit?.scoreEvidence).toBeUndefined();
  });

  test("softly reports no-history gaps without source gaps", async () => {
    const context = await loadHistoricalContext({
      dataDir: tempRunsDir(),
      command: {
        jobType: "market-overview",
        assetClass: "crypto",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      config: { historyOptions: options() },
      now: new Date("2026-06-04T00:00:00.000Z"),
    });

    expect(context.runs).toEqual([]);
    expect(context.sources).toEqual([]);
    expect(context.gaps).toEqual(["No prior crypto market-update runs found"]);
  });

  test("computes artifact-derived market deltas from selected run snapshots", async () => {
    const dataDir = tempRunsDir();
    await writeRun({
      dataDir,
      runDirName: "daily-old",
      report: researchReport({
        runId: "daily-old",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-10T00:00:00.000Z",
      }),
      snapshots: [marketSnapshot({ symbol: "AAPL", price: 100, changePercent24h: 1 })],
    });
    await writeRun({
      dataDir,
      runDirName: "daily-new",
      report: researchReport({
        runId: "daily-new",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-20T00:00:00.000Z",
      }),
      snapshots: [marketSnapshot({ symbol: "AAPL", price: 110, changePercent24h: 2.5 })],
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 15,
        legacyAlias: "weekly",
      },
      config: { historyOptions: options({ marketRecentLimit: 2, anchorMonths: [] }) },
      now: new Date("2026-06-04T00:00:00.000Z"),
    });

    expect(context.artifactDeltas).toEqual([
      {
        symbol: "AAPL",
        fromRunId: "daily-old",
        toRunId: "daily-new",
        fromGeneratedAt: "2026-05-10T00:00:00.000Z",
        toGeneratedAt: "2026-05-20T00:00:00.000Z",
        priceChangePercent: 10,
        changePercent24hDelta: 1.5,
      },
    ]);
  });

  test("reader reuses a stable artifact scan across selection loads", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "market-existing",
      report: researchReport({
        runId: "market-existing",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-20T00:00:00.000Z",
      }),
    });

    const reader = await createHistoricalContextReader(dataDir);

    await writeRun({
      dataDir,
      runDirName: "ticker-created-after-scan",
      report: researchReport({
        runId: "ticker-created-after-scan",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-25T00:00:00.000Z",
      }),
    });

    const context = await reader.load({
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      config: { historyOptions: options() },
      now,
      spotlightSymbols: ["AAPL"],
    });

    expect(context.runs.map((run) => run.runId)).toEqual(["market-existing"]);
    expect(context.audit).toMatchObject({
      scannedRunCount: 1,
      candidateRunCount: 1,
      selectedRunCount: 1,
    });
  });

  test("tags same-horizon, cross-horizon, and spotlight-symbol relevance reasons for market-update commands", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "daily-market",
      report: researchReport({
        runId: "daily-market",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-20T00:00:00.000Z",
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "weekly-market",
      report: researchReport({
        runId: "weekly-market",
        jobType: "weekly",
        assetClass: "equity",
        generatedAt: "2026-05-15T00:00:00.000Z",
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "spotlight-aapl",
      report: researchReport({
        runId: "spotlight-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-22T00:00:00.000Z",
      }),
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      config: { historyOptions: options({ marketRecentLimit: 2, tickerRecentLimit: 1 }) },
      now,
      spotlightSymbols: ["AAPL"],
    });

    const byId = new Map(context.runs.map((run) => [run.runId, run]));
    expect(byId.get("daily-market")?.selectionReasons).toContain("same-horizon");
    expect(byId.get("weekly-market")?.selectionReasons).toContain("cross-horizon");
    expect(byId.get("spotlight-aapl")?.selectionReasons).toContain("spotlight-symbol");
    expect(context.audit).toMatchObject({
      sameSymbolSelectedCount: 0,
      spotlightSymbolSelectedCount: 1,
      sameHorizonSelectedCount: 1,
      crossHorizonSelectedCount: 1,
    });
  });

  test("tags same-symbol relevance reason for ticker commands", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "ticker-aapl",
      report: researchReport({
        runId: "ticker-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-20T00:00:00.000Z",
      }),
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { historyOptions: options() },
      now,
    });

    expect(context.runs[0]?.selectionReasons).toContain("same-symbol");
    expect(context.audit).toMatchObject({
      sameSymbolSelectedCount: 1,
      spotlightSymbolSelectedCount: 0,
    });
  });

  test("tags same-subject relevance reason for research commands", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "research-semis-key",
      report: researchReport({
        runId: "research-semis-key",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-05-20T00:00:00.000Z",
        extras: researchIdentityExtras({
          jobType: "research",
          assetClass: "equity",
          subject: "semis",
          subjectKey: "semiconductors",
          predictionProxySymbol: "SMH",
          depth: "brief",
        }),
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "research-semis-proxy",
      report: researchReport({
        runId: "research-semis-proxy",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-05-18T00:00:00.000Z",
        extras: researchIdentityExtras({
          jobType: "research",
          assetClass: "equity",
          subject: "semis",
          predictionProxySymbol: "SMH",
          depth: "brief",
        }),
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "research-software",
      report: researchReport({
        runId: "research-software",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-05-22T00:00:00.000Z",
        extras: researchIdentityExtras({
          jobType: "research",
          assetClass: "equity",
          subject: "software",
          subjectKey: "software",
          predictionProxySymbol: "IGV",
          depth: "brief",
        }),
      }),
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "semis",
        subjectKey: "semiconductors",
        predictionProxySymbol: "SMH",
        depth: "brief",
      },
      config: { historyOptions: options({ tickerRecentLimit: 2, anchorMonths: [] }) },
      now,
    });

    expect(context.runs.map((run) => run.runId)).toEqual([
      "research-semis-key",
      "research-semis-proxy",
    ]);
    expect(context.runs[0]).toMatchObject({
      selectionReasons: ["recent", "same-subject"],
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
    });
    expect(context.audit.sameSubjectSelectedCount).toBe(2);
  });

  test("counts selected runs carrying a resolved miss towards resolvedMissRunCount", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "ticker-miss-run",
      report: researchReport({
        runId: "ticker-miss-run",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-20T00:00:00.000Z",
        predictions: [prediction({ id: "pred-miss", subject: "AAPL" })],
      }),
      score: {
        scoredAt: "2026-05-28T00:00:00.000Z",
        scores: [predictionScore("miss", { predictionId: "pred-miss", runId: "ticker-miss-run" })],
      },
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { historyOptions: options() },
      now,
    });

    expect(context.audit.resolvedMissRunCount).toBe(1);
  });

  test("preserves a resolved-miss run that the recency limit would evict", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    // Two same-day reruns fill the recency window ahead of an older run that carries
    // The resolved miss synthesis leans on for calibration.
    for (const [runId, generatedAt] of [
      ["rerun-newest", "2026-06-03T00:00:00.000Z"],
      ["rerun-older", "2026-06-02T00:00:00.000Z"],
    ] as const) {
      await writeRun({
        dataDir,
        runDirName: runId,
        report: researchReport({ runId, jobType: "daily", assetClass: "equity", generatedAt }),
      });
    }
    await writeRun({
      dataDir,
      runDirName: "miss-anchor",
      report: researchReport({
        runId: "miss-anchor",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-05-26T00:00:00.000Z",
        predictions: [prediction({ id: "pred-miss", subject: "QQQ" })],
      }),
      score: {
        scoredAt: "2026-06-02T00:00:00.000Z",
        scores: [predictionScore("miss", { predictionId: "pred-miss", runId: "miss-anchor" })],
      },
    });

    const command = {
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 5,
      legacyAlias: "daily",
    } as const;
    const selectionOptions = options({ marketRecentLimit: 2, anchorMonths: [] });

    const withoutLane = await loadHistoricalContext({
      dataDir,
      command,
      config: { historyOptions: { ...selectionOptions, missCorrectionLimit: 0 } },
      now,
    });
    expect(withoutLane.runs.map((run) => run.runId)).not.toContain("miss-anchor");
    expect(withoutLane.audit.missCorrectionSelectedCount).toBe(0);

    const withLane = await loadHistoricalContext({
      dataDir,
      command,
      config: { historyOptions: { ...selectionOptions, missCorrectionLimit: 1 } },
      now,
    });
    const missRun = withLane.runs.find((run) => run.runId === "miss-anchor");
    expect(missRun?.selectionReasons).toContain("miss-correction");
    expect(withLane.audit.missCorrectionSelectedCount).toBe(1);
    expect(withLane.audit.resolvedMissRunCount).toBe(1);
  });

  test("collapses same-day comparable market history but keeps miss-correction anchors", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    for (const [runId, generatedAt] of [
      ["same-day-new", "2026-06-03T15:00:00.000Z"],
      ["same-day-mid", "2026-06-03T12:00:00.000Z"],
    ] as const) {
      await writeRun({
        dataDir,
        runDirName: runId,
        report: researchReport({ runId, jobType: "daily", assetClass: "equity", generatedAt }),
      });
    }
    await writeRun({
      dataDir,
      runDirName: "same-day-miss-anchor",
      report: researchReport({
        runId: "same-day-miss-anchor",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-06-03T09:00:00.000Z",
        predictions: [prediction({ id: "pred-miss", subject: "SPY" })],
      }),
      score: {
        scoredAt: "2026-06-04T00:00:00.000Z",
        scores: [
          predictionScore("miss", {
            predictionId: "pred-miss",
            runId: "same-day-miss-anchor",
          }),
        ],
      },
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      config: {
        historyOptions: options({ marketRecentLimit: 3, anchorMonths: [], missCorrectionLimit: 1 }),
      },
      now,
    });

    expect(context.runs.map((run) => run.runId)).toEqual(["same-day-miss-anchor"]);
    expect(context.audit.selectedRunCount).toBe(1);
    expect(context.audit.missCorrectionSelectedCount).toBe(1);
  });

  test("collapses same-day research history across subject-key and proxy-only identities", async () => {
    const dataDir = tempRunsDir();
    const now = new Date("2026-06-04T00:00:00.000Z");
    await writeRun({
      dataDir,
      runDirName: "research-key-and-proxy",
      report: researchReport({
        runId: "research-key-and-proxy",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-06-03T15:00:00.000Z",
        extras: researchIdentityExtras({
          jobType: "research",
          assetClass: "equity",
          subject: "semis",
          subjectKey: "semiconductors",
          predictionProxySymbol: "SMH",
          depth: "brief",
        }),
      }),
    });
    await writeRun({
      dataDir,
      runDirName: "research-proxy-only",
      report: researchReport({
        runId: "research-proxy-only",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-06-03T12:00:00.000Z",
        extras: researchIdentityExtras({
          jobType: "research",
          assetClass: "equity",
          subject: "semis",
          predictionProxySymbol: "SMH",
          depth: "brief",
        }),
      }),
    });

    const context = await loadHistoricalContext({
      dataDir,
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "semis",
        subjectKey: "semiconductors",
        predictionProxySymbol: "SMH",
        depth: "brief",
      },
      config: {
        historyOptions: options({ tickerRecentLimit: 2, anchorMonths: [], missCorrectionLimit: 0 }),
      },
      now,
    });

    expect(context.runs.map((run) => run.runId)).toEqual(["research-key-and-proxy"]);
    expect(context.audit.selectedRunCount).toBe(1);
    expect(context.audit.sameSubjectSelectedCount).toBe(1);
  });

  test("appends extraGaps to gaps and reflects their count in audit.gapCount", async () => {
    const context = await loadHistoricalContext({
      dataDir: tempRunsDir(),
      command: {
        jobType: "market-overview",
        assetClass: "crypto",
        depth: "brief",
        horizonTradingDays: 5,
        legacyAlias: "daily",
      },
      config: { historyOptions: options() },
      now: new Date("2026-06-04T00:00:00.000Z"),
      extraGaps: ["Unable to read alpha-search watchlist for spotlight enrichment"],
    });

    expect(context.gaps).toEqual([
      "No prior crypto market-update runs found",
      "Unable to read alpha-search watchlist for spotlight enrichment",
    ]);
    expect(context.audit.gapCount).toBe(context.gaps.length);
  });
});
