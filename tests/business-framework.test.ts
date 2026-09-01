import { describe, expect, test } from "bun:test";
import { dedupeSourceGaps, sourceGap, sourceGapScopedReportText } from "../src/domain/source-gaps";
import type { ExtendedEvidence } from "../src/domain/types";
import { classifyGap } from "../src/report/gap-triage";
import {
  addBusinessFrameworkEvidence,
  classifyBusinessLifecyclePhase,
  frameworkGapCode,
  frameworkGaps,
  QUALITATIVE_GAPS,
} from "../src/sources/extended-evidence/business-framework";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "../src/sources/extended-evidence/valuation-comps";
import { marketSnapshot } from "./support/fixtures";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

function jsonRoundTrip<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

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

describe("frameworkGaps", () => {
  const analystConsensus = QUALITATIVE_GAPS.find((gap) => gap.code === "analyst-consensus")!;
  const segmentMix = QUALITATIVE_GAPS.find((gap) => gap.code === "segment-mix")!;

  test("returns an empty list for no Business Framework gaps", () => {
    expect(frameworkGaps("AAPL", [])).toEqual([]);
  });

  test("renders one object-shaped gap with the golden-stable message", () => {
    // This exact producer format is parsed by frameworkGapCode.
    expect(frameworkGaps("AAPL", [analystConsensus])[0]?.message).toBe(
      "Business Framework partial for AAPL: analyst-consensus: Analyst consensus is not available from a provider-neutral authoritative capability",
    );
  });

  test("round-trips structured gap codes without interpreting legacy or unrelated gaps", () => {
    for (const expected of QUALITATIVE_GAPS) {
      expect(frameworkGapCode(frameworkGaps("AAPL", [expected])[0]!)).toBe(expected.code);
    }
    expect(frameworkGapCode(sourceGap({ source: "sec-edgar", message: "unavailable" }))).toBe(
      undefined,
    );
    expect(
      frameworkGapCode(
        sourceGap({
          source: "business-framework",
          message: "Business Framework partial for AAPL: not-a-code: text",
        }),
      ),
    ).toBe(undefined);
    expect(frameworkGapCode(frameworkGaps("AAPL", ["legacy qualitative gap"])[0]!)).toBe(undefined);
  });

  test("renders multiple object-shaped gaps separately in input order", () => {
    const gaps = frameworkGaps("AAPL", [segmentMix, analystConsensus]);

    expect(gaps.map((gap) => gap.message)).toEqual([
      "Business Framework partial for AAPL: segment-mix: Segment mix is not available from current normalized sources",
      "Business Framework partial for AAPL: analyst-consensus: Analyst consensus is not available from a provider-neutral authoritative capability",
    ]);
    expect(gaps.every((gap) => !gap.message.includes("; "))).toBe(true);
  });

  test("renders a legacy string-shaped gap without a code prefix", () => {
    expect(frameworkGaps("AAPL", ["legacy qualitative gap"])[0]?.message).toBe(
      "Business Framework partial for AAPL: legacy qualitative gap",
    );
  });

  test("renders mixed string and object-shaped gaps independently", () => {
    expect(
      frameworkGaps("AAPL", ["legacy qualitative gap", segmentMix]).map((gap) => gap.message),
    ).toEqual([
      "Business Framework partial for AAPL: legacy qualitative gap",
      "Business Framework partial for AAPL: segment-mix: Segment mix is not available from current normalized sources",
    ]);
  });

  test("keeps Source Gap context identical across split gaps", () => {
    for (const gap of frameworkGaps("AAPL", [segmentMix, analystConsensus])) {
      expect(gap).toMatchObject({
        source: "business-framework",
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      });
      expect(gap).not.toHaveProperty("symbol");
      expect(gap).not.toHaveProperty("triage");
      expect(gap).not.toHaveProperty("attempts");
    }
  });

  test("adds no Source Gaps for an out-of-scope fully populated evidence set", () => {
    const existing = evidence();
    const result = addBusinessFrameworkEvidence(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      [],
      existing,
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    expect(result.sourceGaps).toEqual([]);
    expect(result.extendedEvidence?.gaps).toEqual([]);
  });

  test("keeps all twelve Business Framework gaps after dedupe", () => {
    expect(dedupeSourceGaps(frameworkGaps("AAPL", QUALITATIVE_GAPS))).toHaveLength(12);
  });

  test("keeps structured and report-text triage material", () => {
    const gap = frameworkGaps("AAPL", [analystConsensus])[0]!;

    expect(classifyGap(gap)).toBe("material");
    expect(classifyGap(sourceGapScopedReportText(gap))).toBe("material");
  });
});

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
    expect(result.sourceGaps).toHaveLength(12);
    expect(result.sourceGaps[0]).toEqual(
      expect.objectContaining({
        source: "business-framework",
        evidenceQualityImpact: "no-cap",
      }),
    );
  });

  test("uses persisted common-period margins when standalone flow facts diverge", () => {
    const artifact = deriveFinancialStatements(
      {
        facts: {
          "us-gaap": {
            Revenues: {
              units: {
                USD: [
                  {
                    val: 100,
                    form: "10-K",
                    fp: "FY",
                    fy: 2025,
                    filed: "2026-02-15",
                    start: "2025-01-01",
                    end: "2025-12-31",
                  },
                  {
                    val: 30,
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
            GrossProfit: {
              units: {
                USD: [
                  {
                    val: 45,
                    form: "10-K",
                    fp: "FY",
                    fy: 2025,
                    filed: "2026-02-15",
                    start: "2025-01-01",
                    end: "2025-12-31",
                  },
                ],
              },
            },
            OperatingIncomeLoss: {
              units: {
                USD: [
                  {
                    val: 20,
                    form: "10-K",
                    fp: "FY",
                    fy: 2025,
                    filed: "2026-02-15",
                    start: "2025-01-01",
                    end: "2025-12-31",
                  },
                ],
              },
            },
          },
        },
      },
      {
        symbol: "AAPL",
        generatedAt: "2026-06-22T00:00:00.000Z",
        analysisAsOf: "2026-06-22T00:00:00.000Z",
        sourceId: "extended-sec-edgar-aapl-fundamentals",
      },
    );
    const canonicalEvidence = jsonRoundTrip<ExtendedEvidence>(
      withCanonicalFinancialLensInputs(undefined, artifact),
    );
    const secItem = canonicalEvidence.items.find((item) => item.category === "sec-edgar");

    expect(secItem?.metrics).toMatchObject({
      revenue: 30,
      revenuePeriodEnd: "2026-03-31",
      grossProfit: 45,
      grossProfitPeriodEnd: "2025-12-31",
      grossMarginSelectedValue: 0.45,
      grossMarginSelectedPeriodEnd: "2025-12-31",
      operatingMarginSelectedValue: 0.2,
      operatingMarginSelectedPeriodEnd: "2025-12-31",
    });

    const result = addBusinessFrameworkEvidence(
      command,
      [marketSnapshot({ sourceId: "market-aapl" })],
      canonicalEvidence,
      undefined,
      "2026-06-22T00:00:00.000Z",
    );
    const moat = result.artifact?.sections.find((section) => section.name === "Moat");

    expect(moat?.posture).toBe("criteria-supported");
    expect(moat?.metrics.find((metric) => metric.key === "grossMargin")?.value).toBe(0.45);
    expect(moat?.metrics.find((metric) => metric.key === "operatingMargin")?.value).toBe(0.2);
  });

  test("keeps lifecycle classification on parent-attributable net income", () => {
    expect(
      classifyBusinessLifecyclePhase({
        revenueDeltaPercent: 20,
        operatingIncome: 0,
        netIncome: -1,
      }),
    ).toBe("startup");
  });

  test("renders not-meaningful revenue supportability as a Valuation-section caveat", () => {
    const baseEvidence = evidence();
    const result = addBusinessFrameworkEvidence(
      command,
      [marketSnapshot({ sourceId: "market-aapl" })],
      {
        ...baseEvidence,
        items: baseEvidence.items.map((item) =>
          item.category === "valuation"
            ? {
                ...item,
                metrics: {
                  ...item.metrics,
                  valuationSupportability: "not-meaningful",
                },
              }
            : item,
        ),
      },
      undefined,
      "2026-06-22T00:00:00.000Z",
    );

    const valuation = result.artifact?.sections.find((section) => section.name === "Valuation");
    expect(valuation?.posture).toBe("insufficient-data");
    expect(valuation?.metrics[0]).toMatchObject({
      key: "valuationCaveat",
      value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
    });
    expect(valuation?.summary).toContain(REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT);
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
    expect(
      result.artifact?.gaps.map((gap) => (typeof gap === "string" ? gap : gap.text)).join(" "),
    ).toContain("Management track record");
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
