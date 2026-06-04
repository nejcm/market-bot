import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResearchReport } from "../src/domain/types";
import { runScorePass, SCORING_VERSION } from "../src/scoring/index";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import type { PredictionScore } from "../src/scoring/types";
import type { AlphaValidationFile, AlphaValidationSummary } from "../src/alpha-search/validation";
import { researchReport } from "./support/fixtures";
import { recordingFetch } from "./support/mocks";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "score-pass-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(join(tmpDir, "..", "alpha-validation"), { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(
  predictions: ResearchReport["predictions"],
  overrides: Partial<ResearchReport> = {},
): ResearchReport {
  return researchReport({ generatedAt: "2026-05-01T00:00:00.000Z", predictions, ...overrides });
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

async function readAlphaValidation(runDir: string): Promise<AlphaValidationFile> {
  const raw = await readFile(join(runDir, "alpha-validation.json"), "utf8");
  return JSON.parse(raw) as AlphaValidationFile;
}

async function readAlphaValidationSummary(): Promise<AlphaValidationSummary> {
  const raw = await readFile(join(tmpDir, "..", "alpha-validation", "summary.json"), "utf8");
  return JSON.parse(raw) as AlphaValidationSummary;
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
    const { calls, fetch: stub } = recordingFetch((url) => {
      const values = url.includes("/coins/bitcoin/") ? [100, 110, 130] : [100, 105, 110];
      return {
        prices: values.map((value, index) => [
          Date.parse(`2026-05-0${String(index + 1)}T00:00:00.000Z`),
          value,
        ]),
      };
    });
    globalThis.fetch = stub;

    await runScorePass(tmpDir, new Date("2026-05-05T00:00:00.000Z"));

    const [score] = await readScores(runDir);
    expect(score?.outcome).toBe("hit");
    expect(score?.evidence).toMatchObject({ returnA: 1.3, returnB: 1.1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
    expect(calls[1]).toContain("/coins/ethereum/market_chart/range");
  });
});

