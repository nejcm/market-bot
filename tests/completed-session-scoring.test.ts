import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAY_MS } from "../src/config/shared";
import type { Prediction } from "../src/domain/prediction";
import type { ResearchReport } from "../src/domain/report";
import { runScorePass } from "../src/scoring/index";
import { scoringPolicyFor } from "../src/scoring/policy";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import { resolveOutcome } from "../src/scoring/resolver";
import type { PredictionScore } from "../src/scoring/types";
import { verifiedSnapshotSource } from "../src/sources/verified-snapshot-contract";
import type { WithheldSession } from "../src/sources/yahoo-chart";
import { prediction, researchReport, verifiedMarketSnapshot } from "./support/fixtures";

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
  closes: readonly (number | null)[],
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
      let closes: readonly (number | null)[] = firstCloses;
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
      expect(file.scores[0]).toMatchObject({ status: "pending", attemptCount: attempts });
      expect(file.scores[0]).not.toHaveProperty("resolved");
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

  // Yahoo nulled the settled 2026-11-06 ^KLSE close (run 2026-11-06T21-47-29-661Z-cc03f563).
  const OCT_9_SESSION = { opens: [...OCT_8_SESSION.opens, 1_791_552_600], end: 1_791_576_000 };
  test.each([
    ["the trailing resolution bar", [32.9, null], OCT_8_SESSION, OCT_8_AFTER_CLOSE, ["2026-10-08"]],
    [
      "a mid-series resolution bar",
      [32.9, null, 33.5],
      OCT_9_SESSION,
      new Date("2026-10-09T21:00:00.000Z"),
      undefined,
    ],
    ["every bar", [null, null], OCT_8_SESSION, OCT_8_AFTER_CLOSE, undefined],
  ] as const)(
    "never resolves on another session when Yahoo nulls %s",
    async (_name, nullCloses, session, scoredAt, withheldDates) => {
      const dataDir = join(root, "runs");
      const cacheDir = join(root, "cache");
      const runDir = join(dataDir, "run-clfd");
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "report.json"), JSON.stringify(clfdReport([rangePrediction])));
      let closes: readonly (number | null)[] = nullCloses;
      globalThis.fetch = (async () =>
        Response.json(yahooChart(closes, session))) as unknown as typeof fetch;
      const options = { closeCacheDir: cacheDir, refreshProviderHealth: async () => undefined };
      const readScore = async () =>
        (
          JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
            scores: readonly PredictionScore[];
          }
        ).scores[0];

      await runScorePass(dataDir, scoredAt, options);

      const pending = await readScore();
      expect(pending).toMatchObject({ status: "pending", attemptCount: 1 });
      expect(
        (pending?.evidence?.withheldSessions as readonly WithheldSession[] | undefined)?.map(
          ({ date, status }) => `${date} ${status}`,
        ),
      ).toEqual(withheldDates?.map((date) => `${date} unverified`));
      expect(existsSync(join(cacheDir, "close-windows"))).toBe(false);

      closes = [32.9, 31.8, 33.5].slice(0, session.opens.length);
      await runScorePass(dataDir, new Date(scoredAt.getTime() + 86_400_000), options);

      expect(await readScore()).toMatchObject({ status: "resolved", evidence: { closeN: 31.8 } });
    },
  );
});

// Bursa skipped 2026-11-09 (Deepavali replacement); the US-calendar +1 due date fell on it.
const KL_ISSUED = "2026-11-06T05:46:13.672Z";
const AFTER_KL_DUE = new Date("2026-11-09T12:00:00.000Z");

const range = (horizon: number, subject = "0097.KL", scoringPolicyVersion: 2 | 3 = 3) =>
  prediction({
    id: "pred-kl",
    kind: "range",
    subject,
    measurableAs: `close(${subject}, +${String(horizon)}) outside [10.35, 10.86]`,
    horizonTradingDays: horizon,
    probability: 0.32,
    ...(scoringPolicyVersion === 3 ? { scoringPolicyVersion } : {}),
  });
