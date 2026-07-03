import { describe, expect, test } from "bun:test";
import { resolveOutcome, type Observation } from "../src/scoring/resolver";
import { buildCalibrationSummary } from "../src/scoring/calibration";
import { renderCalibrationMarkdown } from "../src/scoring/calibration-markdown";
import {
  renderCalibrationConsole,
  MIN_CALIBRATION_SAMPLE,
} from "../src/scoring/calibration-console";
import { forecastErrorDirection } from "../src/scoring/miss-autopsy";
import type { MarketRegimeLabel, Prediction } from "../src/domain/types";
import type { ObservationRepository } from "../src/scoring/observations";
import { prediction, predictionScore, researchReport } from "./support/fixtures";

const basePrediction: Prediction = prediction();
const report = researchReport({ generatedAt: "2026-05-01T00:00:00.000Z" });
const now = new Date("2026-05-20T00:00:00.000Z");

function closeWindow(subject: string, values: readonly number[]): readonly Observation[] {
  return values.map((value, index) => ({
    subject,
    date: `2026-05-${String(index + 1).padStart(2, "0")}`,
    value,
  }));
}

function observationRepository(observations: readonly Observation[]): ObservationRepository {
  return {
    async point(request, _assetClass, date) {
      const ymd = date.toISOString().slice(0, 10);
      return observations.find(
        (observation) =>
          observation.subject === request.observationSubject && observation.date === ymd,
      );
    },

    async window(subject) {
      return observations
        .filter((observation) => observation.subject === subject)
        .toSorted((left, right) => left.date.localeCompare(right.date));
    },
  };
}

async function resolveWith(
  pred: Prediction,
  observations: readonly Observation[],
): Promise<Awaited<ReturnType<typeof resolveOutcome>>> {
  return resolveOutcome(pred, report, observationRepository(observations), now);
}

