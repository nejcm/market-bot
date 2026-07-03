import { describe, expect, test } from "bun:test";
import {
  observationStrategyForForecast,
  parseObservableExpression,
  renderClaim,
  resolveObservableForecast,
  type ObservableExpression,
  type ObservableForecast,
} from "../src/forecast/observable";
import { resolveOutcome, type Observation } from "../src/scoring/resolver";
import type { Prediction, ResearchReport } from "../src/domain/types";
import type { ObservationRepository } from "../src/scoring/observations";
import { validateResearchReport } from "../src/report/schema";
import { renderMarkdownReport } from "../src/report/markdown";
import { violatesResearchOnly } from "../src/domain/research-language";
import {
  parseNearEarningsEvent,
  computeImpliedMove,
  type EarningsEvent,
} from "../src/sources/extended-evidence/earnings-setup";
import type { CollectContext } from "../src/sources/types";
import { prediction, researchReport } from "./support/fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function forecastFor(expression: ObservableExpression): ObservableForecast {
  return {
    prediction: {
      id: "p1",
      claim: "test claim",
      kind: expression.kind,
      subject: "test",
      measurableAs: "test",
      horizonTradingDays: expression.horizonTradingDays,
      probability: 0.5,
      sourceIds: [],
    },
    expression,
    instruments: [],
    measurableAs: "test",
    subject: "test",
    horizonTradingDays: expression.horizonTradingDays,
  };
}

