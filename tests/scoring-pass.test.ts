import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResearchReport } from "../src/domain/types";
import { runScorePass, SCORING_VERSION } from "../src/scoring/index";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import type { PredictionScore } from "../src/scoring/types";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "score-pass-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(
  predictions: ResearchReport["predictions"],
  overrides: Partial<ResearchReport> = {},
): ResearchReport {
  return {
    runId: "run-1",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: "2026-05-01T00:00:00.000Z",
    summary: "",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions,
    sources: [],
    notFinancialAdvice: true,
    ...overrides,
  };
}

async function writeRun(runId: string, value: ResearchReport): Promise<string> {
  const runDir = join(tmpDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "report.json"), `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
  return runDir;
}

async function readScores(runDir: string): Promise<readonly PredictionScore[]> {
  const raw = await readFile(join(runDir, "score.json"), "utf8");
  return (JSON.parse(raw) as { scores: readonly PredictionScore[] }).scores;
}

async function noObservation(): Promise<Observation | undefined> {
  throw new Error("unexpected point observation request");
}

describe("runScorePass Observation scoring", () => {
  test("scores volatility from the full close window", async () => {
    const runDir = await writeRun(
      "run-1",
      report([
        {
          id: "pred-vol",
          claim: "VIX spikes above 20.",
          kind: "volatility",
          subject: "^VIX",
          measurableAs: "max(close(^VIX), 0..+5) > 20",
          horizonTradingDays: 5,
          probability: 0.6,
          sourceIds: [],
        },
      ]),
    );
    const repo: ObservationRepository = {
      point: noObservation,
      window: async (subject) => [
        { subject, date: "2026-05-01", value: 18 },
        { subject, date: "2026-05-04", value: 19 },
        { subject, date: "2026-05-05", value: 22 },
        { subject, date: "2026-05-06", value: 18 },
        { subject, date: "2026-05-07", value: 17 },
        { subject, date: "2026-05-08", value: 16 },
      ],
    };

    await runScorePass(tmpDir, new Date("2026-05-11T00:00:00.000Z"), {
      observationRepository: repo,
    });

    const [score] = await readScores(runDir);
    expect(score?.outcome).toBe("hit");
    expect(score?.evidence).toMatchObject({ maxClose: 22, threshold: 20 });
    expect(score?.scoringVersion).toBe(SCORING_VERSION);
  });

  test("uses the Nth available close session after origin", async () => {
    const runDir = await writeRun(
      "run-1",
      report([
        {
          id: "pred-dir",
          claim: "SPY closes higher over 2 trading days.",
          kind: "direction",
          subject: "SPY",
          measurableAs: "close(SPY, +2) > close(SPY, 0)",
          horizonTradingDays: 2,
          probability: 0.6,
          sourceIds: [],
        },
      ]),
    );
    const repo: ObservationRepository = {
      point: noObservation,
      window: async (subject) => [
        { subject, date: "2026-05-04", value: 100 },
        { subject, date: "2026-05-05", value: 99 },
        { subject, date: "2026-05-07", value: 102 },
      ],
    };

    await runScorePass(tmpDir, new Date("2026-05-08T00:00:00.000Z"), {
      observationRepository: repo,
    });

    const [score] = await readScores(runDir);
    expect(score?.outcome).toBe("hit");
    expect(score?.evidence).toMatchObject({ close0: 100, closeN: 102 });
  });

  test("does not recompute existing resolved scores without a scoring version", async () => {
    const runDir = await writeRun(
      "run-1",
      report([
        {
          id: "pred-dir",
          claim: "SPY closes higher over 2 trading days.",
          kind: "direction",
          subject: "SPY",
          measurableAs: "close(SPY, +2) > close(SPY, 0)",
          horizonTradingDays: 2,
          probability: 0.6,
          sourceIds: [],
        },
      ]),
    );
    await writeFile(
      join(runDir, "score.json"),
      `${JSON.stringify(
        {
          runId: "run-1",
          scoredAt: "2026-05-08T00:00:00.000Z",
          scores: [
            {
              predictionId: "pred-dir",
              runId: "run-1",
              resolved: true,
              outcome: "miss",
              observedAt: "2026-05-08T00:00:00.000Z",
              attemptCount: 1,
              evidence: { legacy: true },
            },
          ],
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    );
    let windowCalls = 0;
    const repo: ObservationRepository = {
      point: noObservation,
      window: async () => {
        windowCalls += 1;
        return [];
      },
    };

    await runScorePass(tmpDir, new Date("2026-05-08T00:00:00.000Z"), {
      observationRepository: repo,
    });

    const [score] = await readScores(runDir);
    expect(windowCalls).toBe(0);
    expect(score).toMatchObject({
      outcome: "miss",
      evidence: { legacy: true },
    });
    expect(score?.scoringVersion).toBeUndefined();
  });

  test("scores crypto relative windows with per-subject CoinGecko ids", async () => {
    const runDir = await writeRun(
      "run-1",
      report(
        [
          {
            id: "pred-rel-crypto",
            claim: "BTC outperforms ETH over two trading days.",
            kind: "relative",
            subject: "BTC:ETH",
            measurableAs: "close(BTC, +2) / close(BTC, 0) > close(ETH, +2) / close(ETH, 0)",
            horizonTradingDays: 2,
            probability: 0.6,
            sourceIds: [],
          },
        ],
        {
          assetClass: "crypto",
          sources: [
            {
              id: "market-btc",
              title: "BTC market snapshot",
              fetchedAt: "2026-05-01T00:00:00.000Z",
              kind: "market-data",
              assetClass: "crypto",
              symbol: "BTC",
              identity: {
                providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
              },
            },
            {
              id: "market-eth",
              title: "ETH market snapshot",
              fetchedAt: "2026-05-01T00:00:00.000Z",
              kind: "market-data",
              assetClass: "crypto",
              symbol: "ETH",
              identity: {
                providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "ethereum" }],
              },
            },
          ],
        },
      ),
    );
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      const values = url.includes("/coins/bitcoin/") ? [100, 110, 130] : [100, 105, 110];
      return Promise.resolve(
        Response.json({
          prices: values.map((value, index) => [
            Date.parse(`2026-05-0${String(index + 1)}T00:00:00.000Z`),
            value,
          ]),
        }),
      );
    }) as typeof fetch;

    await runScorePass(tmpDir, new Date("2026-05-05T00:00:00.000Z"));

    const [score] = await readScores(runDir);
    expect(score?.outcome).toBe("hit");
    expect(score?.evidence).toMatchObject({ returnA: 1.3, returnB: 1.1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
    expect(calls[1]).toContain("/coins/ethereum/market_chart/range");
  });
});
