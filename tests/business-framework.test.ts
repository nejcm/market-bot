import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import {
  addBusinessFrameworkEvidence,
  classifyBusinessLifecyclePhase,
} from "../src/sources/extended-evidence/business-framework";
import { marketSnapshot } from "./support/fixtures";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

function evidence(overrides: Partial<ExtendedEvidence> = {}): ExtendedEvidence {
  return {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "AAPL SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-06-20T00:00:00.000Z",
        metrics: {
          revenue: 100,
          revenueDeltaPercent: 6,
          grossProfit: 45,
          operatingIncome: 24,
          operatingIncomeDeltaPercent: 8,
          netIncome: 18,
          netIncomeDeltaPercent: 5,
          shareRepurchases: 10,
        },
      },
      {
        category: "yahoo-fundamentals",
        title: "AAPL Yahoo Fundamentals Evidence",
        summary: "Yahoo Fundamentals.",
        sourceIds: ["market-aapl"],
        observedAt: "2026-06-20T00:00:00.000Z",
        metrics: {
          trailingPE: 24,
          forwardPE: 21,
        },
      },
      {
        category: "valuation",
        title: "AAPL Valuation Evidence",
        summary: "Valuation Evidence.",
        sourceIds: ["market-aapl", "extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-06-21T00:00:00.000Z",
        metrics: {
          evToAnnualizedRevenue: 6.2,
          valuationSupportability: "supported",
        },
      },
      {
        category: "financial-lens",
        title: "AAPL Financial Lens Evidence",
        summary: "Financial Lens Evidence.",
        sourceIds: ["market-aapl", "extended-sec-edgar-aapl-fundamentals"],
        observedAt: "2026-06-21T00:00:00.000Z",
        metrics: {
          currentRatio: 1.5,
          debtToMarketCap: 0.1,
        },
      },
    ],
    gaps: [],
    ...overrides,
  };
}

describe("business framework evidence", () => {
  const phaseCases = [
    {
      name: "decline when revenue and income are contracting",
      input: { revenueDeltaPercent: -4, operatingIncomeDeltaPercent: -2 },
      expected: "decline",
    },
    {
      name: "hyper-growth at the 30 percent revenue threshold",
      input: { revenueDeltaPercent: 30, operatingIncome: -2, netIncome: -1 },
      expected: "hyper-growth",
    },
    {
      name: "capital return from SEC share repurchases",
      input: { revenueDeltaPercent: 5, operatingIncome: 20, netIncome: 15, shareRepurchases: 100 },
      expected: "capital-return",
    },
    {
      name: "capital return from dividends paid at the 15 percent growth boundary",
      input: { revenueDeltaPercent: 15, operatingIncome: 20, netIncome: 15, dividendsPaid: -8 },
      expected: "capital-return",
    },
    {
      name: "capital return from Yahoo dividend yield",
      input: { revenueDeltaPercent: 0, operatingIncome: 20, netIncome: 15, dividendYield: 0.01 },
      expected: "capital-return",
    },
    {
      name: "startup when income metrics are not yet positive",
      input: { revenueDeltaPercent: 20, operatingIncome: 0, netIncome: -1 },
      expected: "startup",
    },
    {
      name: "operating leverage as the mature fallback",
      input: { revenueDeltaPercent: 16, operatingIncome: 20, netIncome: 15 },
      expected: "operating-leverage",
    },
  ] as const;

  for (const phaseCase of phaseCases) {
    test(`classifies ${phaseCase.name}`, () => {
      expect(classifyBusinessLifecyclePhase(phaseCase.input)).toBe(phaseCase.expected);
    });
  }

  test("derives seven neutral framework sections and a sidecar artifact", () => {
    const result = addBusinessFrameworkEvidence(
      command,
      [marketSnapshot({ sourceId: "market-aapl" })],
      evidence(),
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact?.phase).toBe("capital-return");
    expect(result.artifact?.sections.map((section) => section.name)).toEqual([
      "Business",
      "Phase",
      "Moat",
      "Growth",
      "Management",
      "Risk",
      "Valuation",
    ]);
    expect(
      result.artifact?.sections.find((section) => section.name === "Management")?.posture,
    ).toBe("insufficient-data");
    expect(result.extendedEvidence?.items.at(-1)?.category).toBe("business-framework");
    expect(result.extendedEvidence?.items.at(-1)?.metrics?.phase).toBe("capital-return");
    expect(result.artifact?.sections.find((section) => section.name === "Phase")?.summary).toBe(
      "Phase classification (Phase capital-return, Revenue YoY 6.0%, Share repurchases $10)",
    );
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "business-framework",
        evidenceQualityImpact: "no-cap",
      }),
    ]);
  });

  test("discloses missing source coverage instead of guessing", () => {
    const result = addBusinessFrameworkEvidence(
      command,
      [marketSnapshot({ sourceId: "market-aapl" })],
      { instrument: { symbol: "AAPL", assetClass: "equity" }, items: [], gaps: [] },
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact?.sections).toHaveLength(7);
    expect(result.artifact?.sections.find((section) => section.name === "Business")?.posture).toBe(
      "insufficient-data",
    );
    expect(result.artifact?.gaps.join(" ")).toContain("Management track record");
    expect(result.sourceGaps[0]?.cause).toBe("provider-data-missing");
  });

  test("returns evidence unchanged for non-equity commands", () => {
    const existing = evidence();
    const result = addBusinessFrameworkEvidence(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      [],
      existing,
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.artifact).toBeUndefined();
    expect(result.sourceGaps).toEqual([]);
    expect(result.extendedEvidence).toBe(existing);
  });
});
