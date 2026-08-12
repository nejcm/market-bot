import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { violatesResearchOnly } from "../src/domain/research-language";
import { deriveEquityAnalysisCompleteness } from "../src/sources/extended-evidence/equity-analysis-completeness";
import {
  collectInstitutionalOwnership,
  parseInsiderTransactionMetrics,
  parseInstitutionalHolderMetrics,
} from "../src/sources/extended-evidence/institutional-ownership";
import { deriveProviderEndpointAvailability } from "../src/sources/provider-endpoint-availability";
import type { CollectContext, FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

const FETCHED_AT = "2026-07-24T00:00:00.000Z";

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

describe("institutional ownership", () => {
  test("parses structured institutional and insider metrics", () => {
    expect(
      parseInstitutionalHolderMetrics({
        ownership: [
          { investorName: "Holder A", share: 1000, ownership: 0.1 },
          { investorName: "Holder B", share: 2500, ownership: 0.25 },
        ],
      }),
    ).toEqual({
      holderCount: 2,
      reportedShares: 3500,
      reportedOwnershipPercent: 0.35,
    });
    expect(
      parseInsiderTransactionMetrics({
        data: [
          { name: "Officer A", change: 1000, transactionPrice: 200 },
          { name: "Officer B", change: -400, transactionPrice: 205 },
          { name: "Officer C", share: 10_000 },
        ],
      }),
    ).toEqual({
      transactionCount: 3,
      purchaseCount: 1,
      saleCount: 1,
      netShareChange: 600,
    });
  });

  test("consumes populated 200 responses as supplementary context", async () => {
    const result = await collectInstitutionalOwnership(
      context({
        token: "fixture-token",
        request: {
          json: async ({ adapter }) =>
            adapter === "finnhub-institutional-ownership"
              ? rawJson(adapter, {
                  ownership: [
                    { investorName: "Holder A", share: 1000, ownership: 0.1 },
                    { investorName: "Holder B", share: 2500, ownership: 0.25 },
                  ],
                })
              : rawJson(adapter, {
                  data: [
                    { name: "Officer A", change: 1000, transactionPrice: 200 },
                    { name: "Officer B", change: -400, transactionPrice: 205 },
                  ],
                }),
          text: async () => {
            throw new Error("unexpected text request");
          },
        },
      }),
    );

    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      ...(result.artifact !== undefined ? { institutionalOwnership: result.artifact } : {}),
      institutionalOwnershipSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.artifact).toMatchObject({
      version: 1,
      symbol: "AAPL",
      institutionalHolders: {
        provider: "finnhub",
        holderCount: 2,
        reportedShares: 3500,
        reportedOwnershipPercent: 0.35,
      },
      insiderTransactions: {
        provider: "finnhub",
        transactionCount: 2,
        purchaseCount: 1,
        saleCount: 1,
        netShareChange: 600,
      },
    });
    expect(result.signal).toEqual({
      status: "available",
      sourceIds: [
        "extended-finnhub-ownership-aapl-institutional",
        "extended-finnhub-ownership-aapl-insider-transactions",
      ],
    });
    expect(completeness.dimensions.capitalOwnership).toEqual({
      status: "partial",
      reasonCodes: [
        "diluted-share-history-missing",
        "sbc-history-missing",
        "payout-evidence-missing",
        "ownership-external-context-available",
      ],
      asOf: FETCHED_AT,
      sourceIds: result.signal.sourceIds,
    });
    expect(availability.finnhubInstitutionalOwnership?.status).toBe("available");
    expect(availability.finnhubInsiderTransactions?.status).toBe("available");
    expect(
      violatesResearchOnly(
        JSON.stringify(
          result.items.map(({ item }) => ({
            title: item.title,
            summary: item.summary,
            metrics: item.metrics,
          })),
        ),
      ),
    ).toBeNull();
  });

  test("continues after per-call 403 without changing SEC-governed status", async () => {
    const baseline = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
    });
    const result = await collectInstitutionalOwnership(
      context({
        token: "fixture-token",
        request: {
          json: async ({ adapter }) =>
            sourceGap({
              source: adapter,
              message: `${adapter} request failed with status 403`,
              cause: "fetch-failed",
              evidenceQualityImpact: "extended-evidence-cap",
            }),
          text: async () => {
            throw new Error("unexpected text request");
          },
        },
      }),
    );
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      institutionalOwnershipSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.signal).toEqual({ status: "forbidden", sourceIds: [] });
    expect(result.artifact).toBeUndefined();
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps.every((gap) => gap.cause === "unsupported-coverage")).toBe(true);
    expect(completeness.dimensions.capitalOwnership.status).toBe(
      baseline.dimensions.capitalOwnership.status,
    );
    expect(completeness.coverageLevel).toBe(baseline.coverageLevel);
    expect(completeness.dimensions.capitalOwnership).toMatchObject({
      reasonCodes: [
        ...baseline.dimensions.capitalOwnership.reasonCodes,
        "ownership-provider-entitlement-blocked",
      ],
      sourceIds: [],
    });
    expect(completeness.dimensions.capitalOwnership.status).not.toBe("not-applicable");
    expect(availability.finnhubInstitutionalOwnership?.status).toBe("unsupported");
    expect(availability.finnhubInsiderTransactions?.status).toBe("unsupported");
  });

  test("records a missing credential without changing SEC-governed status", async () => {
    const baseline = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
    });
    const result = await collectInstitutionalOwnership(context({}));
    const completeness = deriveEquityAnalysisCompleteness({
      asOf: FETCHED_AT,
      assetClass: "equity",
      institutionalOwnershipSignal: result.signal,
    });
    const availability = deriveProviderEndpointAvailability(result.rawSnapshots, result.gaps);

    expect(result.signal).toEqual({ status: "missing-credential", sourceIds: [] });
    expect(result.artifact).toBeUndefined();
    expect(result.gaps).toHaveLength(2);
    expect(result.gaps.every((gap) => gap.cause === "missing-credential")).toBe(true);
    expect(completeness.dimensions.capitalOwnership.status).toBe(
      baseline.dimensions.capitalOwnership.status,
    );
    expect(completeness.coverageLevel).toBe(baseline.coverageLevel);
    expect(completeness.dimensions.capitalOwnership).toMatchObject({
      reasonCodes: [
        ...baseline.dimensions.capitalOwnership.reasonCodes,
        "ownership-provider-credential-missing",
      ],
      sourceIds: [],
    });
    expect(completeness.dimensions.capitalOwnership.status).not.toBe("not-applicable");
    expect(availability.finnhubInstitutionalOwnership?.status).toBe("missing-credential");
    expect(availability.finnhubInsiderTransactions?.status).toBe("missing-credential");
  });
});
