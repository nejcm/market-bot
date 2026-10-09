import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCli } from "../src/app";
import type { ResearchReport } from "../src/domain/types";
import { buildMissAutopsyFile } from "../src/scoring/miss-autopsy";
import { repairScore, renderScoreRepair } from "../src/scoring/repair";
import type { MissAutopsyFile, PredictionScore } from "../src/scoring/types";
import { prediction, researchReport } from "./support/fixtures";

let root = "";
let dataDir = "";
let cacheDir = "";
const RUN_ID = "2026-10-07T14-04-29-654Z-343d253f";
const PRE_CLOSE = "2026-10-08T15:58:52.674Z";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-repair-"));
  dataDir = join(root, "runs");
  cacheDir = join(root, "cache");
});

const env = { ...process.env };

afterEach(() => {
  process.env = { ...env };
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

const report: ResearchReport = researchReport({
  runId: RUN_ID,
  jobType: "equity",
  assetClass: "equity",
  symbol: "CLFD",
  generatedAt: "2026-10-07T14:04:29.654Z",
  predictions: [
    prediction({
      id: "pred-1",
      kind: "range",
      subject: "CLFD",
      measurableAs: "close(CLFD, +5) outside [30, 37]",
      probability: 0.32,
      scoringPolicyVersion: 3,
    }),
    prediction({
      id: "pred-2",
      kind: "range",
      subject: "CLFD",
      measurableAs: "close(CLFD, +1) outside [32, 35]",
      horizonTradingDays: 1,
      probability: 0.8,
      scoringPolicyVersion: 3,
    }),
  ],
});

const pendingScore: PredictionScore = {
  predictionId: "pred-1",
  runId: RUN_ID,
  status: "pending",
  resolved: false,
  outcome: undefined,
  observedAt: undefined,
  attemptCount: 0,
  scoringVersion: 3,
  evidence: { reason: "horizon not yet elapsed" },
};

const storedMiss = (observedAt: string): PredictionScore => ({
  predictionId: "pred-2",
  runId: RUN_ID,
  status: "resolved",
  resolved: true,
  outcome: "miss",
  observedAt,
  attemptCount: 1,
  scoringVersion: 3,
  evidence: { closeN: 32.45, lo: 32, hi: 35 },
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

function chartPayload(closes: readonly [number, number]): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "CLFD",
            currentTradingPeriod: {
              regular: { timezone: "EDT", start: 1_791_466_200, end: 1_791_489_600 },
            },
          },
          timestamp: [1_791_379_800, 1_791_466_200],
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

async function seed(options: { observedAt?: string; schedule?: boolean } = {}): Promise<string> {
  const observedAt = options.observedAt ?? PRE_CLOSE;
  const runDir = join(dataDir, RUN_ID);
  const scores = [pendingScore, storedMiss(observedAt)];
  await writeJson(join(runDir, "report.json"), report);
  await writeJson(join(runDir, "score.json"), { runId: RUN_ID, scores, scoredAt: observedAt });
  await writeJson(join(runDir, "miss-autopsy.json"), buildMissAutopsyFile(report, scores));
  await writeJson(
    join(
      cacheDir,
      "close-windows/v2/split-adjusted-close/yahoo/equity/clfd/2026-10-07_2026-10-08.json",
    ),
    {
      schemaVersion: 2,
      symbol: "CLFD",
      assetClass: "equity",
      providerSet: "yahoo",
      priceMode: "split-adjusted-close",
      from: "2026-10-07",
      to: "2026-10-08",
      observations: [
        { subject: "CLFD", date: "2026-10-07", value: 32.9 },
        { subject: "CLFD", date: "2026-10-08", value: 32.45 },
      ],
      cachedAt: observedAt,
    },
  );
  if (options.schedule !== false) {
    await writeJson(join(cacheDir, "2026-10-08", "chart.json"), {
      adapter: "yahoo-verified-chart",
      fetchedAt: "2026-10-08T15:58:53.550Z",
      payload: chartPayload([32.9, 32.45]),
    });
  }
  return runDir;
}

async function snapshot(): Promise<Record<string, string>> {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const entries = await Promise.all(
    files
      .filter((file) => file.isFile())
      .map(async (file) => {
        const path = join(file.parentPath, file.name);
        return [path, await readFile(path, "utf8")] as const;
      }),
  );
  return Object.fromEntries(entries);
}

const request = (apply: boolean, now = "2026-10-08T21:00:00.000Z") => ({
  runId: RUN_ID,
  predictionId: "pred-2",
  apply,
  now: new Date(now),
  options: { closeCacheDir: cacheDir },
});

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("score repair", () => {
  test("dry run proves the October 8 CLFD miss premature without writing anything", async () => {
    await seed();
    const before = await snapshot();

    const result = await repairScore(dataDir, request(false));

    expect(result.verdict).toBe("proven-premature");
    expect(result.withheldSessions).toEqual([
      {
        subject: "CLFD",
        acquiredAt: PRE_CLOSE,
        date: "2026-10-08",
        status: "in-progress",
        closesAt: "2026-10-08T20:00:00.000Z",
      },
    ]);
    expect(renderScoreRepair(result, false)).toContain("dry run: nothing written");
    expect(await snapshot()).toEqual(before);
  });

  test("calls a score suspect when no recorded schedule covers the consumed session", async () => {
    await seed({ schedule: false });

    const result = await repairScore(dataDir, request(false));

    expect(result.verdict).toBe("suspect");
    expect(result.withheldSessions.map(({ date, status }) => `${date} ${status}`)).toEqual([
      "2026-10-07 unverified",
      "2026-10-08 unverified",
    ]);
  });

  test("leaves a score acquired after the regular close unaffected", async () => {
    await seed({ observedAt: "2026-10-08T21:00:00.000Z" });

    const result = await repairScore(dataDir, request(true));

    expect(result.verdict).toBe("unaffected");
    expect(result.repaired).toBeUndefined();
  });

  test("applies once: rescoring, keeping the original, and dropping the stale autopsy", async () => {
    const runDir = await seed();
    globalThis.fetch = (async () =>
      Response.json(chartPayload([32.9, 31.8]))) as unknown as typeof fetch;

    const result = await repairScore(dataDir, request(true));
    const { scores } = await readJson<{ scores: readonly PredictionScore[] }>(
      join(runDir, "score.json"),
    );
    const autopsy = await readJson<MissAutopsyFile>(join(runDir, "miss-autopsy.json"));

    expect(scores[0]).toEqual(pendingScore);
    expect(scores[1]).toMatchObject({
      status: "resolved",
      outcome: "hit",
      evidence: { closeN: 31.8 },
      repair: {
        repairedAt: "2026-10-08T21:00:00.000Z",
        verdict: "proven-premature",
        original: storedMiss(PRE_CLOSE),
      },
    });
    expect(result.repaired?.outcome).toBe("hit");
    expect(autopsy.autopsies).toEqual([]);

    const before = await snapshot();
    const again = await repairScore(dataDir, request(true));

    expect(again.verdict).toBe("already-repaired");
    expect(await snapshot()).toEqual(before);
  });

  test("writes nothing when verified replacement observations are unavailable", async () => {
    await seed();
    globalThis.fetch = (async () =>
      Response.json(chartPayload([32.9, 32.6]))) as unknown as typeof fetch;
    const before = await snapshot();

    const result = await repairScore(dataDir, request(true, "2026-10-08T16:30:00.000Z"));

    expect(result.repaired).toBeUndefined();
    expect(result.detail).toContain("nothing was written");
    expect(await snapshot()).toEqual(before);
  });

  test("rejects run ids that leave the runs directory", async () => {
    await expect(repairScore(dataDir, { ...request(false), runId: "../outside" })).rejects.toThrow(
      "Invalid run id",
    );
  });

  const finalClose = () => {
    globalThis.fetch = (async () =>
      Response.json(chartPayload([32.9, 31.8]))) as unknown as typeof fetch;
  };

  test("rewrites only the target row, keeping malformed siblings and the raw original", async () => {
    const runDir = await seed();
    const scorePath = join(runDir, "score.json");
    const file = await readJson<{ scores: Record<string, unknown>[] }>(scorePath);
    const target = { ...file.scores[1], providerNote: "kept verbatim" };
    const malformed = { predictionId: 7, note: "unreadable row" };
    await writeJson(scorePath, {
      ...file,
      extra: "top-level field",
      scores: [{ ...file.scores[0], providerNote: "x" }, malformed, target],
    });
    finalClose();

    await repairScore(dataDir, request(true));
    const after = await readJson<{ extra: string; scores: Record<string, unknown>[] }>(scorePath);

    expect(after.extra).toBe("top-level field");
    expect(after.scores[0]).toEqual({ ...file.scores[0], providerNote: "x" });
    expect(after.scores[1]).toEqual(malformed);
    expect(after.scores.at(2)?.repair).toMatchObject({ original: target });
  });

  test("refuses a Prediction id that selects more than one score row", async () => {
    const runDir = await seed();
    const scorePath = join(runDir, "score.json");
    const file = await readJson<{ scores: unknown[] }>(scorePath);
    await writeJson(scorePath, { ...file, scores: [...file.scores, file.scores[1]] });

    await expect(repairScore(dataDir, request(false))).rejects.toThrow(
      "does not select exactly one score row",
    );
  });

  test("leaves crypto scores out of equity session repair", async () => {
    const runDir = await seed();
    await writeJson(join(runDir, "report.json"), { ...report, assetClass: "crypto" });

    const result = await repairScore(dataDir, request(false));
    expect(result.verdict).toBe("not-applicable");
  });

  test("rejects a run directory symlinked outside the runs directory", async () => {
    await seed();
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(dataDir, "elsewhere"));

    await expect(repairScore(dataDir, { ...request(false), runId: "elsewhere" })).rejects.toThrow(
      "Invalid run id",
    );
  });

  test("finishes derived updates without rescoring after a failure right after the score write", async () => {
    const runDir = await seed();
    const [pending, target] = report.predictions;
    await writeJson(join(runDir, "report.json"), {
      ...report,
      predictions: [pending, { ...target, probability: 0.1 }],
    });
    const autopsyPath = join(runDir, "miss-autopsy.json");
    await rm(autopsyPath);
    await mkdir(join(autopsyPath, "blocker"), { recursive: true });
    finalClose();

    await expect(repairScore(dataDir, request(true))).rejects.toThrow();
    const scoreAfterFailure = await readFile(join(runDir, "score.json"), "utf8");
    expect(scoreAfterFailure).toContain('"repair"');

    await rm(autopsyPath, { recursive: true });
    const resumed = await repairScore(dataDir, request(true, "2026-10-09T12:00:00.000Z"));

    expect(resumed.verdict).toBe("already-repaired");
    expect(resumed.repaired).toBeDefined();
    expect(await readFile(join(runDir, "score.json"), "utf8")).toBe(scoreAfterFailure);
    const autopsy = await readJson<MissAutopsyFile>(autopsyPath);
    expect(autopsy.autopsies).toMatchObject([
      { predictionId: "pred-2", scoreOutcome: "hit", forecastError: "underpredicted" },
    ]);
  });

  test("reruns Calibration on a second --apply after Calibration failed", async () => {
    const runDir = await seed();
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    process.env.MARKET_BOT_CACHE_DIR = cacheDir;
    finalClose();
    let calibrationCalls = 0;
    const dependencies = {
      now: () => new Date("2026-10-08T21:00:00.000Z"),
      buildAndWriteCalibration: async () => {
        calibrationCalls += 1;
        if (calibrationCalls === 1) {
          throw new Error("calibration disk full");
        }
        return null;
      },
      writeThroughRunArtifactIndex: async () => {},
      rebuildRunArtifactIndexIfStale: async () => ({ rebuilt: false }),
    };
    const argv = ["score", "repair", "--run", RUN_ID, "--prediction", "pred-2", "--apply"];

    await expect(runCli(argv, dependencies)).rejects.toThrow("calibration disk full");
    const output = await runCli(argv, dependencies);
    const { scores } = await readJson<{ scores: readonly PredictionScore[] }>(
      join(runDir, "score.json"),
    );

    expect(calibrationCalls).toBe(2);
    expect(output).toContain("derived artifacts refreshed");
    expect(scores[1]?.repair?.original).not.toHaveProperty("repair");
  });

  test("calls a pre-open replay suspect when no consumed bar was provably still trading", async () => {
    const acquiredAt = "2026-10-08T10:00:00.000Z";
    const runDir = join(dataDir, RUN_ID);
    const target = { ...report.predictions[1]!, probability: 0.22 };
    const miss = {
      ...storedMiss(acquiredAt),
      evidence: { closeN: 32.9, lo: 32, hi: 35 },
    };
    await writeJson(join(runDir, "report.json"), {
      ...report,
      generatedAt: "2026-10-06T10:00:00.000Z",
      predictions: [target],
    });
    await writeJson(join(runDir, "score.json"), {
      runId: RUN_ID,
      scores: [miss],
      scoredAt: acquiredAt,
    });
    await writeJson(
      join(
        cacheDir,
        "close-windows/v2/split-adjusted-close/yahoo/equity/clfd/2026-10-06_2026-10-08.json",
      ),
      {
        schemaVersion: 2,
        symbol: "CLFD",
        assetClass: "equity",
        providerSet: "yahoo",
        priceMode: "split-adjusted-close",
        from: "2026-10-06",
        to: "2026-10-08",
        observations: [
          { subject: "CLFD", date: "2026-10-06", value: 33.2 },
          { subject: "CLFD", date: "2026-10-07", value: 32.9 },
        ],
        cachedAt: acquiredAt,
      },
    );
    await writeJson(join(cacheDir, "2026-10-08", "chart.json"), {
      adapter: "yahoo-verified-chart",
      payload: chartPayload([32.9, 32.45]),
    });

    const result = await repairScore(dataDir, request(false));

    expect(result.verdict).toBe("suspect");
    expect(result.withheldSessions.map(({ date, status }) => `${date} ${status}`)).toEqual([
      "2026-10-07 awaiting-open",
      "2026-10-08 in-progress",
    ]);
  });
});
