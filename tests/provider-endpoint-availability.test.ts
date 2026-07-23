import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { deriveProviderEndpointAvailability } from "../src/sources/provider-endpoint-availability";
import type { RawSourceSnapshot } from "../src/sources/types";

function snapshot(adapter: string): RawSourceSnapshot {
  return {
    id: adapter,
    adapter,
    fetchedAt: "2026-07-23T00:00:00.000Z",
    payload: {},
  };
}

function gap(
  source: string,
  cause: "missing-credential" | "unsupported-coverage" | "fetch-failed",
  message: string,
): SourceGap {
  return { source, cause, message };
}

describe("provider endpoint availability", () => {
  test("derives available endpoints from sorted unique adapter evidence", () => {
    const result = deriveProviderEndpointAvailability(
      [
        snapshot("finnhub-events-3"),
        snapshot("finnhub-events-1"),
        snapshot("finnhub-events-1"),
        snapshot("finnhub-eps-estimate"),
        snapshot("finnhub-revenue-estimate"),
        snapshot("finnhub-ebitda-estimate"),
        snapshot("finnhub-analyst-range"),
      ],
      [],
    );

    expect(result.finnhubEvents).toEqual({
      status: "available",
      evidence: ["finnhub-events-1", "finnhub-events-3"],
    });
    expect(result.finnhubEpsEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-eps-estimate"],
    });
    expect(result.finnhubRevenueEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-revenue-estimate"],
    });
    expect(result.finnhubEbitdaEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-ebitda-estimate"],
    });
    expect(result.finnhubPriceTarget).toEqual({
      status: "available",
      evidence: ["finnhub-analyst-range"],
    });
  });

  test("prefers observed requests over availability gaps", () => {
    const result = deriveProviderEndpointAvailability(
      [snapshot("sec-companyfacts")],
      [gap("sec-edgar", "missing-credential", "credential absent")],
    );

    expect(result.secCompanyFacts).toEqual({
      status: "available",
      evidence: ["sec-companyfacts"],
    });
  });

  test("classifies missing credentials and unsupported coverage", () => {
    const result = deriveProviderEndpointAvailability(
      [],
      [
        gap("finnhub-events", "missing-credential", "token absent"),
        gap("finnhub-eps-estimate", "unsupported-coverage", "plan unavailable"),
        gap("finnhub-revenue-estimate", "missing-credential", "token absent"),
        gap("tradier-options", "unsupported-coverage", "listing unsupported"),
      ],
    );

    expect(result.finnhubEvents).toEqual({
      status: "missing-credential",
      evidence: ["finnhub-events"],
      reason: "token absent",
    });
    expect(result.tradierOptions).toEqual({
      status: "unsupported",
      evidence: ["tradier-options"],
      reason: "listing unsupported",
    });
    expect(result.finnhubEpsEstimate).toEqual({
      status: "unsupported",
      evidence: ["finnhub-eps-estimate"],
      reason: "plan unavailable",
    });
    expect(result.finnhubRevenueEstimate).toEqual({
      status: "missing-credential",
      evidence: ["finnhub-revenue-estimate"],
      reason: "token absent",
    });
  });

  test("keeps unobserved endpoints unmeasured", () => {
    const result = deriveProviderEndpointAvailability([], []);

    expect(result.yahooQuote).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "No request or normalized availability gap for yahoo-ticker",
    });
  });

  test("preserves the phase0 implied-move evidence label when the value is present", () => {
    const result = deriveProviderEndpointAvailability([], [], true);

    expect(result.tradierEarningsImpliedMove).toEqual({
      status: "available",
      evidence: ["earningsSetup.impliedMove"],
    });
  });
});