function earningsReport(
  timing: "bmo" | "amc" | "unknown",
  eventDate = "2026-05-15",
): ResearchReport {
  return researchReport({
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    generatedAt: "2026-05-14T00:00:00.000Z",
    sources: [
      {
        id: "src-1",
        title: "AAPL data",
        fetchedAt: "2026-05-14T00:00:00.000Z",
        kind: "market-data",
        assetClass: "equity",
        symbol: "AAPL",
      },
    ],
    keyFindings: [{ text: "Earnings expected.", sourceIds: ["src-1"] }],
    extras: {
      earningsSetup: {
        event: {
          symbol: "AAPL",
          date: eventDate,
          timing,
          sourceIds: ["src-1"],
          fetchedAt: "2026-05-14T00:00:00.000Z",
        },
        gaps: [],
      },
    },
  });
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
    async window(subject, _assetClass, from, _to) {
      return observations
        .filter(
          (observation) =>
            observation.subject === subject && observation.date >= from.toISOString().slice(0, 10),
        )
        .toSorted((left, right) => left.date.localeCompare(right.date));
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Parser/render tests for both new DSL forms
// ---------------------------------------------------------------------------

describe("parseObservableExpression — earnings", () => {
  describe("earnings-direction", () => {
    test("parses standard earningsReturn direction form", () => {
      expect(parseObservableExpression("earningsReturn(AAPL, 2026-07-24, +1) > 0")).toEqual({
        kind: "earnings-direction",
        subject: "AAPL",
        eventDate: "2026-07-24",
        horizonTradingDays: 1,
      });
    });

    test("parses with multi-day horizon", () => {
      expect(parseObservableExpression("earningsReturn(MSFT, 2026-10-20, +5) > 0")).toEqual({
        kind: "earnings-direction",
        subject: "MSFT",
        eventDate: "2026-10-20",
        horizonTradingDays: 5,
      });
    });

    test("parses without spaces", () => {
      expect(parseObservableExpression("earningsReturn(AAPL,2026-07-24,+1) > 0")).toEqual({
        kind: "earnings-direction",
        subject: "AAPL",
        eventDate: "2026-07-24",
        horizonTradingDays: 1,
      });
    });
  });

  describe("earnings-move", () => {
    test("parses standard abs earningsReturn move form", () => {
      expect(
        parseObservableExpression("abs(earningsReturn(AAPL, 2026-07-24, +1)) > 0.045"),
      ).toEqual({
        kind: "earnings-move",
        subject: "AAPL",
        eventDate: "2026-07-24",
        horizonTradingDays: 1,
        threshold: 0.045,
      });
    });

    test("parses integer threshold", () => {
      expect(parseObservableExpression("abs(earningsReturn(NVDA, 2026-08-20, +3)) > 0.1")).toEqual({
        kind: "earnings-move",
        subject: "NVDA",
        eventDate: "2026-08-20",
        horizonTradingDays: 3,
        threshold: 0.1,
      });
    });

    test("parses without spaces", () => {
      expect(parseObservableExpression("abs(earningsReturn(AAPL,2026-07-24,+1)) > 0.045")).toEqual({
        kind: "earnings-move",
        subject: "AAPL",
        eventDate: "2026-07-24",
        horizonTradingDays: 1,
        threshold: 0.045,
      });
    });
  });
});

describe("renderClaim — earnings", () => {
  test("renders earnings-direction claim", () => {
    const expression: ObservableExpression = {
      kind: "earnings-direction",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
    };
    expect(renderClaim(expression)).toBe(
      "AAPL closes higher than its pre-earnings close 1 trading days after the 2026-07-24 earnings event",
    );
  });

  test("renders earnings-move claim with percentage", () => {
    const expression: ObservableExpression = {
      kind: "earnings-move",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
      threshold: 0.045,
    };
    expect(renderClaim(expression)).toBe(
      "AAPL moves more than 4.5% from its pre-earnings close 1 trading days after the 2026-07-24 earnings event",
    );
  });
});

describe("observationStrategyForForecast — earnings", () => {
  test("maps earnings-direction to earnings-close-window strategy", () => {
    const expression: ObservableExpression = {
      kind: "earnings-direction",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
    };
    expect(observationStrategyForForecast(forecastFor(expression))).toEqual({
      mode: "earnings-close-window",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
    });
  });

  test("maps earnings-move to earnings-close-window strategy", () => {
    const expression: ObservableExpression = {
      kind: "earnings-move",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
      threshold: 0.045,
    };
    expect(observationStrategyForForecast(forecastFor(expression))).toEqual({
      mode: "earnings-close-window",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
    });
  });
});

describe("resolveObservableForecast — earnings", () => {
  describe("earnings-direction", () => {
    const expression: ObservableExpression = {
      kind: "earnings-direction",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
    };

    test("resolves hit when closeN > close0", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 200 },
        { subject: "AAPL", date: "2026-07-24", value: 210 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("resolves miss when closeN <= close0", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 210 },
        { subject: "AAPL", date: "2026-07-24", value: 205 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });

    test("returns unresolved with missing observations", () => {
      const result = resolveObservableForecast(forecastFor(expression), []);
      expect(result.status).toBe("unresolved");
    });
  });

  describe("earnings-move", () => {
    const expression: ObservableExpression = {
      kind: "earnings-move",
      subject: "AAPL",
      eventDate: "2026-07-24",
      horizonTradingDays: 1,
      threshold: 0.05,
    };

    test("resolves hit when absolute return exceeds threshold", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 200 },
        { subject: "AAPL", date: "2026-07-24", value: 215 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("resolves hit on negative return exceeding threshold", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 200 },
        { subject: "AAPL", date: "2026-07-24", value: 185 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("resolves miss when absolute return is below threshold", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 200 },
        { subject: "AAPL", date: "2026-07-24", value: 205 },
      ]);
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });

    test("returns unresolved when close0 is zero", () => {
      const result = resolveObservableForecast(forecastFor(expression), [
        { subject: "AAPL", date: "2026-07-23", value: 0 },
        { subject: "AAPL", date: "2026-07-24", value: 10 },
      ]);
      expect(result.status).toBe("unresolved");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Resolver tests for BMO, AMC, unknown timing, missing closes
// ---------------------------------------------------------------------------

function earningsDirectionPrediction(eventDate: string): Prediction {
  return prediction({
    id: "pred-ed",
    kind: "earnings-direction",
    subject: "AAPL",
    measurableAs: `earningsReturn(AAPL, ${eventDate}, +1) > 0`,
    claim: "AAPL earnings direction",
    horizonTradingDays: 1,
  });
}

function earningsMovePrediction(eventDate: string, threshold = 0.05): Prediction {
  return prediction({
    id: "pred-em",
    kind: "earnings-move",
    subject: "AAPL",
    measurableAs: `abs(earningsReturn(AAPL, ${eventDate}, +1)) > ${String(threshold)}`,
    claim: "AAPL earnings move",
    horizonTradingDays: 1,
  });
}

describe("resolveOutcome — earnings scoring", () => {
  // May 15, 2026 is a Friday (trading day). May 14 = Thursday, May 16/17 are the
  // Weekend, May 18 = Monday — so +1 trading day after Friday skips the weekend.
  const earningsDate = "2026-05-15";
  // Extend "now" well past the event so horizon checks pass.
  const now = new Date("2026-06-01T00:00:00.000Z");

  describe("BMO timing", () => {
    // BMO on May 15 (Fri): origin = May 14 (Thu, prior trading day).
    // Horizon: advance 1 trading day from May 14 = May 15.
    // Required closes: N+1 = 2 (origin + horizon).
    const report = earningsReport("bmo", earningsDate);
    const pred = earningsDirectionPrediction(earningsDate);

    test("resolves hit with BMO timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 190 },
          { subject: "AAPL", date: "2026-05-15", value: 200 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("resolves miss with BMO timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 200 },
          { subject: "AAPL", date: "2026-05-15", value: 195 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });

    test("event-anchored sessions are identical for a policy-v3 stamped prediction", async () => {
      const result = await resolveOutcome(
        { ...pred, scoringPolicyVersion: 3 },
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 190 },
          { subject: "AAPL", date: "2026-05-15", value: 200 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("uses the last provider session before a v3 BMO event after an ad-hoc closure", async () => {
      const eventDate = "2025-01-10";
      const requestedFrom: string[] = [];
      const observations = [
        { subject: "AAPL", date: "2025-01-08", value: 200 },
        { subject: "AAPL", date: "2025-01-10", value: 180 },
        { subject: "AAPL", date: "2025-01-13", value: 190 },
      ];
      const repo: ObservationRepository = {
        async point() {
          throw new Error("unexpected point observation request");
        },
        async window(subject, _assetClass, from) {
          const fromYmd = from.toISOString().slice(0, 10);
          requestedFrom.push(fromYmd);
          return observations.filter(
            (observation) => observation.subject === subject && observation.date >= fromYmd,
          );
        },
      };

      const result = await resolveOutcome(
        { ...earningsDirectionPrediction(eventDate), scoringPolicyVersion: 3 },
        earningsReport("bmo", eventDate),
        repo,
        new Date("2025-01-20T00:00:00.000Z"),
      );

      expect(requestedFrom).toEqual(["2025-01-04"]);
      expect(result).toMatchObject({
        status: "resolved",
        outcome: "miss",
        evidence: { close0: 200, closeN: 180 },
      });
    });
  });

  describe("AMC timing", () => {
    // AMC on May 15 (Fri): origin = May 15 (event-date close).
    // Horizon: advance 1 trading day from May 15 = May 18 (Mon, skips weekend).
    // Required closes: N+1 = 2.
    const report = earningsReport("amc", earningsDate);
    const pred = earningsDirectionPrediction(earningsDate);

    test("resolves hit with AMC timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-15", value: 190 },
          { subject: "AAPL", date: "2026-05-18", value: 200 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("resolves miss with AMC timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-15", value: 200 },
          { subject: "AAPL", date: "2026-05-18", value: 190 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });

    test("keeps horizon unresolved over the weekend before the Monday session", async () => {
      // Now is Saturday May 16: the +1 trading-day horizon is Monday May 18,
      // Which has not elapsed. A naive calendar-day horizon would wrongly resolve.
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([{ subject: "AAPL", date: "2026-05-15", value: 190 }]),
        new Date("2026-05-16T00:00:00.000Z"),
      );
      expect(result).toMatchObject({ status: "unresolved", reason: "horizon-not-elapsed" });
    });
  });

  describe("unknown timing", () => {
    // Unknown on May 15 (Fri): origin = May 14 (Thu, prior trading day).
    // Horizon advances 1 trading day from May 15 to May 18 (Mon, skips weekend).
    // Required closes: N+2 = 3 (origin + event + 1 post-event).
    const report = earningsReport("unknown", earningsDate);
    const pred = earningsDirectionPrediction(earningsDate);

    test("resolves hit with unknown timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 190 },
          { subject: "AAPL", date: "2026-05-15", value: 195 },
          { subject: "AAPL", date: "2026-05-18", value: 200 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("returns unresolved with insufficient closes for unknown timing", async () => {
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 190 },
          { subject: "AAPL", date: "2026-05-15", value: 195 },
        ]),
        now,
      );
      expect(result).toMatchObject({
        status: "unresolved",
        reason: "observation-unavailable",
      });
    });
  });

  describe("earnings-move threshold", () => {
    const report = earningsReport("bmo", earningsDate);

    test("hit when return exceeds implied move threshold", async () => {
      const pred = earningsMovePrediction(earningsDate, 0.04);
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 200 },
          { subject: "AAPL", date: "2026-05-15", value: 212 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "hit" });
    });

    test("miss when return is below threshold", async () => {
      const pred = earningsMovePrediction(earningsDate, 0.04);
      const result = await resolveOutcome(
        pred,
        report,
        observationRepository([
          { subject: "AAPL", date: "2026-05-14", value: 200 },
          { subject: "AAPL", date: "2026-05-15", value: 205 },
        ]),
        now,
      );
      expect(result).toMatchObject({ status: "resolved", outcome: "miss" });
    });
  });

  describe("horizon not elapsed", () => {
    test("returns unresolved before earnings event horizon", async () => {
      const report = earningsReport("bmo", "2026-06-15");
      const pred = earningsDirectionPrediction("2026-06-15");
      const earlyNow = new Date("2026-06-10T00:00:00.000Z");

      const repo: ObservationRepository = {
        point: async () => {
          throw new Error("unexpected point observation request");
        },
        window: async () => {
          throw new Error("unexpected window observation request");
        },
      };

      const result = await resolveOutcome(pred, report, repo, earlyNow);
      expect(result).toMatchObject({
        status: "unresolved",
        reason: "horizon-not-elapsed",
      });
    });
  });

  describe("conditional with nested earnings expression", () => {
    test("keeps the earnings antecedent event-anchored inside a conditional", async () => {
      // AMC event Fri May 15; antecedent +1 trading day resolves Mon May 18.
      // Report generatedAt is May 14, so a report-anchored gate would elapse by
      // Sat May 16 (report-date +1 = May 15) and wrongly leave pending state.
      const report = earningsReport("amc", "2026-05-15");
      const pred = prediction({
        id: "pred-cond-earnings",
        kind: "conditional",
        subject: "AAPL",
        measurableAs:
          "if (earningsReturn(AAPL, 2026-05-15, +1) > 0) then (close(AAPL, +5) > close(AAPL, 0))",
        claim: "conditional earnings antecedent",
        horizonTradingDays: 5,
      });
      const saturday = new Date("2026-05-16T00:00:00.000Z");

      const repo: ObservationRepository = {
        point: async () => {
          throw new Error("unexpected point observation request");
        },
        window: async () => {
          throw new Error("unexpected window observation request");
        },
      };

      const result = await resolveOutcome(pred, report, repo, saturday);
      expect(result).toMatchObject({
        status: "unresolved",
        reason: "horizon-not-elapsed",
        scoreStatus: "pending-condition",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Report schema tests for extras.earningsSetup validation
// ---------------------------------------------------------------------------

describe("validateResearchReport — earningsSetup extras", () => {
  const baseReport: ResearchReport = researchReport({
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    sources: [
      {
        id: "src-1",
        title: "AAPL data",
        fetchedAt: "2026-05-14T00:00:00.000Z",
        kind: "market-data",
        assetClass: "equity",
        symbol: "AAPL",
      },
    ],
    keyFindings: [{ text: "Earnings data available.", sourceIds: ["src-1"] }],
  });

  test("validates report with valid earningsSetup event source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).not.toThrow();
  });

  test("rejects earningsSetup event with unknown source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["unknown-src"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).toThrow("Unknown source ID: unknown-src");
  });

  test("rejects earningsSetup bullet with unknown source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          expectationBar: [{ text: "Analysts expect a beat.", sourceIds: ["missing-source"] }],
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).toThrow("Unknown source ID: missing-source");
  });

  test("rejects earningsSetup bullet text without source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          qualityLandmines: [{ text: "Revenue recognition concern.", sourceIds: [] }],
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).toThrow("must reference source IDs");
  });

  test("validates earningsSetup with no bullet sections", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "amc",
            sourceIds: [],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: ["No Tradier credentials for implied move."],
        },
      },
    };
    expect(() => validateResearchReport(report)).not.toThrow();
  });

  test("rejects earningsSetup impliedMove with unknown source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          impliedMove: {
            expiration: "2026-07-31",
            strike: 200,
            spot: 198,
            straddleMidpoint: 12,
            impliedMovePct: 0.06,
            sourceIds: ["orphan-implied-move"],
            observedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).toThrow("Unknown source ID: orphan-implied-move");
  });

  test("validates earningsSetup impliedMove with known source IDs", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          impliedMove: {
            expiration: "2026-07-31",
            strike: 200,
            spot: 198,
            straddleMidpoint: 12,
            impliedMovePct: 0.06,
            sourceIds: ["src-1"],
            observedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).not.toThrow();
  });

  test("rejects earningsSetup bullets containing trade-action language", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          expectationBar: [{ text: "Buy AAPL before the earnings call.", sourceIds: ["src-1"] }],
          gaps: [],
        },
      },
    };
    expect(() => validateResearchReport(report)).toThrow("trade-action language");
  });
});

