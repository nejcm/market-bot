import { describe, expect, test } from "bun:test";
import type { Prediction, ResearchReport } from "../src/domain/types";
import {
  applyEarningsForecastPolicy,
  readEarningsForecastTelemetry,
} from "../src/forecast/earnings-eligibility";
import type { EarningsSetupCollected } from "../src/sources/types";
import { validateResearchReport } from "../src/report/schema";
import { prediction, researchReport } from "./support/fixtures";

function earningsPrediction(kind: "earnings-direction" | "earnings-move"): Prediction {
  return prediction({
    id: kind,
    kind,
    subject: "AAPL",
    measurableAs:
      kind === "earnings-direction"
        ? "earningsReturn(AAPL, 2026-07-30, +1) > 0"
        : "abs(earningsReturn(AAPL, 2026-07-30, +1)) > 0.04",
    claim: "code-owned claim",
    horizonTradingDays: 1,
  });
}

function setup(
  eventDateStatus: "provider-estimated" | "issuer-confirmed" = "provider-estimated",
): EarningsSetupCollected {
  return {
    event: {
      symbol: "AAPL",
      date: "2026-07-30",
      timing: "amc",
      eventDateStatus,
      ...(eventDateStatus === "provider-estimated"
        ? { dateStatus: "provider-estimated" as const }
        : {}),
      sourceIds: ["event-source"],
      fetchedAt: "2026-07-20T00:00:00.000Z",
    },
    gaps: [],
  };
}

describe("earnings forecast eligibility telemetry", () => {
  test("records provider-estimated certainty without changing legacy eligibility", () => {
    const result = applyEarningsForecastPolicy({
      predictions: [earningsPrediction("earnings-direction"), earningsPrediction("earnings-move")],
      setup: setup(),
      policy: "legacy-ungated",
    });

    expect(result.predictions.map((item) => item.eventDateStatus)).toEqual([
      "provider-estimated",
      "provider-estimated",
    ]);
    expect(result.telemetry).toEqual({
      eventDateStatus: "provider-estimated",
      policy: "legacy-ungated",
      grammarEligible: true,
      eligiblePredictionCount: 2,
      suppressedPredictionCount: 0,
    });
  });

  test("tolerates historical reports without certainty telemetry", () => {
    const historical = researchReport({
      predictions: [earningsPrediction("earnings-direction")],
    }) satisfies ResearchReport;

    expect(readEarningsForecastTelemetry(historical)).toBeUndefined();
  });

  test("suppresses provider-estimated earnings forecasts under the confirmed-only policy", () => {
    const result = applyEarningsForecastPolicy({
      predictions: [earningsPrediction("earnings-direction"), earningsPrediction("earnings-move")],
      setup: setup(),
      policy: "confirmed-only",
    });

    expect(result.predictions).toEqual([]);
    expect(result.telemetry).toEqual({
      eventDateStatus: "provider-estimated",
      policy: "confirmed-only",
      grammarEligible: false,
      eligiblePredictionCount: 0,
      suppressedPredictionCount: 2,
      suppressionReason: "event-date-not-confirmed",
    });
  });

  test("keeps issuer-confirmed earnings forecasts and stamps their provenance", () => {
    const result = applyEarningsForecastPolicy({
      predictions: [earningsPrediction("earnings-direction")],
      setup: setup("issuer-confirmed"),
      policy: "confirmed-only",
    });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]?.eventDateStatus).toBe("issuer-confirmed");
    expect(result.telemetry).toMatchObject({
      eventDateStatus: "issuer-confirmed",
      policy: "confirmed-only",
      grammarEligible: true,
      eligiblePredictionCount: 1,
      suppressedPredictionCount: 0,
    });
  });

  test("report validation rejects provider-estimated earnings under confirmed-only telemetry", () => {
    const estimatedPrediction = {
      ...earningsPrediction("earnings-direction"),
      eventDateStatus: "provider-estimated" as const,
    };
    const report = researchReport({
      predictions: [estimatedPrediction],
      extras: {
        earningsForecasts: {
          eventDateStatus: "provider-estimated",
          policy: "confirmed-only",
          grammarEligible: false,
          eligiblePredictionCount: 1,
          suppressedPredictionCount: 0,
          suppressionReason: "event-date-not-confirmed",
        },
      },
    });

    expect(() => validateResearchReport(report)).toThrow(
      "Unconfirmed earnings dates cannot anchor earnings predictions",
    );
  });
});
