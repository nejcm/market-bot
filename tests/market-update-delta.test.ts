import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssetClass,
  JobType,
  MarketRegimeLabel,
  MarketRegimeSummary,
  MarketSnapshot,
} from "../src/domain/types";
import { rankMovers } from "../src/movers/ranking";
import { buildMarketUpdateDelta } from "../src/research/market-update-delta";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snap(symbol: string, changePercent24h: number): MarketSnapshot {
  return {
    sourceId: `market-${symbol.toLowerCase()}`,
    assetClass: "equity",
    symbol,
    price: 100,
    changePercent24h,
    volume: 1_000_000,
    observedAt: "2026-05-01T00:00:00.000Z",
  };
}

function regime(label: MarketRegimeLabel, drivers: readonly string[]): MarketRegimeSummary {
  return { assetClass: "equity", label, proxyCount: drivers.length, drivers, sourceIds: [] };
}

interface RunSpec {
  readonly runId: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly generatedAt: string;
  readonly horizonTradingDays?: number;
  readonly regime?: MarketRegimeSummary;
  readonly movers?: readonly MarketSnapshot[];
  readonly snapshots?: readonly MarketSnapshot[];
  readonly predictions?: readonly { id: string; claim: string; probability: number }[];
  readonly scores?: readonly {
    predictionId: string;
    resolved: boolean;
    outcome?: "hit" | "miss";
    observedAt?: string;
  }[];
}

function writeRun(dataDir: string, spec: RunSpec): void {
  const runDir = join(dataDir, spec.runId);
  mkdirSync(join(runDir, "normalized"), { recursive: true });
  writeJson(join(runDir, "report.json"), {
    runId: spec.runId,
    jobType: spec.jobType,
    assetClass: spec.assetClass,
    ...(spec.horizonTradingDays !== undefined
      ? { horizonTradingDays: spec.horizonTradingDays }
      : {}),
    generatedAt: spec.generatedAt,
    summary: "",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    // Persisted reports always carry the full observable Prediction shape; expand
    // The test's id/claim/probability shorthand so the Run Artifact reader keeps them.
    predictions: (spec.predictions ?? []).map((p) => ({
      id: p.id,
      claim: p.claim,
      kind: "direction",
      subject: "SPY",
      measurableAs: "close(SPY, +5) > close(SPY, 0)",
      horizonTradingDays: 5,
      probability: p.probability,
      sourceIds: [],
    })),
    sources: [],
    notFinancialAdvice: true,
    extras: spec.regime === undefined ? {} : { marketRegime: spec.regime },
  });
  if (spec.movers !== undefined) {
    writeJson(join(runDir, "normalized", "movers.json"), rankMovers(spec.movers, 5));
  }
  if (spec.snapshots !== undefined) {
    writeJson(join(runDir, "normalized", "market-snapshots.json"), spec.snapshots);
  }
  if (spec.scores !== undefined) {
    writeJson(join(runDir, "score.json"), {
      runId: spec.runId,
      scores: spec.scores.map((score) => ({
        predictionId: score.predictionId,
        runId: spec.runId,
        resolved: score.resolved,
        outcome: score.outcome,
        observedAt: score.observedAt,
        attemptCount: 1,
        evidence: {},
      })),
    });
  }
}

const DAILY_EQUITY = {
  jobType: "market-overview" as const,
  assetClass: "equity" as const,
  depth: "brief" as const,
  horizonTradingDays: 5,
  legacyAlias: "daily" as const,
};
const NOW = new Date("2026-05-10T00:00:00.000Z");

async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mud-"));
}