const klRelative = prediction({
  id: "pred-kl",
  kind: "relative",
  subject: "0097.KL:SPY",
  measurableAs: "close(0097.KL, +1) / close(0097.KL, 0) > close(SPY, +1) / close(SPY, 0)",
  horizonTradingDays: 1,
  scoringPolicyVersion: 3,
});
const klConditional = prediction({
  id: "pred-kl",
  kind: "conditional",
  subject: "0097.KL",
  measurableAs:
    "if (close(0097.KL, +1) > close(0097.KL, 0)) then (close(0097.KL, +5) > close(0097.KL, 0))",
  horizonTradingDays: 5,
  scoringPolicyVersion: 3,
});
const waitDeadline = (pred: Prediction) =>
  scoringPolicyFor(pred).closeDueDate(KL_ISSUED, pred.horizonTradingDays, "equity").getTime() +
  10 * DAY_MS;
const bars = (subject: string, ...dates: readonly string[]): readonly Observation[] =>
  dates.map((date, index) => ({ subject, date, value: 10.5 + index * 0.1 }));
const inProgress = (date: string): WithheldSession => ({
  date,
  status: "in-progress",
  closesAt: `${date}T09:00:00.000Z`,
});

describe("non-US short-window fallback wait", () => {
  async function scorePass(
    pred: Prediction,
    window: (subject: string) => readonly Observation[],
    now: Date,
    overrides: Partial<ResearchReport> = {},
  ): Promise<PredictionScore | undefined> {
    const runDir = join(root, "runs", "run-kl");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "report.json"),
      JSON.stringify(
        researchReport({
          runId: "run-kl",
          jobType: "equity",
          assetClass: "equity",
          symbol: "0097.KL",
          generatedAt: KL_ISSUED,
          predictions: [pred],
          ...overrides,
        }),
      ),
    );
    await runScorePass(join(root, "runs"), now, {
      observationRepository: repository(async (subject) => window(subject)),
      refreshProviderHealth: async () => undefined,
    });
    const file = JSON.parse(await readFile(join(runDir, "score.json"), "utf8")) as {
      scores: readonly PredictionScore[];
    };
    return file.scores[0];
  }

  test("waits without an attempt when a Bursa window is short and carries no withheld session", async () => {
    const score = await scorePass(range(1), (subject) => bars(subject, "2026-11-06"), AFTER_KL_DUE);

    expect(score).toEqual({
      predictionId: "pred-kl",
      runId: "run-kl",
      status: "pending",
      attemptCount: 0,
      scoringVersion: 3,
      evidence: { reason: "horizon not yet elapsed" },
    });
  });

  test("resolves the same Prediction once the next Bursa session prints", async () => {
    const score = await scorePass(
      range(1),
      (subject) => [
        { subject, date: "2026-11-06", value: 10.5 },
        { subject, date: "2026-11-10", value: 10.2 },
      ],
      new Date("2026-11-10T12:00:00.000Z"),
    );

    expect(score).toMatchObject({
      status: "resolved",
      outcome: "hit",
      attemptCount: 1,
      forecastOrigin: "2026-11-06",
      evidence: { closeN: 10.2 },
    });
  });

  test("waits on a short window whose withheld session cannot complete it, until the deadline", async () => {
    const window = (subject: string) =>
      withheldWindow(bars(subject, "2026-11-06"), [inProgress("2026-11-10")]);

    expect(await scorePass(range(5), window, new Date("2026-11-16T12:00:00.000Z"))).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    const deadline = waitDeadline(range(5));
    const late = await scorePass(range(5), window, new Date(deadline));

    expect(late).toMatchObject({
      status: "pending",
      attemptCount: 1,
      nextAttemptAt: new Date(deadline + DAY_MS).toISOString(),
      evidence: { reason: "observation unavailable", withheldSessions: [inProgress("2026-11-10")] },
    });
  });

  test.each([
    ["a Bursa", range(1), {}],
    ["a US", range(1, "AAPL"), { symbol: "AAPL" }],
    ["a policy-v2 Bursa", range(1, "0097.KL", 2), {}],
  ] as const)(
    "ends %s withheld-session wait at the due date plus 10 days",
    async (_name, pred, overrides) => {
      const deadline = waitDeadline(pred);
      const window = (subject: string) =>
        withheldWindow(bars(subject, "2026-11-06"), [inProgress("2026-11-10")]);

      const waiting = await scorePass(pred, window, new Date(deadline - 1), overrides);
      expect(waiting).toMatchObject({ status: "pending", attemptCount: 0 });
      expect(waiting).not.toHaveProperty("nextAttemptAt");

      expect(await scorePass(pred, window, new Date(deadline), overrides)).toMatchObject({
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: new Date(deadline + DAY_MS).toISOString(),
        evidence: {
          reason: "observation unavailable",
          withheldSessions: [inProgress("2026-11-10")],
        },
      });
    },
  );

  test("abandons a still-withheld session on the fourth attempt past the deadline and keeps it in evidence", async () => {
    const deadline = waitDeadline(range(1));
    const window = (subject: string) =>
      withheldWindow(bars(subject, "2026-11-06"), [inProgress("2026-11-10")]);
    let score: PredictionScore | undefined;
    for (const days of [0, 1, 4, 11]) {
      score = await scorePass(range(1), window, new Date(deadline + days * DAY_MS));
    }

    expect(score).toMatchObject({
      status: "abandoned",
      attemptCount: 4,
      evidence: {
        reason: "abandoned after fourth observation failure",
        withheldSessions: [inProgress("2026-11-10")],
      },
    });
  });

  test("keeps withheld sessions when a row already at four attempts is abandoned", async () => {
    const runDir = join(root, "runs", "run-kl");
    await mkdir(runDir, { recursive: true });
    const withheldSessions = [inProgress("2026-11-10")];
    await writeFile(
      join(runDir, "score.json"),
      JSON.stringify({
        runId: "run-kl",
        scoredAt: KL_ISSUED,
        scores: [
          {
            predictionId: "pred-kl",
            runId: "run-kl",
            status: "pending",
            attemptCount: 4,
            scoringVersion: 3,
            evidence: { reason: "observation unavailable", withheldSessions },
          },
        ],
      }),
    );

    const score = await scorePass(range(1), () => [], new Date(waitDeadline(range(1))));

    expect(score).toMatchObject({
      status: "abandoned",
      attemptCount: 4,
      evidence: { reason: "abandoned after fourth observation failure", withheldSessions },
    });
  });

  test("resolves past the deadline once the withheld session completes", async () => {
    const score = await scorePass(
      range(1),
      (subject) => bars(subject, "2026-11-06", "2026-11-10"),
      new Date(waitDeadline(range(1))),
    );

    expect(score).toMatchObject({ status: "resolved", attemptCount: 1 });
  });

  test("measures a withheld antecedent against the antecedent's deadline", async () => {
    const conditional = prediction({
      id: "pred-kl",
      kind: "conditional",
      subject: "0097.KL",
      measurableAs:
        "if (close(0097.KL, +1) > close(0097.KL, 0)) then (close(0097.KL, +20) > close(0097.KL, 0))",
      horizonTradingDays: 20,
      scoringPolicyVersion: 3,
    });
    const deadline = waitDeadline(range(1));
    const window = (subject: string) =>
      withheldWindow(bars(subject, "2026-11-06"), [inProgress("2026-11-10")]);

    expect(await scorePass(conditional, window, new Date(deadline - 1))).toMatchObject({
      status: "pending-condition",
      attemptCount: 0,
    });
    expect(await scorePass(conditional, window, new Date(deadline))).toMatchObject({
      status: "pending-condition",
      attemptCount: 1,
    });
    let score: PredictionScore | undefined;
    for (const days of [1, 4, 11]) {
      score = await scorePass(conditional, window, new Date(deadline + days * DAY_MS));
    }
    const consequentDue = scoringPolicyFor(conditional)
      .closeDueDate(KL_ISSUED, 20, "equity")
      .getTime();

    expect(score).toMatchObject({ status: "abandoned", attemptCount: 4 });
    expect(Date.parse(String(score?.status === "abandoned" ? score.abandonedAt : ""))).toBeLessThan(
      consequentDue,
    );
  });

  test("measures a withheld consequent against the consequent's deadline", async () => {
    const deadline = waitDeadline(range(5));
    const window = (subject: string) =>
      withheldWindow(
        bars(subject, "2026-11-06", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"),
        [inProgress("2026-11-16")],
      );

    expect(await scorePass(klConditional, window, new Date(deadline - 1))).toMatchObject({
      status: "active-pending",
      attemptCount: 0,
    });
    expect(await scorePass(klConditional, window, new Date(deadline))).toMatchObject({
      status: "active-pending",
      attemptCount: 1,
      evidence: { withheldSessions: [inProgress("2026-11-16")] },
    });
  });

  test("spends an attempt on each rolling fragment anchored outside the provider tolerance", async () => {
    const attempts = [];
    for (const day of ["2026-11-20", "2026-12-20"]) {
      const score = await scorePass(
        range(5),
        (subject) => bars(subject, day),
        new Date(`${day}T12:00:00.000Z`),
      );
      attempts.push(score?.attemptCount);
    }

    expect(attempts).toEqual([1, 2]);
  });

  test("waits without an attempt on an empty Bursa window inside the anchor tolerance", async () => {
    const score = await scorePass(range(1), () => [], AFTER_KL_DUE);

    expect(score).toMatchObject({ status: "pending", attemptCount: 0 });
    expect(score).not.toHaveProperty("nextAttemptAt");
  });

  test("spends an attempt on a failed Bursa fetch inside the anchor tolerance", async () => {
    const score = await scorePass(
      range(1),
      () => Object.assign([], { fetchFailure: "fetch-failed" }),
      AFTER_KL_DUE,
    );

    expect(score).toMatchObject({
      status: "pending",
      attemptCount: 1,
      nextAttemptAt: new Date(AFTER_KL_DUE.getTime() + DAY_MS).toISOString(),
      evidence: { fetchFailures: ["fetch-failed"] },
    });
  });

  test("keeps the fetch failure cause on the fourth failed attempt", async () => {
    const failed = (now: number) =>
      scorePass(range(1), () => Object.assign([], { fetchFailure: "fetch-failed" }), new Date(now));
    let score: PredictionScore | undefined;
    for (const days of [0, 1, 4, 11]) {
      score = await failed(AFTER_KL_DUE.getTime() + days * DAY_MS);
    }

    expect(score).toMatchObject({
      status: "abandoned",
      attemptCount: 4,
      evidence: { fetchFailures: ["fetch-failed"] },
    });
  });

  // Run 2026-11-07T10-12-13-737Z-3f1aa431: issued Saturday, no Bursa bar yet on the Monday pass.
  test("waits on an empty window for a weekend-issued +1 and resolves once Bursa prints", async () => {
    const generatedAt = "2026-11-07T10:12:13.737Z";
    const waiting = await scorePass(range(1), () => [], AFTER_KL_DUE, { generatedAt });
    expect(waiting).toMatchObject({ status: "pending", attemptCount: 0 });

    const score = await scorePass(
      range(1),
      (subject) => bars(subject, "2026-11-10", "2026-11-11"),
      new Date("2026-11-11T12:00:00.000Z"),
      { generatedAt },
    );
    expect(score).toMatchObject({
      status: "resolved",
      attemptCount: 1,
      forecastOrigin: "2026-11-10",
    });
  });

  test("stops waiting on an empty Bursa window after the anchor tolerance and abandons on the fourth attempt", async () => {
    const lastToleranceDay = Date.parse(`${KL_ISSUED.slice(0, 10)}T12:00:00.000Z`) + 5 * DAY_MS;
    expect(await scorePass(range(1), () => [], new Date(lastToleranceDay))).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    const firstLate = lastToleranceDay + DAY_MS;
    expect(await scorePass(range(1), () => [], new Date(firstLate))).toMatchObject({
      status: "pending",
      attemptCount: 1,
      nextAttemptAt: new Date(firstLate + DAY_MS).toISOString(),
    });
    let score: PredictionScore | undefined;
    for (const days of [1, 4, 11]) {
      score = await scorePass(range(1), () => [], new Date(firstLate + days * DAY_MS));
    }

    expect(score).toMatchObject({ status: "abandoned", attemptCount: 4 });
  });

  test.each([
    ["a Bursa +5 due past the anchor tolerance", range(5), {}],
    ["a US listing", range(1, "AAPL"), { symbol: "AAPL" }],
  ] as const)("spends an attempt on an empty window for %s", async (_name, pred, overrides) => {
    const due = scoringPolicyFor(pred).closeDueDate(KL_ISSUED, pred.horizonTradingDays, "equity");
    const score = await scorePass(pred, () => [], due, overrides);

    expect(score).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  test.each([
    ["an empty Bursa leg beside a complete SPY leg", ["2026-11-06", "2026-11-09"], 0],
    ["an empty Bursa leg beside an empty SPY leg", [], 1],
  ] as const)("counts attempts for %s", async (_name, spy, attempts) => {
    const score = await scorePass(
      klRelative,
      (subject) => (subject === "SPY" ? bars(subject, ...spy) : []),
      AFTER_KL_DUE,
    );

    expect(score).toMatchObject({ status: "pending", attemptCount: attempts });
  });

  test("spends an attempt on an empty Bursa window when the origin session is quarantined", async () => {
    const score = await scorePass(range(1), () => [], AFTER_KL_DUE, {
      sources: [
        verifiedSnapshotSource(
          verifiedMarketSnapshot({
            symbol: "0097.KL",
            latestSessionDate: "2026-11-06",
            latestSessionStatus: "unverified",
          }),
        ),
      ],
    });

    expect(score).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  test("spends an attempt when the origin session is quarantined", async () => {
    const score = await scorePass(
      range(1),
      (subject) => bars(subject, "2026-11-06"),
      AFTER_KL_DUE,
      {
        sources: [
          verifiedSnapshotSource(
            verifiedMarketSnapshot({
              symbol: "0097.KL",
              latestSessionDate: "2026-11-06",
              latestSessionStatus: "unverified",
            }),
          ),
        ],
      },
    );

    expect(score).toMatchObject({ status: "pending", attemptCount: 1 });
  });

  test.each([
    [
      "a short Bursa leg beside a complete SPY leg",
      ["2026-11-06"],
      ["2026-11-06", "2026-11-09"],
      0,
    ],
    ["a short SPY leg", ["2026-11-06", "2026-11-10"], ["2026-11-06"], 1],
    ["a Bursa leg anchored out of tolerance", ["2026-11-12"], ["2026-11-06", "2026-11-09"], 1],
    ["a SPY leg anchored out of tolerance", ["2026-11-06"], ["2026-11-12", "2026-11-13"], 1],
  ] as const)("scores %s with %d attempts", async (_name, kl, spy, attempts) => {
    const score = await scorePass(
      klRelative,
      (subject) => bars(subject, ...(subject === "SPY" ? spy : kl)),
      new Date("2026-11-14T00:00:00.000Z"),
    );

    expect(score).toMatchObject({ status: "pending", attemptCount: attempts });
  });

  test.each([
    [
      "active-pending",
      ["2026-11-06", "2026-11-10", "2026-11-11", "2026-11-12"],
      new Date("2026-11-16T12:00:00.000Z"),
    ],
    ["pending-condition", ["2026-11-06"], AFTER_KL_DUE],
  ] as const)("keeps a Bursa conditional %s without an attempt", async (status, dates, now) => {
    const score = await scorePass(klConditional, (subject) => bars(subject, ...dates), now);

    expect(score).toMatchObject({ status, attemptCount: 0 });
  });

  test.each([
    ["an AAPL short window", range(1, "AAPL"), [], { symbol: "AAPL" }],
    [
      "an AAPL short window with a withheld session",
      range(5, "AAPL"),
      [inProgress("2026-11-09")],
      { symbol: "AAPL" },
    ],
    ["a policy-v2 Bursa window", range(1, "0097.KL", 2), [], {}],
    [
      "a policy-v2 Bursa window with a withheld session",
      range(5, "0097.KL", 2),
      [inProgress("2026-11-10")],
      {},
    ],
  ] as const)(
    "spends an attempt on %s, as before the fallback",
    async (_name, pred, withheld, overrides) => {
      const now = new Date("2026-11-16T12:00:00.000Z");
      const score = await scorePass(
        pred,
        (subject) =>
          withheld.length === 0
            ? bars(subject, "2026-11-06")
            : withheldWindow(bars(subject, "2026-11-06"), withheld),
        now,
        overrides,
      );

      expect(score).toMatchObject({
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: "2026-11-17T12:00:00.000Z",
        evidence: {
          reason: "observation unavailable",
          ...(withheld.length === 0 ? {} : { withheldSessions: withheld }),
        },
      });
    },
  );
});
