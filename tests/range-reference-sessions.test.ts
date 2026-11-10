import { describe, expect, test } from "bun:test";
import { rangeReferenceSessions, scoredSessions } from "../src/research/range-volatility-reference";
import { exchangeSessionsAfter, isExchangeTradingDay } from "../src/scoring/exchange-calendar";
import type { Observation, ObservationRepository } from "../src/scoring/observations";
import { resolveOutcome } from "../src/scoring/resolver";
import { prediction, researchReport, verifiedMarketSnapshot } from "./support/fixtures";

const DAY_MS = 86_400_000;
const ymd = (time: number) => new Date(time).toISOString().slice(0, 10);

function tradingDaysFrom(from: string, count: number): readonly string[] {
  const days: string[] = [];
  for (let day = Date.parse(`${from}T00:00:00Z`); days.length < count; day += DAY_MS) {
    if (isExchangeTradingDay(new Date(day))) {
      days.push(ymd(day));
    }
  }
  return days;
}

// Only the close `elapsed` sessions after the reference close lands outside the band.
async function resolvesOn(
  generatedAt: string,
  referenceDate: string,
  elapsed: number,
  missingBar?: string,
) {
  const target = tradingDaysFrom(referenceDate, elapsed + 1).at(-1)!;
  const repo: ObservationRepository = {
    point: async () => undefined,
    window: async (subject, _assetClass, from) =>
      tradingDaysFrom(ymd(from.getTime()), 10)
        .filter((date) => date !== missingBar)
        .map((date): Observation => ({ subject, date, value: date === target ? 200 : 100 })),
  };
  const range = prediction({
    kind: "range",
    subject: "AAPL",
    measurableAs: "close(AAPL, +1) outside [90, 110]",
    horizonTradingDays: 1,
    scoringPolicyVersion: 3,
  });
  const report = researchReport({ generatedAt, assetClass: "equity", predictions: [range] });
  return resolveOutcome(range, report, repo, new Date("2026-12-01T00:00:00Z"));
}

describe("range reference sessions", () => {
  test.each([
    ["premarket", "2026-10-23T06:22:50.113Z", "2026-10-23", "2026-10-22", 2],
    ["intraday", "2026-10-23T15:00:00.000Z", "2026-10-23", "2026-10-22", 2],
    ["after close", "2026-10-22T21:30:00.000Z", "2026-10-22", "2026-10-22", 1],
    ["weekend", "2026-10-24T12:00:00.000Z", "2026-10-24", "2026-10-23", 2],
    ["stale reference", "2026-10-23T06:00:00.000Z", "2026-10-23", "2026-10-21", 3],
  ])(
    "counts the sessions the resolver scores for a %s run",
    async (_, generatedAt, analysisDate, referenceDate, expected) => {
      const snapshot = verifiedMarketSnapshot({
        analysisDate,
        recentCloses: [{ date: referenceDate, close: 100 }],
      });
      const elapsed = rangeReferenceSessions(snapshot, 1);

      expect(elapsed).toBe(expected);
      expect(await resolvesOn(generatedAt, referenceDate, elapsed!)).toMatchObject({
        status: "resolved",
        outcome: "hit",
      });
      expect(await resolvesOn(generatedAt, referenceDate, 1)).toMatchObject(
        expected === 1 ? { outcome: "hit" } : { outcome: "miss" },
      );
    },
  );

  // The stated span assumes complete exchange sessions; a missing provider bar shifts scoring later.
  test("scores a later close than the counted span when a provider bar is missing", async () => {
    const elapsed = rangeReferenceSessions(
      verifiedMarketSnapshot({
        analysisDate: "2026-10-23",
        recentCloses: [{ date: "2026-10-22", close: 100 }],
      }),
      1,
    )!;

    expect(elapsed).toBe(2);
    expect(
      await resolvesOn("2026-10-23T06:22:50.113Z", "2026-10-22", elapsed, "2026-10-23"),
    ).toMatchObject({ outcome: "miss" });
    expect(
      await resolvesOn("2026-10-23T06:22:50.113Z", "2026-10-22", elapsed + 1, "2026-10-23"),
    ).toMatchObject({ outcome: "hit" });
  });

  test.each([
    ["Friday to Monday", "2026-11-06", "2026-11-09T05:00:00.000Z", 6],
    ["Friday to Saturday", "2026-11-06", "2026-11-07", 6],
    ["same day", "2026-11-06", "2026-11-06T09:00:00.000Z", 5],
    ["Thursday to Friday", "2026-11-05", "2026-11-06", 6],
    ["Friday to Tuesday", "2026-11-06", "2026-11-10", undefined],
    ["reference after run", "2026-11-09", "2026-11-06", undefined],
  ])("counts a profiled listing's sessions %s", (_, referenceDate, runDate, expected) => {
    expect(
      scoredSessions({ symbol: "0097.KL", assetClass: "equity" }, referenceDate, runDate, 5),
    ).toBe(expected);
  });

  test("leaves a range on an unprofiled index uncounted", () => {
    expect(
      scoredSessions({ symbol: "^KLSE", assetClass: "equity" }, "2026-11-06", "2026-11-06", 5),
    ).toBeUndefined();
  });

  test("agrees with the US calendar wherever the profiled weekend rule gives a count", () => {
    let determinable = 0;
    for (let from = Date.UTC(2026, 0, 1); from <= Date.UTC(2026, 11, 31); from += DAY_MS) {
      for (let days = 0; days <= 5 && from + days * DAY_MS <= Date.UTC(2026, 11, 31); days += 1) {
        const [reference, run] = [ymd(from), ymd(from + days * DAY_MS)];
        const profiled = scoredSessions(
          { symbol: "0097.KL", assetClass: "equity" },
          reference,
          run,
          0,
        );
        if (profiled !== undefined) {
          determinable += 1;
          expect(`${reference}..${run}: ${String(profiled)}`).toBe(
            `${reference}..${run}: ${String(exchangeSessionsAfter(reference, run))}`,
          );
        }
      }
    }
    expect(determinable).toBeGreaterThan(800);
  });

  test("returns no session count for a non-US listing", () => {
    expect(
      rangeReferenceSessions(
        verifiedMarketSnapshot({
          symbol: "RY.TO",
          analysisDate: "2026-10-23",
          recentCloses: [{ date: "2026-10-22", close: 100 }],
        }),
        1,
      ),
    ).toBeUndefined();
  });

  test("returns no session count when the latest session is unverified", () => {
    expect(
      rangeReferenceSessions(
        verifiedMarketSnapshot({
          analysisDate: "2026-10-23",
          latestSessionStatus: "unverified",
          recentCloses: [{ date: "2026-10-23", close: 100 }],
        }),
        1,
      ),
    ).toBeUndefined();
  });
});
