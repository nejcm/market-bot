import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Prediction, ResearchReport } from "../src/domain/types";
import { runScorePass } from "../src/scoring/index";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import { resolveOutcome } from "../src/scoring/resolver";
import type { PredictionScore } from "../src/scoring/types";
import type { WithheldSession } from "../src/sources/yahoo";
import { prediction, researchReport } from "./support/fixtures";

let root = "";
const originalFetch = globalThis.fetch;
const OCT_8_PRE_CLOSE = new Date("2026-10-08T15:58:52.674Z");
const OCT_8_AFTER_CLOSE = new Date("2026-10-08T21:00:00.000Z");
const IN_PROGRESS: WithheldSession = {
  date: "2026-10-08",
  status: "in-progress",
  closesAt: "2026-10-08T20:00:00.000Z",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "completed-session-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

const clfdReport = (
  predictions: readonly Prediction[],
  extras?: ResearchReport["extras"],
  generatedAt = "2026-10-07T14:04:29.654Z",
) =>
  researchReport({
    runId: "run-clfd",
    jobType: "equity",
    assetClass: "equity",
    symbol: "CLFD",
    generatedAt,
    predictions,
    ...(extras === undefined ? {} : { extras }),
  });

const rangePrediction = prediction({
  id: "pred-2",
  kind: "range",
  subject: "CLFD",
  measurableAs: "close(CLFD, +1) outside [32, 35]",
  horizonTradingDays: 1,
  probability: 0.22,
  scoringPolicyVersion: 3,
});

const OCT_8_SESSION = { opens: [1_791_379_800, 1_791_466_200], end: 1_791_489_600 };
const MONDAY_OCT_12_SESSION = { opens: [1_791_552_600, 1_791_811_800], end: 1_791_835_200 };

function yahooChart(
  closes: readonly number[],
  session: { readonly opens: readonly number[]; readonly end: number } = OCT_8_SESSION,
  regularStart = session.opens[1],
): unknown {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "CLFD",
            currentTradingPeriod: {
              regular: { timezone: "EDT", start: regularStart, end: session.end },
            },
          },
          timestamp: session.opens.slice(0, closes.length),
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

function withheldWindow(
  observations: readonly Observation[],
  withheldSessions: readonly WithheldSession[],
): readonly Observation[] {
  return Object.assign([...observations], { withheldSessions });
}

function repository(window: ObservationRepository["window"]): ObservationRepository {
  return {
    point: async () => {
      throw new Error("unexpected point observation request");
    },
    window,
  };
}

const oct7 = (subject: string, value: number): Observation => ({
  subject,
  date: "2026-10-07",
  value,
});

describe("completed-session scoring", () => {
  const legacyPrediction = prediction({
    id: "pred-2",
    kind: "range",
    subject: "CLFD",
    measurableAs: "close(CLFD, +1) outside [32, 35]",
    horizonTradingDays: 1,
    probability: 0.22,
  });
  const twoPassCases = [
    {
      name: "the exact October 8 pre-close policy-v3 case",
      pred: rangePrediction,
      firstCloses: [32.9, 32.45],
      firstNow: OCT_8_PRE_CLOSE,
      cache: "split-adjusted-close/yahoo/equity/clfd/2026-10-07_2026-10-08.json",
    },
    {
      name: "the same pre-close case under legacy policy v2",
      pred: legacyPrediction,
      firstCloses: [32.9, 32.45],
      firstNow: OCT_8_PRE_CLOSE,
      cache: "raw-close/yahoo-massive/equity/clfd/2026-10-07_2026-10-08.json",
    },
    {
      name: "a Monday pre-open window that only has Friday",
      pred: rangePrediction,
      firstCloses: [32.9],
      firstNow: new Date("2026-10-12T10:30:00.000Z"),
      cache: "split-adjusted-close/yahoo/equity/clfd/2026-10-09_2026-10-12.json",
      generatedAt: "2026-10-09T10:00:00.000Z",
      session: MONDAY_OCT_12_SESSION,
      afterClose: new Date("2026-10-12T21:00:00.000Z"),
    },
  ];
  test.each(twoPassCases)(
    "keeps $name pending without spending attempts, then scores the final close",
    async ({ pred, firstCloses, firstNow, cache, generatedAt, session, afterClose }) => {
      const dataDir = join(root, "runs");
      const cacheDir = join(root, "cache");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "report.json"),
        JSON.stringify(clfdReport([pred], undefined, generatedAt)),
      );
      let closes: readonly number[] = firstCloses;
      globalThis.fetch = (async () =>
        Response.json(yahooChart(closes, session))) as unknown as typeof fetch;
      const readScore = async () => {
        const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
          scores: readonly PredictionScore[];
        };
        return file.scores[0];
      };
      const options = { closeCacheDir: cacheDir, refreshProviderHealth: async () => undefined };
      const cachedWindow = join(cacheDir, "close-windows/v3", cache);
      const scoredAt = afterClose ?? OCT_8_AFTER_CLOSE;

      await runScorePass(dataDir, firstNow, options);

      expect(await readScore()).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(existsSync(cachedWindow)).toBe(false);

      closes = [32.9, 31.8];
      await runScorePass(dataDir, scoredAt, options);

      expect(await readScore()).toMatchObject({
        status: "resolved",
        outcome: "hit",
        observedAt: scoredAt.toISOString(),
        evidence: { closeN: 31.8 },
      });
      expect(existsSync(cachedWindow)).toBe(true);
    },
  );

  test.each([
    { schedule: "the next day", open: 1_791_552_600, attempts: 0 },
    { schedule: "nine days out (holiday bound)", open: 1_792_243_800, attempts: 0 },
    { schedule: "eleven days out (past the bound)", open: 1_792_416_600, attempts: 1 },
    { schedule: "a year out", open: 1_823_002_200, attempts: 1 },
  ])(
    "never grades the pre-close October 8 bar on a schedule opening $schedule",
    async ({ open, attempts }) => {
      const dataDir = join(root, "runs");
      const cacheDir = join(root, "cache");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "report.json"), JSON.stringify(clfdReport([rangePrediction])));
      globalThis.fetch = (async () =>
        Response.json(
          yahooChart([32.9, 32.45], { ...OCT_8_SESSION, end: open + 23_400 }, open),
        )) as unknown as typeof fetch;

      await runScorePass(dataDir, OCT_8_PRE_CLOSE, {
        closeCacheDir: cacheDir,
        refreshProviderHealth: async () => undefined,
      });

      const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
        scores: readonly PredictionScore[];
      };
      expect(file.scores[0]).toMatchObject({
        status: "pending",
        resolved: false,
        attemptCount: attempts,
      });
      expect(existsSync(join(cacheDir, "close-windows"))).toBe(false);
    },
  );

  const weekdayPreOpen = [13, 14, 15, 16].flatMap((day) =>
    [0, 3].map((priorAttempts) => ({ day, priorAttempts })),
  );
  test.each(weekdayPreOpen)(
    "keeps a weekday pre-open pass on October $day free with $priorAttempts prior attempts",
    async ({ day, priorAttempts }) => {
      const at = (iso: string) => new Date(`2026-10-${String(day)}T${iso}Z`);
      const open = (offsetDays: number) => 1_791_379_800 + (day - 7 + offsetDays) * 86_400;
      const session = { opens: [open(-1), open(0)], end: open(0) + 23_400 };
      const dataDir = join(root, "runs");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      const generatedAt = `2026-10-${String(day - 1)}T10:00:00.000Z`;
      await writeFile(
        join(runDir, "report.json"),
        JSON.stringify(clfdReport([rangePrediction], undefined, generatedAt)),
      );
      if (priorAttempts > 0) {
        await writeFile(
          join(runDir, "score.json"),
          JSON.stringify({
            runId: "run-clfd",
            scoredAt: generatedAt,
            scores: [
              {
                predictionId: "pred-2",
                runId: "run-clfd",
                status: "pending",
                resolved: false,
                attemptCount: priorAttempts,
                nextAttemptAt: generatedAt,
                scoringVersion: 3,
                evidence: { reason: "observation unavailable" },
              },
            ],
          }),
        );
      }
      let closes: readonly number[] = [32.9];
      globalThis.fetch = (async () =>
        Response.json(yahooChart(closes, session))) as unknown as typeof fetch;
      const options = {
        closeCacheDir: join(root, "cache"),
        refreshProviderHealth: async () => undefined,
      };
      const readScore = async () => {
        const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
          scores: readonly PredictionScore[];
        };
        return file.scores[0];
      };

      await runScorePass(dataDir, at("10:30:00.000"), options);
      expect(await readScore()).toMatchObject({ status: "pending", attemptCount: priorAttempts });

      closes = [32.9, 32.45];
      await runScorePass(dataDir, at("15:00:00.000"), options);
      expect(await readScore()).toMatchObject({ status: "pending", attemptCount: priorAttempts });

      closes = [32.9, 31.8];
      await runScorePass(dataDir, at("21:00:00.000"), options);
      expect(await readScore()).toMatchObject({
        status: "resolved",
        outcome: "hit",
        evidence: { closeN: 31.8 },
      });
    },
  );

  const pendingCases: readonly (readonly [string, Prediction, ResearchReport["extras"]?])[] = [
    [
      "relative",
      prediction({
        id: "pred-rel",
        kind: "relative",
        subject: "CLFD:SPY",
        measurableAs: "close(CLFD, +1) / close(CLFD, 0) > close(SPY, +1) / close(SPY, 0)",
        horizonTradingDays: 1,
        scoringPolicyVersion: 3,
      }),
    ],
    [
      "earnings",
      prediction({
        id: "pred-earnings",
        kind: "earnings-direction",
        subject: "CLFD",
        measurableAs: "earningsReturn(CLFD, 2026-10-07, +1) > 0",
        horizonTradingDays: 1,
        scoringPolicyVersion: 3,
      }),
      { earningsSetup: { event: { timing: "amc" } } },
    ],
  ];
  for (const [name, pred, extras] of pendingCases) {
    test(`treats an in-progress session as horizon-not-elapsed for ${name} Predictions`, async () => {
      const result = await resolveOutcome(
        pred,
        clfdReport([pred], extras),
        repository(async (subject) => withheldWindow([oct7(subject, 32.9)], [IN_PROGRESS])),
        OCT_8_PRE_CLOSE,
      );

      expect(result).toMatchObject({ status: "unresolved", reason: "horizon-not-elapsed" });
    });
  }

  test("keeps a conditional pending-condition while its antecedent session is in progress", async () => {
    const conditional = prediction({
      id: "pred-conditional",
      kind: "conditional",
      subject: "CLFD",
      measurableAs: "if (close(CLFD, +1) > close(CLFD, 0)) then (close(CLFD, +3) > close(CLFD, 0))",
      horizonTradingDays: 3,
      scoringPolicyVersion: 3,
    });

    const result = await resolveOutcome(
      conditional,
      clfdReport([conditional]),
      repository(async (subject) => withheldWindow([oct7(subject, 32.9)], [IN_PROGRESS])),
      OCT_8_PRE_CLOSE,
    );

    expect(result).toMatchObject({
      status: "unresolved",
      reason: "horizon-not-elapsed",
      scoreStatus: "pending-condition",
    });
  });

  const unverified: WithheldSession = {
    date: "2026-10-08",
    status: "unverified",
    reason: "the payload carried no regular trading-period schedule",
  };
  const relative = prediction({
    id: "pred-rel",
    kind: "relative",
    subject: "CLFD:SPY",
    measurableAs: "close(CLFD, +1) / close(CLFD, 0) > close(SPY, +1) / close(SPY, 0)",
    horizonTradingDays: 1,
    scoringPolicyVersion: 3,
  });
  const failureCases = [
    ["unverified withheld sessions", rangePrediction, [unverified], () => [oct7("CLFD", 32.9)]],
    [
      "another instrument's failed fetch behind a running tail",
      relative,
      [IN_PROGRESS],
      (subject: string) => (subject === "SPY" ? [] : [oct7(subject, 32.9)]),
    ],
    ["a missing older session behind a running tail", rangePrediction, [IN_PROGRESS], () => []],
  ] as const;
  test.each(failureCases)(
    "spends an observation attempt for %s",
    async (_name, pred, withheld, observations) => {
      const dataDir = join(root, "runs");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "report.json"), JSON.stringify(clfdReport([pred])));
      const window = async (subject: string) =>
        observations(subject).length === 0 && subject === "SPY"
          ? []
          : withheldWindow(observations(subject), withheld);

      await runScorePass(dataDir, OCT_8_PRE_CLOSE, {
        observationRepository: repository(window),
        refreshProviderHealth: async () => undefined,
      });

      const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
        scores: readonly PredictionScore[];
      };
      expect(file.scores[0]).toMatchObject({
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: "2026-10-09T15:58:52.674Z",
        evidence: { reason: "observation unavailable", withheldSessions: withheld },
      });
    },
  );

  test.each([
    ["false", 32.5],
    ["true", 33.5],
  ])(
    "keeps a mixed-clock conditional pending-condition when a placeholder would read %s",
    async (_branch, oct8Close) => {
      const conditional = prediction({
        id: "pred-mixed",
        kind: "conditional",
        subject: "CLFD",
        measurableAs:
          "if (earningsReturn(CLFD, 2026-10-07, +2) > 0) then (close(CLFD, +3) > close(CLFD, 0))",
        horizonTradingDays: 3,
        scoringPolicyVersion: 3,
      });
      const dataDir = join(root, "runs");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "report.json"),
        JSON.stringify(clfdReport([conditional], { earningsSetup: { event: { timing: "amc" } } })),
      );
      const oct9: WithheldSession = {
        date: "2026-10-09",
        status: "in-progress",
        closesAt: "2026-10-09T20:00:00.000Z",
      };

      await runScorePass(dataDir, new Date("2026-10-12T15:00:00.000Z"), {
        observationRepository: repository(async (subject) =>
          withheldWindow(
            [oct7(subject, 33), { subject, date: "2026-10-08", value: oct8Close }],
            [oct9],
          ),
        ),
        refreshProviderHealth: async () => undefined,
      });

      const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
        scores: readonly PredictionScore[];
      };
      expect(file.scores[0]).toMatchObject({ status: "pending-condition", attemptCount: 0 });
    },
  );
});
