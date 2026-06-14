import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { marketSnapshot } from "./support/fixtures";

const command = { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

const baseExtendedEvidence: ExtendedEvidence = {
  instrument: { symbol: "AAPL", assetClass: "equity" },
  items: [
    {
      category: "sec-edgar",
      title: "AAPL SEC Fundamental Evidence",
      summary: "SEC Fundamental Evidence.",
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
      observedAt: "2026-05-18T00:00:00.000Z",
      metrics: {
        revenue: 100,
        cash: 30,
        debt: 50,
      },
    },
  ],
  gaps: [],
};

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
        latestQuarterRevenue: 100,
        annualizedLatestQuarterRevenue: 400,
        evToAnnualizedRevenue: 2.55,
        marketCapToAnnualizedRevenue: 2.5,
        debtToMarketCap: 0.05,
        netDebtToMarketCap: 0.02,
      },
    });
    expect(valuation?.summary).toContain(
      "market cap $1000, enterprise value $1020, annualized latest-quarter revenue $400",
    );
    expect(valuation?.summary).toContain("EV/annualized revenue 2.55x");
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
