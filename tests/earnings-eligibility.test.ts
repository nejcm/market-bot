import { describe, expect, test } from "bun:test";
import type { Prediction, ResearchReport } from "../src/domain/types";
import {
  applyEarningsForecastPolicy,
  readEarningsForecastTelemetry,
} from "../src/forecast/earnings-eligibility";
import type { EarningsSetupCollected } from "../src/sources/types";
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
});
