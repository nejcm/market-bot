import { renderPriceProvenance } from "../src/report/markdown-equity-sections";
import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { UNTAGGED_EV_BRIDGE, marketSnapshot } from "./support/fixtures";

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
        metrics: { ...UNTAGGED_EV_BRIDGE, ...metrics },
      },
    ],
    gaps: [],
  };
}

const baseExtendedEvidence: ExtendedEvidence = secEvidence({
  revenue: 100,
  revenueTtm: 400,
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
        revenueTtm: 400,
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

  describe("depository issuer under balance-sheet guards", () => {
    const bankValuation = (metrics: Record<string, number | string>) => {
      const result = addValuationEvidence(
        command,
        [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
        secEvidence({ revenue: 100, revenueTtm: 400, cash: 30, debt: 50, sic: "6022", ...metrics }),
        "2026-07-01T00:00:00.000Z",
      );
      return {
        item: result.extendedEvidence?.items.find((item) => item.category === "valuation"),
        gaps: result.sourceGaps,
      };
    };

    test.each([
      ["mixed-period", { cashPeriodEnd: "2026-06-30", debtPeriodEnd: "2025-06-30" }],
      [
        "incomplete debt",
        {
          cashPeriodEnd: "2026-03-31",
          debtPeriodEnd: "2026-03-31",
          debtIncompletePeriodEnd: "2026-03-31",
          debtIncompleteReason: "untagged component",
        },
      ],
      ["aligned", { cashPeriodEnd: "2026-03-31", debtPeriodEnd: "2026-03-31" }],
    ])("keeps the not-applicable reason when %s", (_case, periods) => {
      const { item, gaps } = bankValuation(periods);
      expect(item?.metrics?.netDebt).toBeUndefined();
      expect(item?.metrics?.enterpriseValue).toBeUndefined();
      expect(item?.metrics?.netDebtToMarketCap).toBeUndefined();
      expect(item?.summary).toContain("depository issuer (SIC 6022)");
      expect(item?.summary).not.toMatch(/mixed-period|enterprise value, net debt[^;]*withheld/u);
      expect(gaps.map(({ message }) => message).join("\n")).not.toContain("Mixed-period");
    });
  });

  describe("debt currentness at the analysis cutoff", () => {
    const valuationAt = (
      cutoff: string,
      periods: { readonly cashPeriodEnd?: string; readonly debtPeriodEnd?: string },
    ) => {
      const result = addValuationEvidence(
        command,
        [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
        secEvidence({ revenue: 100, revenueTtm: 400, cash: 30, debt: 50, ...periods }),
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
                {
                  val: 90,
                  form: "10-Q",
                  fp: "Q1",
                  fy: 2025,
                  filed: "2025-05-01",
                  start: "2025-01-01",
                  end: "2025-03-31",
                },
                {
                  val: 380,
                  form: "10-K",
                  fp: "FY",
                  fy: 2025,
                  filed: "2026-02-01",
                  start: "2025-01-01",
                  end: "2025-12-31",
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
      revenueTtm: 390,
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

    const canonicalValuation = canonical.extendedEvidence?.items.find(
      (item) => item.category === "valuation",
    );
    expect(canonicalValuation?.metrics?.annualizedRevenue).toBe(390);
    expect(canonicalValuation).toEqual(
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
      "market cap $1.0K, enterprise value $1.0K, TTM revenue $400 through 2026-06-29, EV/TTM revenue 2.55x, market cap/TTM revenue 2.50x",
    );
    expect(valuation?.summary).toContain(
      "market cap as of 2026-05-19 (fetch time); cash/debt as of 2026-03-31",
    );
    expect(valuation?.metrics).not.toHaveProperty("quoteTimeUtc");
  });

  test("dates market cap from the provider quote instant on a post-midnight fetch", () => {
    const snapshot = marketSnapshot({
      sourceId: "market-yahoo-equity-aapl",
      symbol: "AAPL",
      marketCap: 1000,
      observedAt: "2026-05-20T00:48:00.000Z",
      quoteTimeUtc: "2026-05-19T20:00:00.000Z",
    });
    const result = addValuationEvidence(
      command,
      [snapshot],
      baseExtendedEvidence,
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({
      quoteObservedAt: "2026-05-20T00:48:00.000Z",
      quoteTimeUtc: "2026-05-19T20:00:00.000Z",
    });
    expect(valuation?.summary).toContain("market cap as of 2026-05-19; cash/debt as of 2026-03-31");
    expect(renderPriceProvenance(valuation!.summary, valuation!.sourceIds, snapshot)).toContain(
      "market cap quote time 2026-05-19T20:00:00.000Z; cash/debt as of 2026-03-31",
    );
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
    expect(valuation?.summary).toContain("net debt/market cap 0.0%");
    expect(valuation?.summary).not.toContain("-0.0%");
  });

  test("renders sub-1% debt ratios as percent instead of rounding them to 0.00x", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({
        revenue: 400,
        cash: 6.1,
        cashPeriodEnd: "2026-03-31",
        debt: 3.9,
        debtPeriodEnd: "2026-03-31",
      }),
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.summary).toContain(", debt/market cap 0.4%, net debt/market cap -0.2%;");
  });

  test("reads the SEC TTM revenue instead of annualizing the latest partial period", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({
        revenue: 300,
        revenueTtm: 500,
        revenuePeriodMonths: 9,
        revenuePeriodEnd: "2026-06-29",
        cash: 30,
        debt: 50,
      }),
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({
      latestPeriodRevenue: 300,
      annualizedRevenue: 500,
      marketCapToAnnualizedRevenue: 2,
    });
    expect(valuation?.summary).toContain("TTM revenue $500 through 2026-06-29");
    expect(valuation?.summary).not.toContain("9-month");
  });

  test("withholds revenue multiples behind a Source Gap when TTM does not reconcile", () => {
    const result = addValuationEvidence(
      command,
      [marketSnapshot({ symbol: "AAPL", marketCap: 1000 })],
      secEvidence({
        revenue: 300,
        revenuePeriodMonths: 9,
        revenuePeriodEnd: "2026-06-29",
        cash: 30,
        cashPeriodEnd: "2026-06-29",
        debt: 50,
        debtPeriodEnd: "2026-06-29",
      }),
      "2026-07-01T00:00:00.000Z",
    );

    const valuation = result.extendedEvidence?.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({ latestPeriodRevenue: 300, enterpriseValue: 1020 });
    expect(valuation?.metrics).not.toHaveProperty("annualizedRevenue");
    expect(valuation?.metrics).not.toHaveProperty("evToAnnualizedRevenue");
    expect(valuation?.metrics).not.toHaveProperty("marketCapToAnnualizedRevenue");
    expect(valuation?.summary).toContain(
      "latest 9-month revenue $300 through 2026-06-29 does not reconcile to TTM revenue, revenue multiples withheld",
    );
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "valuation",
        symbol: "AAPL",
        cause: "provider-data-missing",
        message:
          "TTM revenue unavailable for AAPL: latest 9-month revenue $300 through 2026-06-29 has no reconciling fiscal-year and prior-year SEC facts; revenue multiples withheld",
      }),
    ]);
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
                revenueTtm: 400,
                revenuePeriodMonths: 3,
                cash: 30,
                cashPeriodEnd: "2026-03-31",
                debt: 50,
                debtPeriodEnd: "2026-03-31",
                ...UNTAGGED_EV_BRIDGE,
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
