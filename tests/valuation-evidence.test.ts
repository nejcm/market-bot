import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { marketSnapshot } from "./support/fixtures";

const command = { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

function secEvidence(
  metrics: Record<string, number | string>,
  overrides: { readonly items?: ExtendedEvidence["items"] } = {},
): ExtendedEvidence {
  return {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: overrides.items ?? [
      {
        category: "sec-edgar",
        title: "AAPL SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-05-18T00:00:00.000Z",
        metrics,
      },
    ],
    gaps: [],
  };
}

const baseExtendedEvidence: ExtendedEvidence = secEvidence({
  revenue: 100,
  revenuePeriodMonths: 3,
  revenuePeriodEnd: "2026-06-29",
  cash: 30,
  debt: 50,
});

describe("addValuationEvidence", () => {
  test("derives supplemental valuation metrics from market cap and SEC fundamentals", () => {
    const result = addValuationEvidence(
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-aapl",
          symbol: "AAPL",
          marketCap: 1000,
          observedAt: "2026-05-19T00:00:00.000Z",
        }),
      ],
      baseExtendedEvidence,
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(result.sourceGaps).toEqual([]);
    expect(valuation).toMatchObject({
      title: "AAPL Valuation Evidence",
      sourceIds: ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"],
      observedAt: "2026-05-19T00:00:00.000Z",
      metrics: {
        marketCap: 1000,
        cash: 30,
        debt: 50,
        netDebt: 20,
        enterpriseValue: 1020,
        latestPeriodRevenue: 100,
        annualizedRevenue: 400,
        revenuePeriodMonths: 3,
        revenuePeriodEnd: "2026-06-29",
        evToAnnualizedRevenue: 2.55,
        marketCapToAnnualizedRevenue: 2.5,
        debtToMarketCap: 0.05,
        netDebtToMarketCap: 0.02,
      },
    });
    expect(valuation?.summary).toContain(
      "market cap $1.0K, enterprise value $1.0K, 3-month revenue $100, annualized revenue $400",
    );
    expect(valuation?.summary).toContain("EV/annualized revenue 2.55x");
  });

  test("treats a full-year (12-month) latest revenue fact as already annual", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({ revenue: 400, revenuePeriodMonths: 12, cash: 30, debt: 50 }),
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({
      annualizedRevenue: 400,
      marketCapToAnnualizedRevenue: 2.5,
    });
    expect(valuation?.summary).toContain("12-month revenue $400, annualized revenue $400");
  });

  test("annualizes a year-to-date (9-month) latest revenue fact by its period", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({ revenue: 300, revenuePeriodMonths: 9, cash: 30, debt: 50 }),
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics?.annualizedRevenue).toBeCloseTo(400);
  });

  test("does not extrapolate revenue when the period length is unknown", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({ revenue: 400, cash: 30, debt: 50 }),
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({ annualizedRevenue: 400 });
    expect(valuation?.metrics?.revenuePeriodMonths).toBeUndefined();
    expect(valuation?.summary).toContain("annualized revenue $400");
    expect(valuation?.summary).not.toContain("-month revenue");
  });

  test("prefers the sec-edgar item carrying fundamentals over a metrics-less excerpt", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence(
        {},
        {
          items: [
            {
              category: "sec-edgar",
              title: "AAPL 10-Q excerpt",
              summary: "Filing excerpt without fundamentals.",
              sourceIds: ["extended-sec-edgar-aapl-excerpt"],
              observedAt: "2026-05-18T00:00:00.000Z",
              metrics: {},
            },
            {
              category: "sec-edgar",
              title: "AAPL SEC Fundamental Evidence",
              summary: "SEC Fundamental Evidence.",
              sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              observedAt: "2026-05-18T00:00:00.000Z",
              metrics: { revenue: 100, revenuePeriodMonths: 3, cash: 30, debt: 50 },
            },
          ],
        },
      ),
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(result.sourceGaps).toEqual([]);
    expect(valuation?.sourceIds).toContain("extended-sec-edgar-aapl-fundamentals");
    expect(valuation?.metrics?.annualizedRevenue).toBe(400);
  });

  test("emits a no-cap gap when valuation inputs are missing", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL" })],
      baseExtendedEvidence,
    );

    expect(result.extendedEvidence?.items.map((item) => item.category)).toEqual(["sec-edgar"]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "valuation",
        message: "Valuation Evidence unavailable for AAPL: missing marketCap",
        evidenceQualityImpact: "no-cap",
      }),
    ]);
    expect(result.extendedEvidence?.gaps).toEqual(result.sourceGaps);
  });
});