describe("runScorePass Alpha validation", () => {
  test("writes alpha validation sidecar for alpha-search reports with research leads", async () => {
    const runDir = await writeRun(
      "alpha-run-1",
      report([], {
        runId: "alpha-run-1",
        jobType: "alpha-search",
        assetClass: "equity",
        extras: {
          depth: "brief",
          socialCandidateCount: 1,
          secCandidateCount: 0,
          researchLeads: [
            {
              symbol: "ALFA",
              name: "Alpha Co.",
              exchange: "NMS",
              price: 10,
              volume: 1_000_000,
              marketCap: 500_000_000,
              discoverySources: ["apewisdom"],
              socialRank: 1,
              socialMomentumScore: 75,
              sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
            },
          ],
          rejectedCandidates: [],
        },
      }),
    );
    const repo: ObservationRepository = {
      point: noObservation,
      window: async (subject) => {
        const values =
          subject === "ALFA" ? [10, 10, 10, 10, 10, 12] : [100, 100, 100, 100, 100, 105];
        return values.map((value, index) => ({
          subject,
          date: `2026-05-${String(index + 1).padStart(2, "0")}`,
          value,
        }));
      },
    };

    const result = await runScorePass(tmpDir, new Date("2026-06-01T00:00:00.000Z"), {
      observationRepository: repo,
    });

    const validation = await readAlphaValidation(runDir);
    expect(result).toEqual({ scored: 1, skipped: 0 });
    expect(validation).toMatchObject({
      runId: "alpha-run-1",
      benchmarkSymbol: "IWM",
      horizons: [5, 20],
    });
    expect(validation.leads[0]?.horizons[0]).toMatchObject({
      status: "resolved",
      horizonTradingDays: 5,
      outcome: "outperformed",
    });
    const summary = await readAlphaValidationSummary();
    const markdown = await readFile(join(tmpDir, "..", "alpha-validation", "summary.md"), "utf8");
    expect(summary.overall["5"]).toMatchObject({
      resolvedCount: 1,
      outperformedCount: 1,
      hitRate: 1,
    });
    expect(markdown).toContain("# Alpha Validation Summary");
  });

  test("does not recompute completed alpha validation sidecars", async () => {
    const runDir = await writeRun(
      "alpha-run-1",
      report([], {
        runId: "alpha-run-1",
        jobType: "alpha-search",
        assetClass: "equity",
        extras: {
          depth: "brief",
          socialCandidateCount: 1,
          secCandidateCount: 0,
          researchLeads: [
            {
              symbol: "ALFA",
              name: "Alpha Co.",
              exchange: "NMS",
              price: 10,
              volume: 1_000_000,
              marketCap: 500_000_000,
              discoverySources: ["apewisdom"],
              socialRank: 1,
              socialMomentumScore: 75,
              sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
            },
          ],
          rejectedCandidates: [],
        },
      }),
    );
    const existing: AlphaValidationFile = {
      runId: "alpha-run-1",
      validatedAt: "2026-05-31T00:00:00.000Z",
      generatedAt: "2026-05-01T00:00:00.000Z",
      benchmarkSymbol: "IWM",
      horizons: [5, 20],
      leads: [
        {
          symbol: "ALFA",
          name: "Alpha Co.",
          discoverySources: ["apewisdom"],
          socialRank: 1,
          socialMomentumScore: 75,
          sourceGroup: "apewisdom-only",
          sourceIds: ["apewisdom-ALFA", "market-yahoo-alpha-search"],
          horizons: [
            {
              status: "resolved",
              horizonTradingDays: 5,
              benchmarkSymbol: "IWM",
              candidateClose0: 10,
              candidateCloseN: 12,
              benchmarkClose0: 100,
              benchmarkCloseN: 105,
              candidateDate0: "2026-05-01",
              candidateDateN: "2026-05-08",
              benchmarkDate0: "2026-05-01",
              benchmarkDateN: "2026-05-08",
              candidateReturn: 0.2,
              benchmarkReturn: 0.05,
              excessReturn: 0.15,
              outcome: "outperformed",
            },
            {
              status: "resolved",
              horizonTradingDays: 20,
              benchmarkSymbol: "IWM",
              candidateClose0: 10,
              candidateCloseN: 11,
              benchmarkClose0: 100,
              benchmarkCloseN: 101,
              candidateDate0: "2026-05-01",
              candidateDateN: "2026-05-29",
              benchmarkDate0: "2026-05-01",
              benchmarkDateN: "2026-05-29",
              candidateReturn: 0.1,
              benchmarkReturn: 0.01,
              excessReturn: 0.09,
              outcome: "outperformed",
            },
          ],
        },
      ],
    };
    await writeFile(
      join(runDir, "alpha-validation.json"),
      `${JSON.stringify(existing, undefined, 2)}\n`,
      "utf8",
    );

    const result = await runScorePass(tmpDir, new Date("2026-06-01T00:00:00.000Z"), {
      observationRepository: {
        point: noObservation,
        window: async () => {
          throw new Error("unexpected window request");
        },
      },
    });

    const validation = await readAlphaValidation(runDir);
    const summary = await readAlphaValidationSummary();
    expect(result).toEqual({ scored: 1, skipped: 0 });
    expect(validation.validatedAt).toBe("2026-05-31T00:00:00.000Z");
    expect(summary.overall["20"]).toMatchObject({ resolvedCount: 1, hitRate: 1 });
  });

  test("does not write alpha validation for non-alpha reports", async () => {
    const runDir = await writeRun("run-1", report([]));

    const result = await runScorePass(tmpDir, new Date("2026-06-01T00:00:00.000Z"), {
      observationRepository: {
        point: noObservation,
        window: async () => [],
      },
    });

    await expect(readFile(join(runDir, "alpha-validation.json"), "utf8")).rejects.toThrow();
    expect(result).toEqual({ scored: 0, skipped: 1 });
  });

  test("skips alpha-search reports without research leads", async () => {
    const runDir = await writeRun(
      "alpha-run-empty",
      report([], {
        runId: "alpha-run-empty",
        jobType: "alpha-search",
        assetClass: "equity",
        extras: {
          depth: "brief",
          socialCandidateCount: 0,
          secCandidateCount: 0,
          researchLeads: [],
          rejectedCandidates: [],
        },
      }),
    );

    const result = await runScorePass(tmpDir, new Date("2026-06-01T00:00:00.000Z"), {
      observationRepository: {
        point: noObservation,
        window: async () => [],
      },
    });

    await expect(readFile(join(runDir, "alpha-validation.json"), "utf8")).rejects.toThrow();
    expect(result).toEqual({ scored: 0, skipped: 1 });
  });
});