describe("resolveOutcome", () => {
  describe("direction", () => {
    test("returns hit when close-N > close-0", async () => {
      const result = await resolveWith(basePrediction, [
        { subject: "SPY", date: "2026-05-01", value: 500 },
        { subject: "SPY", date: "2026-05-02", value: 502 },
        { subject: "SPY", date: "2026-05-03", value: 504 },
        { subject: "SPY", date: "2026-05-04", value: 506 },
        { subject: "SPY", date: "2026-05-05", value: 508 },
        { subject: "SPY", date: "2026-05-08", value: 510 },
      ]);
      expect(result.status).toBe("resolved");
      expect(result).toMatchObject({ outcome: "hit", evidence: { close0: 500, closeN: 510 } });
    });

    test("returns miss when close-N <= close-0", async () => {
      const result = await resolveWith(basePrediction, [
        { subject: "SPY", date: "2026-05-01", value: 510 },
        { subject: "SPY", date: "2026-05-02", value: 508 },
        { subject: "SPY", date: "2026-05-03", value: 506 },
        { subject: "SPY", date: "2026-05-04", value: 504 },
        { subject: "SPY", date: "2026-05-05", value: 502 },
        { subject: "SPY", date: "2026-05-08", value: 500 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });

    test("returns unresolved when close prices unavailable", async () => {
      const result = await resolveWith(basePrediction, []);
      expect(result).toMatchObject({
        status: "unresolved",
        reason: "observation-unavailable",
        evidence: { reason: "observation unavailable" },
      });
    });

    test("returns unresolved before horizon without fetching observations", async () => {
      const repo: ObservationRepository = {
        point: async () => {
          throw new Error("unexpected point observation request");
        },
        window: async () => {
          throw new Error("unexpected window observation request");
        },
      };

      const result = await resolveOutcome(
        basePrediction,
        report,
        repo,
        new Date("2026-05-05T00:00:00.000Z"),
      );

      expect(result).toMatchObject({
        status: "unresolved",
        reason: "horizon-not-elapsed",
        evidence: { reason: "horizon not yet elapsed" },
      });
    });
  });

  describe("relative", () => {
    const relPrediction: Prediction = {
      ...basePrediction,
      id: "pred-rel",
      kind: "relative",
      subject: "QQQ:SPY",
      measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
      claim: "QQQ outperforms SPY.",
    };

    test("returns hit when QQQ outperforms SPY", async () => {
      const result = await resolveWith(relPrediction, [
        { subject: "QQQ", date: "2026-05-01", value: 400 },
        { subject: "QQQ", date: "2026-05-02", value: 404 },
        { subject: "QQQ", date: "2026-05-03", value: 408 },
        { subject: "QQQ", date: "2026-05-04", value: 412 },
        { subject: "QQQ", date: "2026-05-05", value: 416 },
        { subject: "QQQ", date: "2026-05-08", value: 420 },
        { subject: "SPY", date: "2026-05-01", value: 500 },
        { subject: "SPY", date: "2026-05-02", value: 501 },
        { subject: "SPY", date: "2026-05-03", value: 502 },
        { subject: "SPY", date: "2026-05-04", value: 503 },
        { subject: "SPY", date: "2026-05-05", value: 504 },
        { subject: "SPY", date: "2026-05-08", value: 505 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("returns miss when SPY outperforms QQQ", async () => {
      const result = await resolveWith(relPrediction, [
        { subject: "QQQ", date: "2026-05-01", value: 400 },
        { subject: "QQQ", date: "2026-05-02", value: 400 },
        { subject: "QQQ", date: "2026-05-03", value: 400 },
        { subject: "QQQ", date: "2026-05-04", value: 400 },
        { subject: "QQQ", date: "2026-05-05", value: 400 },
        { subject: "QQQ", date: "2026-05-08", value: 401 },
        { subject: "SPY", date: "2026-05-01", value: 500 },
        { subject: "SPY", date: "2026-05-02", value: 502 },
        { subject: "SPY", date: "2026-05-03", value: 504 },
        { subject: "SPY", date: "2026-05-04", value: 506 },
        { subject: "SPY", date: "2026-05-05", value: 508 },
        { subject: "SPY", date: "2026-05-08", value: 510 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });
  });

  describe("volatility", () => {
    const volPrediction: Prediction = {
      ...basePrediction,
      id: "pred-vol",
      kind: "volatility",
      subject: "^VIX",
      measurableAs: "max(close(^VIX), 0..+5) > 20",
      claim: "VIX spikes above 20.",
    };

    test("returns hit when any close exceeds threshold", async () => {
      const result = await resolveWith(volPrediction, [
        { subject: "^VIX", date: "2026-05-01", value: 18 },
        { subject: "^VIX", date: "2026-05-03", value: 22 },
        { subject: "^VIX", date: "2026-05-05", value: 19 },
        { subject: "^VIX", date: "2026-05-06", value: 18 },
        { subject: "^VIX", date: "2026-05-07", value: 17 },
        { subject: "^VIX", date: "2026-05-08", value: 16 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("returns miss when all closes stay below threshold", async () => {
      const result = await resolveWith(volPrediction, [
        { subject: "^VIX", date: "2026-05-01", value: 15 },
        { subject: "^VIX", date: "2026-05-02", value: 16 },
        { subject: "^VIX", date: "2026-05-03", value: 17 },
        { subject: "^VIX", date: "2026-05-04", value: 18 },
        { subject: "^VIX", date: "2026-05-05", value: 18 },
        { subject: "^VIX", date: "2026-05-08", value: 19 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });
  });

  describe("range", () => {
    const rangePrediction: Prediction = {
      ...basePrediction,
      id: "pred-range",
      kind: "range",
      subject: "BTC",
      measurableAs: "close(BTC, +7) outside [90000, 110000]",
      horizonTradingDays: 7,
      claim: "BTC breaks the 90k-110k band.",
    };

    test("returns hit when close-N is below lo", async () => {
      const result = await resolveWith(rangePrediction, [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-08", value: 85_000 },
        { subject: "BTC", date: "2026-05-09", value: 86_000 },
        { subject: "BTC", date: "2026-05-10", value: 87_000 },
        { subject: "BTC", date: "2026-05-11", value: 88_000 },
        { subject: "BTC", date: "2026-05-12", value: 89_000 },
        { subject: "BTC", date: "2026-05-13", value: 90_000 },
        { subject: "BTC", date: "2026-05-14", value: 85_000 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("returns hit when close-N is above hi", async () => {
      const result = await resolveWith(rangePrediction, [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-08", value: 115_000 },
        { subject: "BTC", date: "2026-05-09", value: 114_000 },
        { subject: "BTC", date: "2026-05-10", value: 113_000 },
        { subject: "BTC", date: "2026-05-11", value: 112_000 },
        { subject: "BTC", date: "2026-05-12", value: 111_000 },
        { subject: "BTC", date: "2026-05-13", value: 110_000 },
        { subject: "BTC", date: "2026-05-14", value: 115_000 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("returns miss when close-N is within range", async () => {
      const result = await resolveWith(rangePrediction, [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-08", value: 102_000 },
        { subject: "BTC", date: "2026-05-09", value: 103_000 },
        { subject: "BTC", date: "2026-05-10", value: 104_000 },
        { subject: "BTC", date: "2026-05-11", value: 105_000 },
        { subject: "BTC", date: "2026-05-12", value: 106_000 },
        { subject: "BTC", date: "2026-05-13", value: 107_000 },
        { subject: "BTC", date: "2026-05-14", value: 102_000 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });
  });

  describe("macro and IV", () => {
    test("returns hit when FRED series rises", async () => {
      const result = await resolveWith(
        {
          ...basePrediction,
          id: "pred-macro",
          kind: "macro",
          subject: "DGS10",
          measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)",
          claim: "DGS10 rises over 5 trading days.",
        },
        [
          { subject: "FRED:DGS10", date: "2026-05-01", value: 4.1 },
          { subject: "FRED:DGS10", date: "2026-05-08", value: 4.3 },
        ],
      );
      expect(result.status).toBe("resolved");
      expect(result).toMatchObject({ outcome: "hit", evidence: { fred0: 4.1, fredN: 4.3 } });
    });

    test("returns hit when IV exceeds threshold", async () => {
      const result = await resolveWith(
        {
          ...basePrediction,
          id: "pred-iv",
          kind: "iv",
          subject: "AAPL",
          measurableAs: "iv(AAPL, +5) > 0.35",
          claim: "AAPL implied volatility exceeds 0.35 over 5 trading days.",
        },
        [{ subject: "IV:AAPL", date: "2026-05-08", value: 0.4 }],
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });
  });

  describe("scoring policy clocks", () => {
    test("macro point observations target trading days under v2 and calendar days under v3", async () => {
      const requestedDates: string[] = [];
      const recordingRepo: ObservationRepository = {
        async point(request, _assetClass, date) {
          const ymd = date.toISOString().slice(0, 10);
          requestedDates.push(ymd);
          return { subject: request.observationSubject, date: ymd, value: 4.2 };
        },
        async window() {
          throw new Error("unexpected window observation request");
        },
      };
      const macroPrediction: Prediction = {
        ...basePrediction,
        id: "pred-macro-clock",
        kind: "macro",
        subject: "DGS10",
        measurableAs: "fred(DGS10, +5) > fred(DGS10, 0)",
        claim: "DGS10 rises over 5 trading days.",
      };

      // GeneratedAt 2026-05-01 is a Friday: +5 trading days lands on 05-08,
      // While +5 UTC calendar days lands on 05-06.
      await resolveOutcome(macroPrediction, report, recordingRepo, now);
      expect(requestedDates).toContain("2026-05-08");
      expect(requestedDates).not.toContain("2026-05-06");

      requestedDates.length = 0;
      await resolveOutcome(
        { ...macroPrediction, scoringPolicyVersion: 3 },
        report,
        recordingRepo,
        now,
      );
      expect(requestedDates).toContain("2026-05-06");
      expect(requestedDates).not.toContain("2026-05-08");
    });

    test("crypto close forecasts resolve on the target UTC calendar date under v3", async () => {
      const cryptoReport = researchReport({
        assetClass: "crypto",
        generatedAt: "2026-05-01T00:00:00.000Z",
      });
      const btcPrediction: Prediction = {
        ...basePrediction,
        id: "pred-btc-clock",
        kind: "direction",
        subject: "BTC",
        measurableAs: "close(BTC, +3) > close(BTC, 0)",
        claim: "BTC closes higher over 3 trading days.",
        horizonTradingDays: 3,
        scoringPolicyVersion: 3,
      };
      // Target UTC date is 2026-05-04 (generatedAt + 3 calendar days).
      const withTargetDate = [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-02", value: 101_000 },
        { subject: "BTC", date: "2026-05-03", value: 102_000 },
        { subject: "BTC", date: "2026-05-04", value: 103_000 },
      ];

      const resolved = await resolveOutcome(
        btcPrediction,
        cryptoReport,
        observationRepository(withTargetDate),
        now,
      );
      expect(resolved).toMatchObject({
        status: "resolved",
        outcome: "hit",
        evidence: { close0: 100_000, closeN: 103_000 },
      });

      // Four provider sessions exist but none on the target UTC date: v3 stays
      // Unresolved where v2 session counting would have resolved.
      const missingTargetDate = [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-02", value: 101_000 },
        { subject: "BTC", date: "2026-05-03", value: 102_000 },
        { subject: "BTC", date: "2026-05-05", value: 103_000 },
      ];
      const unresolved = await resolveOutcome(
        btcPrediction,
        cryptoReport,
        observationRepository(missingTargetDate),
        now,
      );
      expect(unresolved).toMatchObject({
        status: "unresolved",
        reason: "observation-unavailable",
      });

      const { scoringPolicyVersion: _stamped, ...legacyPrediction } = btcPrediction;
      const legacyResolved = await resolveOutcome(
        legacyPrediction,
        cryptoReport,
        observationRepository(missingTargetDate),
        now,
      );
      expect(legacyResolved).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("equity close forecasts count provider-observed sessions under v3", async () => {
      const result = await resolveWith({ ...basePrediction, scoringPolicyVersion: 3 }, [
        { subject: "SPY", date: "2026-05-01", value: 500 },
        { subject: "SPY", date: "2026-05-02", value: 502 },
        { subject: "SPY", date: "2026-05-03", value: 504 },
        { subject: "SPY", date: "2026-05-04", value: 506 },
        { subject: "SPY", date: "2026-05-05", value: 508 },
        { subject: "SPY", date: "2026-05-08", value: 510 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("iv point observations target trading days under v2 and calendar days under v3", async () => {
      const requestedDates: string[] = [];
      const recordingRepo: ObservationRepository = {
        async point(request, _assetClass, date) {
          const ymd = date.toISOString().slice(0, 10);
          requestedDates.push(ymd);
          return { subject: request.observationSubject, date: ymd, value: 25 };
        },
        async window() {
          throw new Error("unexpected window observation request");
        },
      };
      const ivPrediction: Prediction = {
        ...basePrediction,
        id: "pred-iv-clock",
        kind: "iv",
        subject: "SPY",
        measurableAs: "iv(SPY, +5) > 20",
        claim: "SPY implied volatility is above 20 in 5 trading days.",
      };

      // GeneratedAt 2026-05-01 is a Friday: +5 trading days lands on 05-08,
      // While +5 UTC calendar days lands on 05-06.
      await resolveOutcome(ivPrediction, report, recordingRepo, now);
      expect(requestedDates).toEqual(["2026-05-08"]);

      requestedDates.length = 0;
      await resolveOutcome(
        { ...ivPrediction, scoringPolicyVersion: 3 },
        report,
        recordingRepo,
        now,
      );
      expect(requestedDates).toEqual(["2026-05-06"]);
    });

    test("v3 point targets falling on non-publication days resolve on the next published value", async () => {
      const requestedDates: string[] = [];
      const weekdayOnlyRepo: ObservationRepository = {
        async point(request, _assetClass, date) {
          const ymd = date.toISOString().slice(0, 10);
          requestedDates.push(ymd);
          const weekday = date.getUTCDay();
          if (weekday === 0 || weekday === 6) {
            return;
          }
          return { subject: request.observationSubject, date: ymd, value: 4.2 };
        },
        async window() {
          throw new Error("unexpected window observation request");
        },
      };
      const macroPrediction: Prediction = {
        ...basePrediction,
        id: "pred-macro-weekend",
        kind: "macro",
        subject: "DGS10",
        horizonTradingDays: 8,
        measurableAs: "fred(DGS10, +8) > fred(DGS10, 0)",
        claim: "DGS10 rises over 8 trading days.",
        scoringPolicyVersion: 3,
      };

      // GeneratedAt 2026-05-01 + 8 UTC calendar days = 2026-05-09, a Saturday
      // With no published observation. The resolver searches forward to the
      // First published value on Monday 2026-05-11.
      const result = await resolveOutcome(macroPrediction, report, weekdayOnlyRepo, now);
      expect(requestedDates).toEqual(["2026-05-01", "2026-05-09", "2026-05-10", "2026-05-11"]);
      expect(result).toMatchObject({
        status: "resolved",
        evidence: { date0: "2026-05-01", dateN: "2026-05-11" },
      });
    });

    test("v3 point origins search backward and never read post-forecast publications", async () => {
      const requestedDates: string[] = [];
      const weekdayOnlyRepo: ObservationRepository = {
        async point(request, _assetClass, date) {
          const ymd = date.toISOString().slice(0, 10);
          requestedDates.push(ymd);
          const weekday = date.getUTCDay();
          if (weekday === 0 || weekday === 6) {
            return;
          }
          return { subject: request.observationSubject, date: ymd, value: 4.2 };
        },
        async window() {
          throw new Error("unexpected window observation request");
        },
      };
      const weekendReport = researchReport({ generatedAt: "2026-05-02T00:00:00.000Z" });
      const macroPrediction: Prediction = {
        ...basePrediction,
        id: "pred-macro-weekend-origin",
        kind: "macro",
        subject: "DGS10",
        horizonTradingDays: 7,
        measurableAs: "fred(DGS10, +7) > fred(DGS10, 0)",
        claim: "DGS10 rises over 7 trading days.",
        scoringPolicyVersion: 3,
      };

      // GeneratedAt 2026-05-02 is a Saturday with no publication. The origin
      // Baseline walks backward to Friday 2026-05-01 — the last value the
      // Forecast could have seen — while the horizon target (05-09, also a
      // Saturday) still walks forward to Monday 2026-05-11.
      const result = await resolveOutcome(macroPrediction, weekendReport, weekdayOnlyRepo, now);
      expect(requestedDates).toEqual([
        "2026-05-02",
        "2026-05-01",
        "2026-05-09",
        "2026-05-10",
        "2026-05-11",
      ]);
      expect(result).toMatchObject({
        status: "resolved",
        evidence: { date0: "2026-05-01", dateN: "2026-05-11" },
      });
    });

    test("crypto volatility forecasts keep the full origin-through-target window under v3", async () => {
      const cryptoReport = researchReport({
        assetClass: "crypto",
        generatedAt: "2026-05-01T00:00:00.000Z",
      });
      const volatilityPrediction: Prediction = {
        ...basePrediction,
        id: "pred-btc-vol",
        kind: "volatility",
        subject: "BTC",
        measurableAs: "max(close(BTC), 0..+3) > 105000",
        claim: "BTC trades above 105000 within 3 trading days.",
        horizonTradingDays: 3,
        scoringPolicyVersion: 3,
      };
      // Threshold breached on an intermediate day (05-02), not on the target
      // UTC date (05-04); the 05-05 close sits outside the horizon window.
      const closes = [
        { subject: "BTC", date: "2026-05-01", value: 100_000 },
        { subject: "BTC", date: "2026-05-02", value: 106_000 },
        { subject: "BTC", date: "2026-05-03", value: 101_000 },
        { subject: "BTC", date: "2026-05-04", value: 103_000 },
        { subject: "BTC", date: "2026-05-05", value: 200_000 },
      ];

      const intermediateBreach = await resolveOutcome(
        volatilityPrediction,
        cryptoReport,
        observationRepository(closes),
        now,
      );
      expect(intermediateBreach).toMatchObject({
        status: "resolved",
        outcome: "hit",
        evidence: { maxClose: 106_000 },
      });

      // A breach after the target date must not count toward the outcome.
      const postTargetBreachOnly = await resolveOutcome(
        {
          ...volatilityPrediction,
          measurableAs: "max(close(BTC), 0..+3) > 150000",
          claim: "BTC trades above 150000 within 3 trading days.",
        },
        cryptoReport,
        observationRepository(closes),
        now,
      );
      expect(postTargetBreachOnly).toMatchObject({
        status: "resolved",
        outcome: "miss",
        evidence: { maxClose: 106_000 },
      });
    });

    test("crypto v3 close resolution waits until the target UTC date has fully elapsed", async () => {
      const cryptoReport = researchReport({
        assetClass: "crypto",
        generatedAt: "2026-05-01T00:00:00.000Z",
      });
      const btcPrediction: Prediction = {
        ...basePrediction,
        id: "pred-btc-gate",
        kind: "direction",
        subject: "BTC",
        measurableAs: "close(BTC, +3) > close(BTC, 0)",
        claim: "BTC closes higher over 3 trading days.",
        horizonTradingDays: 3,
        scoringPolicyVersion: 3,
      };
      const throwingRepo: ObservationRepository = {
        point: async () => {
          throw new Error("unexpected point observation request");
        },
        window: async () => {
          throw new Error("unexpected window observation request");
        },
      };

      // Intraday on the target UTC date (2026-05-04): the daily close is not
      // Final yet, so no observation may be fetched or graded.
      const pending = await resolveOutcome(
        btcPrediction,
        cryptoReport,
        throwingRepo,
        new Date("2026-05-04T12:00:00.000Z"),
      );
      expect(pending).toMatchObject({ status: "unresolved", reason: "horizon-not-elapsed" });

      const resolved = await resolveOutcome(
        btcPrediction,
        cryptoReport,
        observationRepository([
          { subject: "BTC", date: "2026-05-01", value: 100_000 },
          { subject: "BTC", date: "2026-05-04", value: 103_000 },
        ]),
        new Date("2026-05-05T00:00:00.000Z"),
      );
      expect(resolved).toMatchObject({ status: "resolved", outcome: "hit" });
    });
  });

  describe("conditional", () => {
    const conditionalPrediction: Prediction = {
      ...basePrediction,
      id: "pred-conditional",
      kind: "conditional",
      subject: "QQQ",
      horizonTradingDays: 10,
      measurableAs: "if (close(SPY, +5) > close(SPY, 0)) then (close(QQQ, +10) > close(QQQ, 0))",
      probability: 0.62,
    };

    test("returns pending-condition before the antecedent horizon elapses", async () => {
      const result = await resolveOutcome(
        conditionalPrediction,
        report,
        observationRepository([]),
        new Date("2026-05-05T00:00:00.000Z"),
      );

      expect(result).toMatchObject({
        status: "unresolved",
        scoreStatus: "pending-condition",
        reason: "horizon-not-elapsed",
      });
    });

    test("voids when the antecedent resolves false", async () => {
      const result = await resolveWith(conditionalPrediction, [
        ...closeWindow("SPY", [500, 498, 497, 496, 495, 494]),
      ]);

      expect(result).toMatchObject({
        status: "voided",
        evidence: { reason: "conditional antecedent did not occur" },
      });
    });

    test("returns active-pending when the antecedent is true and consequent is not due", async () => {
      const result = await resolveOutcome(
        conditionalPrediction,
        report,
        observationRepository([...closeWindow("SPY", [500, 501, 502, 503, 504, 505])]),
        new Date("2026-05-11T00:00:00.000Z"),
      );

      expect(result).toMatchObject({
        status: "unresolved",
        scoreStatus: "active-pending",
        reason: "horizon-not-elapsed",
      });
    });

    test("stays active-pending when the consequent observation is unavailable", async () => {
      const result = await resolveWith(conditionalPrediction, [
        ...closeWindow("SPY", [500, 501, 502, 503, 504, 505]),
      ]);

      expect(result).toMatchObject({
        status: "unresolved",
        scoreStatus: "active-pending",
        reason: "observation-unavailable",
        evidence: { reason: "conditional consequent observation unavailable" },
      });
    });

    test("resolves the consequent after the condition activates", async () => {
      const result = await resolveWith(conditionalPrediction, [
        ...closeWindow("SPY", [500, 501, 502, 503, 504, 505]),
        ...closeWindow("QQQ", [400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410]),
      ]);

      expect(result).toMatchObject({
        status: "resolved",
        outcome: "hit",
        evidence: {
          antecedent: { close0: 500, closeN: 505 },
          consequent: { close0: 400, closeN: 410 },
        },
      });
    });
  });
});

describe("resolveOutcome trading-day calendar", () => {
  // 2026-07-03 is the observed Independence Day closure (Jul 4 is a Saturday).
  // From Wed 2026-07-01 two trading days land on Mon 2026-07-06, not Fri 2026-07-03.
  const holidayReport = researchReport({ generatedAt: "2026-07-01T00:00:00.000Z" });

  const macroAcrossHoliday: Prediction = {
    ...basePrediction,
    id: "pred-macro-holiday",
    kind: "macro",
    subject: "DGS10",
    measurableAs: "fred(DGS10, +2) > fred(DGS10, 0)",
    horizonTradingDays: 2,
    claim: "DGS10 rises over 2 trading days.",
  };

  test("targets point forecasts at the holiday-adjusted session, not the closed market", async () => {
    const result = await resolveOutcome(
      macroAcrossHoliday,
      holidayReport,
      observationRepository([
        { subject: "FRED:DGS10", date: "2026-07-01", value: 4.1 },
        // No data on 2026-07-03 (market closed); the horizon must land on 2026-07-06.
        { subject: "FRED:DGS10", date: "2026-07-06", value: 4.3 },
      ]),
      new Date("2026-07-20T00:00:00.000Z"),
    );

    expect(result.status).toBe("resolved");
    expect(result).toMatchObject({
      outcome: "hit",
      evidence: { date0: "2026-07-01", dateN: "2026-07-06" },
    });
  });

  test("does not attempt close-window resolution before the Nth real session", async () => {
    const throwingRepo: ObservationRepository = {
      point: async () => {
        throw new Error("unexpected point observation request");
      },
      window: async () => {
        throw new Error("unexpected window observation request");
      },
    };

    // The supplied `now` sits after the weekday-derived date (Fri 2026-07-03) but before the
    // Monday 2026-07-06 session, so resolution must defer rather than fire early.
    const result = await resolveOutcome(
      { ...basePrediction, horizonTradingDays: 2, measurableAs: "close(SPY, +2) > close(SPY, 0)" },
      holidayReport,
      throwingRepo,
      new Date("2026-07-04T00:00:00.000Z"),
    );

    expect(result).toMatchObject({
      status: "unresolved",
      reason: "horizon-not-elapsed",
    });
  });
});

const makeScore = predictionScore;

describe("buildCalibrationSummary", () => {
  test("computes Brier score for a perfectly calibrated set", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 0 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.brierScore).toBe(0);
  });

  test("computes Brier score for worst-case predictions", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 0 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.brierScore).toBe(1);
  });

  test("returns zero for empty input", () => {
    const summary = buildCalibrationSummary([], new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.resolvedCount).toBe(0);
    expect(summary.brierScore).toBe(0);
    expect(summary.bins).toHaveLength(0);
  });

  test("reports Brier skill relative to the always-0.5 baseline", () => {
    const at = new Date("2026-05-19T00:00:00.000Z");
    const perfect = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, probability: 1 },
          score: makeScore("hit"),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r1",
        },
      ],
      at,
    );
    // Brier 0 => skill 1 (perfect).
    expect(perfect.brierScore).toBe(0);
    expect(perfect.brierSkillScore).toBe(1);

    const baseline = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, probability: 0.5 },
          score: makeScore("hit"),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r1",
        },
        {
          prediction: { ...basePrediction, probability: 0.5 },
          score: makeScore("miss"),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r2",
        },
      ],
      at,
    );
    // Always-0.5 => Brier 0.25 => skill 0 (no edge).
    expect(baseline.brierScore).toBe(0.25);
    expect(baseline.brierSkillScore).toBe(0);

    const worst = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, probability: 1 },
          score: makeScore("miss"),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r1",
        },
      ],
      at,
    );
    // Brier 1 => skill -3 (worst-case binary score).
    expect(worst.brierScore).toBe(1);
    expect(worst.brierSkillScore).toBe(-3);
  });

  test("groups results by kind and assetClass", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, kind: "direction" as const, probability: 0.7 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, kind: "volatility" as const, probability: 0.4 },
        score: makeScore("miss"),
        assetClass: "crypto" as const,
        jobType: "crypto" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    expect(summary.byKind["direction"]).toBeDefined();
    expect(summary.byKind["volatility"]).toBeDefined();
    expect(summary.byAssetClass["equity"]).toBeDefined();
    expect(summary.byAssetClass["crypto"]).toBeDefined();
  });

  test("reports run-clustered Brier standard error with unequal cluster sizes", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 0 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];

    const metric = buildCalibrationSummary(pairs).byAssetClass.equity;

    expect(metric?.brierScore).toBeCloseTo(1 / 3);
    expect(metric?.runCount).toBe(2);
    expect(metric?.brierStandardError).toBeCloseTo(2 / 9);
  });

  test("omits clustered uncertainty when all predictions come from one run", () => {
    const pairs = Array.from({ length: 3 }, (_, index) => ({
      prediction: { ...basePrediction, id: `p-${String(index)}` },
      score: makeScore(index === 0 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: "r1",
    }));

    expect(buildCalibrationSummary(pairs).byAssetClass.equity).toMatchObject({
      count: 3,
      runCount: 1,
    });
    expect(buildCalibrationSummary(pairs).byAssetClass.equity?.brierStandardError).toBeUndefined();
  });

  test("includes activated conditional predictions and reports voided exclusions", () => {
    const pairs = [
      {
        prediction: {
          ...basePrediction,
          kind: "conditional" as const,
          probability: 0.7,
        },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
    ];

    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"), {
      activatedCount: 0,
      voidedCount: 1,
    });

    expect(summary.resolvedCount).toBe(1);
    expect(summary.byKind.conditional?.count).toBe(1);
    expect(summary.byKind.conditional?.brierScore).toBeCloseTo(0.09);
    expect(summary.conditionalPredictions).toEqual({ activatedCount: 1, voidedCount: 1 });
  });

  test("groups calibration by job type, market cadence, and horizon bucket", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, horizonTradingDays: 5 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        marketUpdateHorizonBucket: "1-5d",
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, horizonTradingDays: 15 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "weekly" as const,
        marketUpdateHorizonBucket: "11-15d",
        runId: "r2",
      },
      {
        prediction: { ...basePrediction, horizonTradingDays: 20 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "equity" as const,
        runId: "r3",
      },
    ];

    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));

    expect(summary.byJobType["daily"]?.count).toBe(1);
    expect(summary.byJobType["weekly"]?.count).toBe(1);
    expect(summary.byJobType["equity"]?.count).toBe(1);
    expect(summary.byMarketUpdateHorizonBucket["1-5d"]?.count).toBe(1);
    expect(summary.byMarketUpdateHorizonBucket["11-15d"]?.count).toBe(1);
    expect(summary.byHorizonBucket["1-5d"]?.count).toBe(1);
    expect(summary.byHorizonBucket["11-15d"]?.count).toBe(1);
    expect(summary.byHorizonBucket["16-20d"]?.count).toBe(1);
  });

  test("aggregates material forecast-error autopsy causes", () => {
    const summary = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, id: "p-1", probability: 0.8 },
          score: makeScore("miss", { predictionId: "p-1" }),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r1",
          missAutopsy: {
            predictionId: "p-1",
            runId: "r1",
            observedAt: "2026-05-20T00:00:00.000Z",
            scoreOutcome: "miss",
            probability: 0.8,
            forecastError: "overpredicted",
            cause: "source_gap",
            rationale: "Source gap.",
            supportingSignals: ["source gap"],
            evidence: { close0: 100, closeN: 90 },
          },
        },
        {
          prediction: { ...basePrediction, id: "p-2", probability: 0.2 },
          score: makeScore("hit", { predictionId: "p-2" }),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r2",
          missAutopsy: {
            predictionId: "p-2",
            runId: "r2",
            observedAt: "2026-05-20T00:00:00.000Z",
            scoreOutcome: "hit",
            probability: 0.2,
            forecastError: "underpredicted",
            cause: "model_overconfidence",
            rationale: "Extreme probability.",
            supportingSignals: ["extreme probability"],
            evidence: { close0: 100, closeN: 110 },
          },
        },
      ],
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(summary.missAutopsyCount).toBe(2);
    expect(summary.byMissAutopsyCause).toEqual({ model_overconfidence: 1, source_gap: 1 });

    const markdown = renderCalibrationMarkdown(summary);
    expect(markdown).toContain("## Forecast error taxonomy");
    expect(markdown).toContain("| source_gap | 1 |");
  });

  test("renders empty market cadence section when only ticker predictions resolved", () => {
    const summary = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, horizonTradingDays: 5 },
          score: makeScore("hit"),
          assetClass: "equity" as const,
          jobType: "equity" as const,
          runId: "r1",
        },
      ],
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(renderCalibrationMarkdown(summary)).toContain(
      "_No resolved market-update predictions yet._",
    );
  });

  test("renders Brier skill versus the baseline in the markdown summary", () => {
    const summary = buildCalibrationSummary(
      [
        {
          prediction: { ...basePrediction, probability: 1 },
          score: makeScore("hit"),
          assetClass: "equity" as const,
          jobType: "daily" as const,
          runId: "r1",
        },
      ],
      new Date("2026-05-19T00:00:00.000Z"),
    );

    const markdown = renderCalibrationMarkdown(summary);

    expect(markdown).toContain("Brier skill");
    expect(markdown).toContain("+1.0000");
  });

  test("includes probability=1 in the top bin", () => {
    const pairs = [
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r1",
      },
      {
        prediction: { ...basePrediction, probability: 1 },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: "r2",
      },
    ];
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    const topBin = summary.bins.find((bn) => bn.pHigh === 1);
    expect(topBin?.totalCount).toBe(2);
    expect(topBin?.hitCount).toBe(1);
  });

  test("builds reliability bins", () => {
    const pairs = Array.from({ length: 10 }, (_, idx) => ({
      prediction: { ...basePrediction, probability: 0.65 },
      score: makeScore(idx < 7 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: `r${String(idx)}`,
    }));
    const summary = buildCalibrationSummary(pairs, new Date("2026-05-19T00:00:00.000Z"));
    const bin = summary.bins.find((b) => b.pLow === 0.6);
    expect(bin).toBeDefined();
    expect(bin?.hitRate).toBeCloseTo(0.7, 2);
  });
});

describe("forecastErrorDirection", () => {
  test("flags a miss at exactly the 0.6 overprediction threshold", () => {
    const pred = prediction({ probability: 0.6 });
    expect(forecastErrorDirection(pred, predictionScore("miss"))).toBe("overpredicted");
  });

  test("does not flag a miss just below the 0.6 threshold", () => {
    const pred = prediction({ probability: 0.59 });
    expect(forecastErrorDirection(pred, predictionScore("miss"))).toBeUndefined();
  });

  test("flags a hit at exactly the 0.4 underprediction threshold", () => {
    const pred = prediction({ probability: 0.4 });
    expect(forecastErrorDirection(pred, predictionScore("hit"))).toBe("underpredicted");
  });

  test("does not flag a hit just above the 0.4 threshold", () => {
    const pred = prediction({ probability: 0.41 });
    expect(forecastErrorDirection(pred, predictionScore("hit"))).toBeUndefined();
  });

  test("returns undefined for an unresolved score", () => {
    const pred = prediction({ probability: 0.9 });
    expect(
      forecastErrorDirection(
        pred,
        predictionScore("miss", { resolved: false, outcome: undefined }),
      ),
    ).toBeUndefined();
  });
});

describe("buildCalibrationSummary — market regime slice", () => {
  const at = new Date("2026-05-19T00:00:00.000Z");

  function regimePairs(label: MarketRegimeLabel | undefined, count: number, idPrefix: string) {
    return Array.from({ length: count }, (_, idx) => ({
      prediction: { ...basePrediction, id: `${idPrefix}${String(idx)}`, probability: 0.7 },
      score: makeScore(idx % 2 === 0 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: `${idPrefix}r${String(idx)}`,
      ...(label !== undefined ? { marketRegimeLabel: label } : {}),
    }));
  }

  test("reports Brier + count per regime that meets the sample floor", () => {
    const summary = buildCalibrationSummary(
      regimePairs("risk-on", MIN_CALIBRATION_SAMPLE, "on-"),
      at,
    );
    expect(summary.byMarketRegime["risk-on"]?.count).toBe(MIN_CALIBRATION_SAMPLE);
    expect(summary.byMarketRegime["risk-on"]?.brierScore).toBeGreaterThanOrEqual(0);
    expect(summary.marketRegimeCoverage["risk-on"]).toBe(MIN_CALIBRATION_SAMPLE);
  });

  test("withholds Brier for a regime below the floor but still counts it", () => {
    const summary = buildCalibrationSummary(
      regimePairs("risk-off", MIN_CALIBRATION_SAMPLE - 1, "off-"),
      at,
    );
    expect(summary.byMarketRegime["risk-off"]).toBeUndefined();
    expect(summary.marketRegimeCoverage["risk-off"]).toBe(MIN_CALIBRATION_SAMPLE - 1);
  });

  test("treats insufficient-data as a first-class reported regime bin", () => {
    const summary = buildCalibrationSummary(
      regimePairs("insufficient-data", MIN_CALIBRATION_SAMPLE, "id-"),
      at,
    );
    expect(summary.byMarketRegime["insufficient-data"]?.count).toBe(MIN_CALIBRATION_SAMPLE);
  });

  test("excludes absent regime from the slice but counts it as unknown", () => {
    const summary = buildCalibrationSummary(
      [
        ...regimePairs("risk-on", MIN_CALIBRATION_SAMPLE, "on-"),
        ...regimePairs(undefined, 3, "none-"),
      ],
      at,
    );
    expect(summary.byMarketRegime["unknown"]).toBeUndefined();
    expect(summary.marketRegimeCoverage["unknown"]).toBe(3);
    expect(summary.byMarketRegime["risk-on"]?.count).toBe(MIN_CALIBRATION_SAMPLE);
  });

  test("markdown renders the regime table and discloses excluded buckets", () => {
    const summary = buildCalibrationSummary(
      [
        ...regimePairs("risk-on", MIN_CALIBRATION_SAMPLE, "on-"),
        ...regimePairs("risk-off", MIN_CALIBRATION_SAMPLE - 1, "off-"),
        ...regimePairs(undefined, 2, "none-"),
      ],
      at,
    );
    const output = renderCalibrationMarkdown(summary);
    expect(output).toContain("## By market regime");
    expect(output).toContain("| risk-on |");
    expect(output).toContain("Excluded from the regime slice:");
    expect(output).toContain(
      `risk-off (${String(MIN_CALIBRATION_SAMPLE - 1)}, below sample floor)`,
    );
    expect(output).toContain("unknown (2, no regime label)");
  });
});

describe("renderCalibrationConsole", () => {
  const at = new Date("2026-05-19T00:00:00.000Z");

  function makePairs(count: number) {
    return Array.from({ length: count }, (_, idx) => ({
      prediction: {
        ...basePrediction,
        id: `p${String(idx)}`,
        probability: 0.7,
        horizonTradingDays: 5,
      },
      score: makeScore(idx % 2 === 0 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      marketUpdateHorizonBucket: "1-5d",
      runId: `r${String(idx)}`,
    }));
  }

  test("shows small-sample warning below minimum threshold", () => {
    const summary = buildCalibrationSummary(makePairs(MIN_CALIBRATION_SAMPLE - 1), at);
    const output = renderCalibrationConsole(summary);
    expect(output).toContain("Small sample");
    expect(output).toContain(String(MIN_CALIBRATION_SAMPLE - 1));
    expect(output).not.toContain("Reliability");
    expect(output).not.toContain("By kind");
    expect(output).not.toContain("By horizon");
  });

  test("shows full dashboard at or above minimum threshold", () => {
    const summary = buildCalibrationSummary(makePairs(MIN_CALIBRATION_SAMPLE), at);
    const output = renderCalibrationConsole(summary);
    expect(output).not.toContain("Small sample");
    expect(output).toContain("Reliability");
    expect(output).toContain("By kind");
    expect(output).toContain("By horizon");
  });

  test("renders overall Brier score and skill", () => {
    const summary = buildCalibrationSummary(makePairs(MIN_CALIBRATION_SAMPLE), at);
    const output = renderCalibrationConsole(summary);
    expect(output).toContain("Brier score:");
    expect(output).toContain("Brier skill:");
    expect(output).toContain("Resolved:");
  });

  test("labels displayed sub-floor slices as thin and unreliable", () => {
    const pairs = makePairs(MIN_CALIBRATION_SAMPLE).map((pair, index) => ({
      ...pair,
      prediction: {
        ...pair.prediction,
        kind: index === 0 ? ("relative" as const) : ("direction" as const),
      },
    }));

    expect(renderCalibrationConsole(buildCalibrationSummary(pairs, at))).toContain(
      "n=4 [thin/unreliable]",
    );
    expect(renderCalibrationMarkdown(buildCalibrationSummary(pairs, at))).toContain(
      "4 (thin/unreliable)",
    );
  });

  test("renders small-sample warning in markdown below minimum threshold", () => {
    const summary = buildCalibrationSummary(makePairs(MIN_CALIBRATION_SAMPLE - 1), at);
    const output = renderCalibrationMarkdown(summary);
    expect(output).toContain("Small sample");
    expect(output).toContain(
      `${String(MIN_CALIBRATION_SAMPLE - 1)} of ${String(MIN_CALIBRATION_SAMPLE)} minimum`,
    );
    expect(output).toContain("## Reliability bins");
  });

  test("renders reliability bins with hit rates", () => {
    const pairs = Array.from({ length: 10 }, (_, idx) => ({
      prediction: {
        ...basePrediction,
        id: `p${String(idx)}`,
        probability: 0.65,
        horizonTradingDays: 5,
      },
      score: makeScore(idx < 7 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: `r${String(idx)}`,
    }));
    const summary = buildCalibrationSummary(pairs, at);
    const output = renderCalibrationConsole(summary);
    expect(output).toContain("0.6-0.7");
    expect(output).toContain("n=  10");
  });

  test("renders a By market regime section when a regime meets the floor", () => {
    const pairs = Array.from({ length: MIN_CALIBRATION_SAMPLE }, (_, idx) => ({
      prediction: { ...basePrediction, id: `p${String(idx)}`, probability: 0.7 },
      score: makeScore(idx % 2 === 0 ? "hit" : "miss"),
      assetClass: "equity" as const,
      jobType: "daily" as const,
      runId: `r${String(idx)}`,
      marketRegimeLabel: "risk-on" as const,
    }));
    const output = renderCalibrationConsole(buildCalibrationSummary(pairs, at));
    expect(output).toContain("By market regime");
    expect(output).toContain("risk-on");
  });

  test("renders per-kind and per-horizon skill scores with correct values", () => {
    // Direction hits at probability=1 → Brier=0 → skill=+1.00
    // Volatility misses at probability=0 → Brier=0 → skill=+1.00
    const pairs = [
      ...Array.from({ length: 3 }, (_, i) => ({
        prediction: {
          ...basePrediction,
          id: `dir-${String(i)}`,
          kind: "direction" as const,
          probability: 1,
          horizonTradingDays: 5,
        },
        score: makeScore("hit"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: `r${String(i)}`,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        prediction: {
          ...basePrediction,
          id: `vol-${String(i)}`,
          kind: "volatility" as const,
          probability: 0,
          horizonTradingDays: 12,
        },
        score: makeScore("miss"),
        assetClass: "equity" as const,
        jobType: "daily" as const,
        runId: `rv${String(i)}`,
      })),
    ];
    const summary = buildCalibrationSummary(pairs, at);
    const output = renderCalibrationConsole(summary);
    expect(output).toContain("direction");
    expect(output).toContain("volatility");
    expect(output).toContain("1-5d");
    expect(output).toContain("11-15d");
    // Both groups: Brier=0 → skill=+1.00
    const kindSection = output.slice(output.indexOf("By kind"));
    expect(kindSection).toContain("+1.00");
    const horizonSection = output.slice(output.indexOf("By horizon"));
    expect(horizonSection).toContain("+1.00");
  });
});
