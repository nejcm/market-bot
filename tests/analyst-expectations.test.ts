import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { violatesResearchOnly } from "../src/domain/research-language";
import {
  collectAnalystExpectations,
  parseEstimateConsensus,
  parsePriceTargetDistribution,
} from "../src/sources/extended-evidence/analyst-expectations";
import { deriveEquityAnalysisCompleteness } from "../src/sources/extended-evidence/equity-analysis-completeness";
import { deriveProviderEndpointAvailability } from "../src/sources/provider-endpoint-availability";
import type { CollectContext, FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

const FETCHED_AT = "2026-07-23T00:00:00.000Z";

function rawJson(adapter: string, payload: unknown): FetchJsonResult {
  return {
    rawSnapshot: {
      id: `raw-${adapter}`,
      adapter,
      fetchedAt: FETCHED_AT,
      payload,
    },
    payload,
  };
}

function context(input: {
  readonly token?: string;
  readonly request?: SourceRequestExecutor;
}): CollectContext {
  return {
    command: {
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      depth: "deep",
    },
    fetchedAt: FETCHED_AT,
    newsLimit: 1,
    cryptoMoverLimit: 1,
    ...(input.token !== undefined ? { finnhubApiToken: input.token } : {}),
    request: input.request ?? {
      json: async () => {
        throw new Error("unexpected request");
      },
      text: async () => {
        throw new Error("unexpected request");
      },
    },
  };
}

describe("analyst expectations", () => {
  test("parses estimate consensus and external analyst range distributions", () => {
    expect(
      parseEstimateConsensus(
        {
          data: [
            {
              period: "2026-09-30",
              epsAvg: 1.72,
              epsMedian: 1.7,
              epsHigh: 1.9,
              epsLow: 1.5,
              numberAnalysts: 28,
            },
          ],
        },
        "eps",
      ),
    ).toEqual([
      {
        period: "2026-09-30",
        mean: 1.72,
        median: 1.7,
        high: 1.9,
        low: 1.5,
        count: 28,
      },
    ]);
    expect(
      parsePriceTargetDistribution({
        targetMean: 240,
        targetMedian: 235,
        targetHigh: 280,
        targetLow: 190,
        numberAnalysts: 42,
      }),
    ).toEqual({ mean: 240, median: 235, high: 280, low: 190, count: 42 });
  });

  test("consumes populated 200 responses and completes expectations", async () => {
    const result = await collectAnalystExpectations(
      context({
        token: "fixture-token",
        request: {
          json: async ({ adapter }) => {
            if (adapter === "finnhub-eps-estimate") {
              return rawJson(adapter, {
                data: [{ period: "2026-09-30", epsAvg: 1.72, numberAnalysts: 28 }],
              });
            }
            if (adapter === "finnhub-revenue-estimate") {
              return rawJson(adapter, {
                data: [
                  {
                    period: "2026-09-30",
                    revenueAvg: 98_000_000_000,
                    numberAnalysts: 24,
                  },
                ],
              });
            }
            if (adapter === "finnhub-ebitda-estimate") {
              return rawJson(adapter, {
                data: [{ period: "2026-09-30", ebitdaAvg: 35_000_000_000 }],
              });
            }
            return rawJson(adapter, {
              targetMean: 240,
              targetMedian: 235,
              targetHigh: 280,
              targetLow: 190,
              numberAnalysts: 42,
            });
          },
          text: async () => {
            throw new Error("unexpected text request");
          },
        },
      }),
    );

    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      ...(result.artifact !== undefined ? { analystExpectations: result.artifact } : {}),
      analystExpectationsSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.signal).toEqual({
      status: "available",
      sourceIds: [
        "extended-finnhub-analyst-aapl-eps",
        "extended-finnhub-analyst-aapl-revenue",
        "extended-finnhub-analyst-aapl-ebitda",
      ],
    });
    expect(completeness.dimensions.expectations).toEqual({
      status: "complete",
      reasonCodes: [],
      asOf: FETCHED_AT,
      sourceIds: ["extended-finnhub-analyst-aapl-eps", "extended-finnhub-analyst-aapl-revenue"],
    });
    expect(availability.finnhubEpsEstimate?.status).toBe("available");
    expect(availability.finnhubRevenueEstimate?.status).toBe("available");
    expect(availability.finnhubEbitdaEstimate?.status).toBe("available");
    expect(availability.finnhubPriceTarget?.status).toBe("available");
    expect(
      violatesResearchOnly(
        JSON.stringify(
          result.items.map(({ item }) => ({ title: item.title, summary: item.summary })),
        ),
      ),
    ).toBeNull();
  });

  test("continues after per-call 403 and degrades expectations without changing the core", async () => {
    const result = await collectAnalystExpectations(
      context({
        token: "fixture-token",
        request: {
          json: async ({ adapter }) =>
            sourceGap({
              source: adapter,
              message: `${adapter} source request failed with status 403`,
              cause: "fetch-failed",
            }),
          text: async () => {
            throw new Error("unexpected text request");
          },
        },
      }),
    );
    const baseline = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
    });
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      ...(result.artifact !== undefined ? { analystExpectations: result.artifact } : {}),
      analystExpectationsSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.signal).toEqual({ status: "forbidden", sourceIds: [] });
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps.every((gap) => gap.cause === "unsupported-coverage")).toBe(true);
    expect(completeness.financialCoreStatus).toBe(baseline.financialCoreStatus);
    expect(completeness.dimensions.expectations).toEqual({
      status: "partial",
      reasonCodes: ["expectations-provider-entitlement-blocked"],
      asOf: FETCHED_AT,
      sourceIds: [],
    });
    expect(completeness.dimensions.expectations.status).not.toBe("not-applicable");
    expect(availability.finnhubEpsEstimate?.status).toBe("unsupported");
    expect(availability.finnhubRevenueEstimate?.status).toBe("unsupported");
    expect(availability.finnhubEbitdaEstimate?.status).toBe("unsupported");
    expect(availability.finnhubPriceTarget?.status).toBe("unsupported");
  });

  test("skips requests without a credential and degrades expectations", async () => {
    const result = await collectAnalystExpectations(context({}));
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      analystExpectationsSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.signal).toEqual({ status: "missing-credential", sourceIds: [] });
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps.every((gap) => gap.cause === "missing-credential")).toBe(true);
    expect(completeness.dimensions.expectations).toEqual({
      status: "partial",
      reasonCodes: ["expectations-provider-credential-missing"],
      asOf: FETCHED_AT,
      sourceIds: [],
    });
    expect(completeness.dimensions.expectations.status).not.toBe("not-applicable");
    expect(availability.finnhubEpsEstimate?.status).toBe("missing-credential");
    expect(availability.finnhubRevenueEstimate?.status).toBe("missing-credential");
    expect(availability.finnhubEbitdaEstimate?.status).toBe("missing-credential");
    expect(availability.finnhubPriceTarget?.status).toBe("missing-credential");
  });
});