describe("buildMarketUpdateDelta", () => {
  test("returns empty state when no prior same-horizon-bucket run exists", async () => {
    const dataDir = await tempDataDir();
    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: rankMovers([snap("AAPL", 3)], 5),
      currentRegime: regime("risk-on", ["equity breadth proxies positive: 4/5"]),
      moverLimit: 5,
    });
    expect(delta.hasBaseline).toBe(false);
    expect(delta.currentRegime).toBe("risk-on");
    expect(delta.moversEntered).toEqual([]);
    expect(delta.resolvedSince).toEqual([]);
  });

  test("selects newest prior same assetClass+horizon bucket, excluding other scopes", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("mixed", []),
    });
    writeRun(dataDir, {
      runId: "daily-new",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-08T00:00:00.000Z",
      regime: regime("risk-off", []),
    });
    // Newer, but wrong horizon / asset / scope — must be ignored as baseline.
    writeRun(dataDir, {
      runId: "weekly-new",
      jobType: "weekly",
      assetClass: "equity",
      generatedAt: "2026-05-09T00:00:00.000Z",
      regime: regime("risk-on", []),
    });
    writeRun(dataDir, {
      runId: "ticker-new",
      jobType: "equity",
      assetClass: "equity",
      generatedAt: "2026-05-09T12:00:00.000Z",
      regime: regime("risk-on", []),
    });
    writeRun(dataDir, {
      runId: "daily-crypto",
      jobType: "daily",
      assetClass: "crypto",
      generatedAt: "2026-05-09T18:00:00.000Z",
      regime: regime("risk-on", []),
    });

    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: [],
      currentRegime: regime("risk-on", []),
      moverLimit: 5,
    });
    expect(delta.baselineRunId).toBe("daily-new");
    expect(delta.priorRegime).toBe("risk-off");
    expect(delta.regimeChanged).toBe(true);
  });

  test("uses canonical market-overview horizon buckets for baseline isolation", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "legacy-daily",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-06T00:00:00.000Z",
      regime: regime("mixed", []),
    });
    writeRun(dataDir, {
      runId: "overview-5d",
      jobType: "market-overview",
      assetClass: "equity",
      horizonTradingDays: 5,
      generatedAt: "2026-05-08T00:00:00.000Z",
      regime: regime("risk-off", []),
    });
    writeRun(dataDir, {
      runId: "overview-7d",
      jobType: "market-overview",
      assetClass: "equity",
      horizonTradingDays: 7,
      generatedAt: "2026-05-09T00:00:00.000Z",
      regime: regime("risk-on", []),
    });

    const baseInput = {
      dataDir,
      now: NOW,
      currentMovers: [],
      currentRegime: regime("mixed", []),
      moverLimit: 5,
    };
    const fiveDayDelta = await buildMarketUpdateDelta({
      ...baseInput,
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 5,
      },
    });
    const legacyDailyDelta = await buildMarketUpdateDelta({
      ...baseInput,
      command: DAILY_EQUITY,
    });
    const sevenDayDelta = await buildMarketUpdateDelta({
      ...baseInput,
      command: {
        jobType: "market-overview",
        assetClass: "equity",
        depth: "brief",
        horizonTradingDays: 7,
      },
    });

    expect(fiveDayDelta.baselineRunId).toBe("overview-5d");
    expect(legacyDailyDelta.baselineRunId).toBe("overview-5d");
    expect(sevenDayDelta.baselineRunId).toBe("overview-7d");
  });

  test("names flipped drivers by category when regime label changes", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("risk-off", [
        "equity breadth proxies negative: 4/5",
        "trend negative: 3/5 proxies below 50-day average",
        "VIX term structure contango: VIX 18.00 vs VIX3M 20.00",
      ]),
    });

    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: [],
      currentRegime: regime("risk-on", [
        "equity breadth proxies positive: 4/5",
        "trend positive: 3/5 proxies above 50-day average",
        "VIX term structure contango: VIX 17.00 vs VIX3M 20.00",
      ]),
      moverLimit: 5,
    });
    expect(delta.regimeChanged).toBe(true);
    // Breadth and trend flipped direction; VIX term structure stayed contango (neutral).
    expect(delta.flippedDrivers).toEqual(["breadth", "trend"]);
  });

  test("computes mover membership entered/exited from persisted movers.json", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("mixed", []),
      movers: [snap("TSLA", 5), snap("AAPL", 4), snap("MSFT", 3)],
    });

    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: rankMovers([snap("NVDA", 5), snap("AAPL", 4), snap("MSFT", 3)], 5),
      currentRegime: regime("mixed", []),
      moverLimit: 5,
    });
    expect(delta.moversEntered).toEqual(["NVDA"]);
    expect(delta.moversExited).toEqual(["TSLA"]);
  });

  test("falls back to re-ranking snapshots when movers.json is absent", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("mixed", []),
      snapshots: [snap("TSLA", 5), snap("AAPL", 4), snap("MSFT", 3)],
    });

    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: rankMovers([snap("NVDA", 5), snap("AAPL", 4), snap("MSFT", 3)], 5),
      currentRegime: regime("mixed", []),
      moverLimit: 5,
    });
    expect(delta.moversEntered).toEqual(["NVDA"]);
    expect(delta.moversExited).toEqual(["TSLA"]);
  });

  test("windows resolved predictions to observedAt strictly after the baseline", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("mixed", []),
      predictions: [
        { id: "p1", claim: "SPY closes higher.", probability: 0.65 },
        { id: "p2", claim: "QQQ closes higher.", probability: 0.55 },
        { id: "p3", claim: "IWM closes higher.", probability: 0.5 },
      ],
      scores: [
        {
          predictionId: "p1",
          resolved: true,
          outcome: "hit",
          observedAt: "2026-05-06T00:00:00.000Z",
        },
        {
          predictionId: "p2",
          resolved: true,
          outcome: "miss",
          observedAt: "2026-05-04T00:00:00.000Z",
        },
        { predictionId: "p3", resolved: true, outcome: "hit" },
      ],
    });
    // A ticker run resolved after the baseline must be excluded (market flow only).
    writeRun(dataDir, {
      runId: "ticker-old",
      jobType: "equity",
      assetClass: "equity",
      generatedAt: "2026-05-04T00:00:00.000Z",
      predictions: [{ id: "t1", claim: "AAPL closes higher.", probability: 0.7 }],
      scores: [
        {
          predictionId: "t1",
          resolved: true,
          outcome: "hit",
          observedAt: "2026-05-07T00:00:00.000Z",
        },
      ],
    });

    const delta = await buildMarketUpdateDelta({
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: [],
      currentRegime: regime("mixed", []),
      moverLimit: 5,
    });
    expect(delta.resolvedSince).toEqual([
      {
        runId: "daily-old",
        predictionId: "p1",
        claim: "SPY closes higher than today over 5 trading days",
        probability: 0.65,
        outcome: "hit",
        observedAt: "2026-05-06T00:00:00.000Z",
      },
    ]);
  });

  test("is deterministic given identical disk state and now", async () => {
    const dataDir = await tempDataDir();
    writeRun(dataDir, {
      runId: "daily-old",
      jobType: "daily",
      assetClass: "equity",
      generatedAt: "2026-05-05T00:00:00.000Z",
      regime: regime("risk-off", ["equity breadth proxies negative: 4/5"]),
      movers: [snap("TSLA", 5), snap("AAPL", 4)],
    });
    const input = {
      dataDir,
      command: DAILY_EQUITY,
      now: NOW,
      currentMovers: rankMovers([snap("NVDA", 5), snap("AAPL", 4)], 5),
      currentRegime: regime("risk-on", ["equity breadth proxies positive: 4/5"]),
      moverLimit: 5,
    };
    const first = await buildMarketUpdateDelta(input);
    const second = await buildMarketUpdateDelta(input);
    expect(second).toEqual(first);
  });
});
