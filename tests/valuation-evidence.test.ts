import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { marketSnapshot } from "./support/fixtures";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

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
  cashPeriodEnd: "2026-03-31",
  debt: 50,
  debtPeriodEnd: "2026-03-31",
});

describe("addValuationEvidence", () => {
  test("declares a Source Gap when cash and debt periods diverge", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({
        revenue: 100,
        cash: 30,
        cashPeriodEnd: "2026-06-30",
        debt: 50,
        debtPeriodEnd: "2025-06-30",
      }),
      "2026-07-01T00:00:00.000Z",
    );
    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");

    expect(valuation?.metrics?.enterpriseValue).toBe("mixed-period");
    expect(valuation?.metrics?.debtToMarketCap).toBeUndefined();
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("debt period end 2025-06-30 not within 180 days"),
      }),
      expect.objectContaining({
        symbol: "AAPL",
        message: expect.stringContaining("Mixed-period valuation inputs for AAPL"),
      }),
    ]);
  });

  describe("debt currentness at the analysis cutoff", () => {
    const valuationAt = (
      cutoff: string,
      periods: { readonly cashPeriodEnd?: string; readonly debtPeriodEnd?: string },
    ) => {
      const result = addValuationEvidence(
        command,
        [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
        secEvidence({ revenue: 100, cash: 30, debt: 50, ...periods }),
        cutoff,
      );
      return {
        metrics: result.extendedEvidence?.items.find((item) => item.category === "valuation")
          ?.metrics,
        gaps: result.sourceGaps,
      };
    };

    test("keeps debt ratios for fresh aligned balances", () => {
      const { metrics, gaps } = valuationAt("2026-10-08T00:00:00.000Z", {
        cashPeriodEnd: "2026-06-30",
        debtPeriodEnd: "2026-06-30",
      });
      expect(metrics).toMatchObject({ debtToMarketCap: 0.05, netDebtToMarketCap: 0.02 });
      expect(gaps).toEqual([]);
    });

    test("withholds quote-mixed debt ratios for year-old aligned balances but keeps dated debt", () => {
      const { metrics, gaps } = valuationAt("2026-10-08T00:00:00.000Z", {
        cashPeriodEnd: "2025-06-30",
        debtPeriodEnd: "2025-06-30",
      });
      expect(metrics).toMatchObject({ debt: 50, debtPeriodEnd: "2025-06-30", netDebt: 20 });
      expect(metrics?.debtToMarketCap).toBeUndefined();
      expect(metrics?.netDebtToMarketCap).toBeUndefined();
      expect(gaps).toEqual([
        expect.objectContaining({
          source: "valuation",
          message:
            "Non-current SEC balance-sheet inputs for AAPL: debt period end 2025-06-30, cash period end 2025-06-30 not within 180 days before analysis cutoff 2026-10-08 and 92 days of the newest balance-sheet period end; debt/market cap and net debt/market cap withheld",
        }),
      ]);
    });

    test.each([
      ["exactly 180 days old", "2026-04-11", true],
      ["181 days old", "2026-04-10", false],
      ["future-dated", "2026-10-09", false],
      ["undated", undefined, false],
    ])("debt %s", (_label, debtPeriodEnd, current) => {
      const { metrics, gaps } = valuationAt("2026-10-08T00:00:00.000Z", {
        cashPeriodEnd: "2026-06-30",
        ...(debtPeriodEnd === undefined ? {} : { debtPeriodEnd }),
      });
      expect(metrics?.debtToMarketCap).toBe(current ? 0.05 : undefined);
      expect(gaps.some((gap) => gap.message.startsWith("Non-current SEC balance-sheet"))).toBe(
        !current,
      );
    });

    test("withholds only net debt/market cap when cash alone is not current", () => {
      const { metrics, gaps } = valuationAt("2026-10-08T00:00:00.000Z", {
        cashPeriodEnd: "2026-04-10",
        debtPeriodEnd: "2026-06-30",
      });
      expect(metrics?.debtToMarketCap).toBe(0.05);
      expect(metrics?.netDebtToMarketCap).toBeUndefined();
      expect(gaps[0]?.message).toEndWith("; net debt/market cap withheld");
    });

    test.each([
      ["lags", "2026-06-30", "2026-03-29", undefined],
      ["leads", "2026-03-29", "2026-06-30", 0.05],
    ])(
      "mixed-period guard when fresh debt %s cash",
      (_label, cashPeriodEnd, debtPeriodEnd, ratio) => {
        const { metrics } = valuationAt("2026-07-01T00:00:00.000Z", {
          cashPeriodEnd,
          debtPeriodEnd,
        });
        expect(metrics?.netDebt).toBe("mixed-period");
        expect(metrics?.debtToMarketCap).toBe(ratio);
      },
    );
  });

  test("preserves populated valuation values at the canonical input seam", () => {
    const facts = {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [
                {
                  val: 100,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2026,
                  filed: "2026-05-01",
                  start: "2026-01-01",
                  end: "2026-03-31",
                },
              ],
            },
          },
          CashAndCashEquivalentsAtCarryingValue: {
            units: {
              USD: [
                {
                  val: 30,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2026,
                  filed: "2026-05-01",
                  end: "2026-03-31",
                },
              ],
            },
          },
          LongTermDebt: {
            units: {
              USD: [
                {
                  val: 50,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2026,
                  filed: "2026-05-01",
                  end: "2026-03-31",
                },
              ],
            },
          },
        },
      },
    };
    const artifact = deriveFinancialStatements(facts, {
      symbol: "AAPL",
      generatedAt: "2026-05-18T00:00:00.000Z",
      analysisAsOf: "2026-05-18T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    });
    const snapshots = [
      marketSnapshot({
        sourceId: "market-yahoo-equity-aapl",
        symbol: "AAPL",
        marketCap: 1000,
        observedAt: "2026-05-19T00:00:00.000Z",
      }),
    ];
    const legacyInputs = secEvidence({
      revenue: 100,
      revenuePeriodMonths: 3,
      revenuePeriodEnd: "2026-03-31",
      cash: 30,
      cashPeriodEnd: "2026-03-31",
      debt: 50,
      debtPeriodEnd: "2026-03-31",
    });
    const legacy = addValuationEvidence(
      command,
      snapshots,
      legacyInputs,
      "2026-07-01T00:00:00.000Z",
    );
    const canonical = addValuationEvidence(
      command,
      snapshots,
      withCanonicalFinancialLensInputs(legacyInputs, artifact),
      "2026-07-01T00:00:00.000Z",
    );

    expect(canonical.extendedEvidence?.items.find((item) => item.category === "valuation")).toEqual(
      legacy.extendedEvidence?.items.find((item) => item.category === "valuation"),
    );
  });

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
      "2026-07-01T00:00:00.000Z",
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
        quoteObservedAt: "2026-05-19T00:00:00.000Z",
        revenuePeriodMonths: 3,
        revenuePeriodEnd: "2026-06-29",
        cashPeriodEnd: "2026-03-31",
        debtPeriodEnd: "2026-03-31",
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
    expect(valuation?.summary).toContain("market cap as of 2026-05-19; cash/debt as of 2026-03-31");
  });

  test("carries a gross-principal debt basis only when the SEC item declares it", () => {
    const snapshots = [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })];
    const valuation = (evidence: ExtendedEvidence) =>
      addValuationEvidence(
        command,
        snapshots,
        evidence,
        "2026-07-01T00:00:00.000Z",
      ).extendedEvidence?.items.find((item) => item.category === "valuation");
    const gross = valuation(
      secEvidence({ revenue: 400, cash: 30, debt: 50, debtBasis: "gross-principal" }),
    );
    const net = valuation(secEvidence({ revenue: 400, cash: 30, debt: 50 }));

    expect(gross?.metrics?.debtBasis).toBe("gross-principal");
    expect(gross?.summary).toContain(
      "; debt is gross principal; enterprise value is borrowing-based and excludes finance leases.",
    );
    expect(net?.metrics && "debtBasis" in net.metrics).toBe(false);
    expect(net?.summary).not.toContain("gross principal");
  });

  test("clamps negative-zero valuation multiples", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({
        revenue: 400,
        cash: 50.0001,
        cashPeriodEnd: "2026-03-31",
        debt: 50,
        debtPeriodEnd: "2026-03-31",
      }),
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.summary).toContain("net debt/market cap 0.00x");
    expect(valuation?.summary).not.toContain("-0.00x");
  });

  test("treats a full-year (12-month) latest revenue fact as already annual", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({ revenue: 400, revenuePeriodMonths: 12, cash: 30, debt: 50 }),
      "2026-07-01T00:00:00.000Z",
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
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics?.annualizedRevenue).toBeCloseTo(400);
  });

  test("does not extrapolate revenue when the period length is unknown", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({ revenue: 400, cash: 30, debt: 50 }),
      "2026-07-01T00:00:00.000Z",
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
              metrics: {
                revenue: 100,
                revenuePeriodMonths: 3,
                cash: 30,
                cashPeriodEnd: "2026-03-31",
                debt: 50,
                debtPeriodEnd: "2026-03-31",
              },
            },
          ],
        },
      ),
      "2026-07-01T00:00:00.000Z",
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
      "2026-07-01T00:00:00.000Z",
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