// ---------------------------------------------------------------------------
// 4. Markdown renderer tests for Earnings Setup
// ---------------------------------------------------------------------------

describe("renderMarkdownReport — earnings setup section", () => {
  const baseReport: ResearchReport = researchReport({
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    sources: [
      {
        id: "src-1",
        title: "AAPL data",
        fetchedAt: "2026-05-14T00:00:00.000Z",
        kind: "market-data",
        assetClass: "equity",
        symbol: "AAPL",
      },
    ],
    keyFindings: [{ text: "Earnings data available.", sourceIds: ["src-1"] }],
  });

  test("renders earnings setup event metadata", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("## Earnings Setup");
    expect(markdown).toContain("AAPL earnings on 2026-07-24 (timing: bmo)");
  });

  test("renders implied move bar", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "amc",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          impliedMove: {
            expiration: "2026-07-25",
            strike: 200,
            spot: 198,
            straddleMidpoint: 9.5,
            impliedMovePct: 0.048,
            sourceIds: ["src-1"],
            observedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("**Implied move:** ±4.8%");
    expect(markdown).toContain("ATM strike 200");
    expect(markdown).toContain("expiration 2026-07-25");
  });

  test("renders model-authored bullet sections", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          expectationBar: [{ text: "Consensus expects 6% revenue growth.", sourceIds: ["src-1"] }],
          qualityLandmines: [
            { text: "One-time charge may distort margins.", sourceIds: ["src-1"] },
          ],
          guidanceCredibility: [
            { text: "Management has a strong track record.", sourceIds: ["src-1"] },
          ],
          gaps: [],
        },
      },
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("### Expectation Bar");
    expect(markdown).toContain("Consensus expects 6% revenue growth.");
    expect(markdown).toContain("### Quality Landmines");
    expect(markdown).toContain("One-time charge may distort margins.");
    expect(markdown).toContain("### Guidance Credibility");
    expect(markdown).toContain("Management has a strong track record.");
  });

  test("renders earnings setup gaps", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "unknown",
            sourceIds: [],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [
            "No Tradier credentials for implied move.",
            "Historical earnings surprise data unavailable.",
          ],
        },
      },
    };
    const markdown = renderMarkdownReport(report);
    expect(markdown).toContain("### Earnings Setup Gaps");
    expect(markdown).toContain("No Tradier credentials for implied move.");
    expect(markdown).toContain("Historical earnings surprise data unavailable.");
  });

  test("omits earnings setup section for non-ticker reports", () => {
    const dailyReport: ResearchReport = {
      ...baseReport,
      jobType: "daily",
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "bmo",
            sourceIds: [],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    const markdown = renderMarkdownReport(dailyReport);
    expect(markdown).not.toContain("## Earnings Setup");
  });

  test("omits earnings setup section when no earningsSetup extra exists", () => {
    const markdown = renderMarkdownReport(baseReport);
    expect(markdown).not.toContain("## Earnings Setup");
  });

  test("rendered earnings setup section passes research-only check", () => {
    const report: ResearchReport = {
      ...baseReport,
      extras: {
        earningsSetup: {
          event: {
            symbol: "AAPL",
            date: "2026-07-24",
            timing: "amc",
            sourceIds: ["src-1"],
            fetchedAt: "2026-05-14T00:00:00.000Z",
          },
          expectationBar: [{ text: "Street expects 2.15 EPS.", sourceIds: ["src-1"] }],
          impliedMove: {
            expiration: "2026-07-25",
            strike: 200,
            spot: 198,
            straddleMidpoint: 9.5,
            impliedMovePct: 0.048,
            sourceIds: ["src-1"],
            observedAt: "2026-05-14T00:00:00.000Z",
          },
          gaps: [],
        },
      },
    };
    const markdown = renderMarkdownReport(report);
    const earningsSection = markdown.slice(markdown.indexOf("## Earnings Setup"));
    expect(violatesResearchOnly(earningsSection)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Source tests — Finnhub trigger window and Tradier ATM straddle
// ---------------------------------------------------------------------------

describe("parseNearEarningsEvent", () => {
  const today = "2026-06-01T00:00:00.000Z";

  test("returns nearest event within 30-day window", () => {
    const payload = {
      earningsCalendar: [
        { symbol: "AAPL", date: "2026-06-15", hour: "amc", epsEstimate: 1.5 },
        { symbol: "AAPL", date: "2026-06-25", hour: "bmo" },
      ],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toEqual({
      symbol: "AAPL",
      date: "2026-06-15",
      timing: "amc",
      epsEstimate: 1.5,
      sourceIds: ["finnhub-1"],
      fetchedAt: today,
    });
  });

  test("returns undefined when no event within 30 days", () => {
    const payload = {
      earningsCalendar: [{ symbol: "AAPL", date: "2026-08-01", hour: "bmo" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toBeUndefined();
  });

  test("ignores past events", () => {
    const payload = {
      earningsCalendar: [{ symbol: "AAPL", date: "2026-05-01", hour: "amc" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toBeUndefined();
  });

  test("ignores events for different symbols", () => {
    const payload = {
      earningsCalendar: [{ symbol: "MSFT", date: "2026-06-10", hour: "bmo" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toBeUndefined();
  });

  test("parses unknown timing for unrecognized hour values", () => {
    const payload = {
      earningsCalendar: [{ symbol: "AAPL", date: "2026-06-15", hour: "dmh" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event?.timing).toBe("unknown");
  });

  test("parses event on exact boundary (30 days out)", () => {
    const payload = {
      earningsCalendar: [{ symbol: "AAPL", date: "2026-07-01", hour: "bmo" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toBeDefined();
    expect(event?.date).toBe("2026-07-01");
  });

  test("returns undefined for event at 31 days", () => {
    const payload = {
      earningsCalendar: [{ symbol: "AAPL", date: "2026-07-02", hour: "bmo" }],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event).toBeUndefined();
  });

  test("handles empty earnings calendar", () => {
    const event = parseNearEarningsEvent({}, "AAPL", today, "finnhub-1");
    expect(event).toBeUndefined();
  });

  test("includes revenue estimate when present", () => {
    const payload = {
      earningsCalendar: [
        {
          symbol: "AAPL",
          date: "2026-06-15",
          hour: "bmo",
          epsEstimate: 2.1,
          revenueEstimate: 95_000_000_000,
        },
      ],
    };
    const event = parseNearEarningsEvent(payload, "AAPL", today, "finnhub-1");
    expect(event?.epsEstimate).toBe(2.1);
    expect(event?.revenueEstimate).toBe(95_000_000_000);
  });
});

function makeEarningsEvent(symbol = "AAPL", date = "2026-07-24"): EarningsEvent {
  return {
    symbol,
    date,
    timing: "amc",
    sourceIds: ["src-1"],
    fetchedAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("computeImpliedMove", () => {
  test("returns gap when tradierApiToken is undefined", async () => {
    const ctx = {
      tradierApiToken: undefined,
      request: { json: async () => ({}) },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 200);
    expect(result.impliedMove).toBeUndefined();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.message).toContain("MARKET_BOT_TRADIER_API_TOKEN");
  });

  test("returns gap when no expirations found within 7 days", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-08-15"] } },
            };
          }
          return { ok: true, rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" }, payload: {} };
        },
      },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 200);
    expect(result.impliedMove).toBeUndefined();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.message).toContain("No Tradier expiration found");
  });

  test("returns gap when no valid option quotes in chain", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-07-25"] } },
            };
          }
          if (adapter === "tradier-earnings-chain") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { options: { option: [] } },
            };
          }
          return { ok: true, rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" }, payload: {} };
        },
      },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 200);
    expect(result.impliedMove).toBeUndefined();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.message).toContain("No valid option quotes");
  });

  test("returns gap when ATM call/put pair is missing", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-07-25"] } },
            };
          }
          if (adapter === "tradier-earnings-chain") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: {
                options: {
                  option: [
                    { strike: 200, option_type: "call", bid: 5, ask: 6 },
                    // No put at strike 200
                  ],
                },
              },
            };
          }
          return { ok: true, rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" }, payload: {} };
        },
      },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 200);
    expect(result.impliedMove).toBeUndefined();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.message).toContain("Missing ATM call/put pair");
  });

  test("computes implied move from ATM straddle", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-07-25"] } },
            };
          }
          if (adapter === "tradier-earnings-chain") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: {
                options: {
                  option: [
                    { strike: 195, option_type: "call", bid: 10, ask: 11 },
                    { strike: 195, option_type: "put", bid: 3, ask: 4 },
                    { strike: 200, option_type: "call", bid: 6, ask: 8 },
                    { strike: 200, option_type: "put", bid: 5, ask: 7 },
                    { strike: 205, option_type: "call", bid: 3, ask: 4 },
                    { strike: 205, option_type: "put", bid: 8, ask: 10 },
                  ],
                },
              },
            };
          }
          return { ok: true, rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" }, payload: {} };
        },
      },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 198);
    expect(result.impliedMove).toBeDefined();
    // ATM strike nearest to 198 is 200.
    expect(result.impliedMove?.strike).toBe(200);
    // Call midpoint = (6+8)/2 = 7; put midpoint = (5+7)/2 = 6; straddle = 13.
    expect(result.impliedMove?.straddleMidpoint).toBe(13);
    // ImpliedMovePct = 13 / 198
    expect(result.impliedMove?.impliedMovePct).toBeCloseTo(13 / 198, 6);
    expect(result.impliedMove?.expiration).toBe("2026-07-25");
    expect(result.gaps).toHaveLength(0);
  });

  const atmChainPayload = {
    options: {
      option: [
        { strike: 200, option_type: "call", bid: 6, ask: 8 },
        { strike: 200, option_type: "put", bid: 5, ask: 7 },
      ],
    },
  };

  test("skips a same-day expiration for AMC events", async () => {
    const requestedExpirations: string[] = [];
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter, url }: { adapter: string; url: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-24T00:00:00.000Z" },
              // Same-day (event-date) expiration plus a later one.
              payload: { expirations: { date: ["2026-07-24", "2026-07-27"] } },
            };
          }
          requestedExpirations.push(url);
          return {
            ok: true,
            rawSnapshot: { fetchedAt: "2026-07-24T00:00:00.000Z" },
            payload: atmChainPayload,
          };
        },
      },
    } as unknown as CollectContext;

    // AMC prints after close on 2026-07-24, so the same-day expiry settles before
    // The reaction — selection must skip it for the 2026-07-27 expiration.
    const result = await computeImpliedMove(ctx, makeEarningsEvent("AAPL", "2026-07-24"), 200);
    expect(result.impliedMove?.expiration).toBe("2026-07-27");
    expect(requestedExpirations.some((url) => url.includes("2026-07-27"))).toBe(true);
  });

  test("allows a same-day expiration for BMO events", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-24T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-07-24", "2026-07-27"] } },
            };
          }
          return {
            ok: true,
            rawSnapshot: { fetchedAt: "2026-07-24T00:00:00.000Z" },
            payload: atmChainPayload,
          };
        },
      },
    } as unknown as CollectContext;

    // BMO prints before the open on 2026-07-24, so the same-day expiry captures
    // The reaction and is the nearest valid expiration.
    const bmoEvent: EarningsEvent = { ...makeEarningsEvent("AAPL", "2026-07-24"), timing: "bmo" };
    const result = await computeImpliedMove(ctx, bmoEvent, 200);
    expect(result.impliedMove?.expiration).toBe("2026-07-24");
  });

  test("returns gap when spot is zero", async () => {
    const ctx = {
      tradierApiToken: "test-token",
      request: {
        json: async ({ adapter }: { adapter: string }) => {
          if (adapter === "tradier-earnings-expirations") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: { expirations: { date: ["2026-07-25"] } },
            };
          }
          if (adapter === "tradier-earnings-chain") {
            return {
              ok: true,
              rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" },
              payload: {
                options: {
                  option: [
                    { strike: 0, option_type: "call", bid: 1, ask: 2 },
                    { strike: 0, option_type: "put", bid: 1, ask: 2 },
                  ],
                },
              },
            };
          }
          return { ok: true, rawSnapshot: { fetchedAt: "2026-07-20T00:00:00.000Z" }, payload: {} };
        },
      },
    } as unknown as CollectContext;

    const result = await computeImpliedMove(ctx, makeEarningsEvent(), 0);
    expect(result.impliedMove).toBeUndefined();
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.message).toContain("Spot price is zero");
  });
});
