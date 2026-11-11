import { describe, expect, test } from "bun:test";
import { dedupeSourceGaps, sourceGap, sourceGapScopedReportText } from "../src/domain/source-gaps";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { classifyGap } from "../src/report/gap-triage";
import {
  addBusinessFrameworkEvidence,
  frameworkGapCode,
  frameworkGaps,
  QUALITATIVE_GAPS,
} from "../src/sources/extended-evidence/business-framework";
import {
  businessFrameworkMetrics,
  classifyBusinessLifecyclePhase,
} from "../src/sources/extended-evidence/business-framework-metrics";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "../src/sources/extended-evidence/valuation-comps";
import { renderMarkdownReport } from "../src/report/markdown";
import { CURRENT_EQUITY_NOTE } from "../src/sources/extended-evidence/enterprise-value-bridge";
import type { MarketSnapshot } from "../src/domain/market-data";
import { yoyDirection } from "../src/sources/extended-evidence/financial-lens-inputs";
import type {
  MetricInput,
  MetricResult,
  MetricSection,
} from "../src/sources/extended-evidence/metric-engine";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertBusinessFrameworkMetricInvariants } from "./support/run-fixtures/assertions";

const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;

const AS_OF = "2026-06-22T00:00:00.000Z";

function fact(val: number, fy: number, start: string, end: string, form = "10-K") {
  return {
    val,
    form,
    fp: form === "10-K" ? "FY" : "Q1",
    fy,
    filed: form === "10-K" ? `${String(fy + 1)}-02-15` : `${String(fy)}-05-01`,
    start,
    end,
  };
}

function annual(fy2024: number, fy2025: number) {
  return {
    units: {
      USD: [
        fact(fy2024, 2024, "2024-01-01", "2024-12-31"),
        fact(fy2025, 2025, "2025-01-01", "2025-12-31"),
      ],
    },
  };
}

function statements(concepts: Record<string, unknown>) {
  return deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "AAPL",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

const ANNUAL_STATEMENTS = statements({
  Revenues: annual(94.34, 100),
  GrossProfit: annual(40, 45),
  OperatingIncomeLoss: annual(22.2, 24),
  NetIncomeLoss: annual(17.14, 18),
  PaymentsOfDividends: annual(4, 5),
});

function lensMetric(
  id: string,
  value: number,
  sourceIds: readonly string[],
  periodEnd?: string,
): MetricResult {
  return {
    id,
    label: id,
    unit: "ratio",
    basis: "lens basis",
    status: "value",
    value,
    ...(periodEnd === undefined ? {} : { periodEnd }),
    inputs: [{ label: id, value, artifact: "statements", unit: "USD", sourceIds }],
    sourceIds,
  };
}

const LENS_SECTIONS: readonly MetricSection[] = [
  {
    id: "financial-lens-financial-strength",
    title: "Financial Lens: Financial Strength",
    metrics: [
      lensMetric("currentRatio", 1.5, ["extended-sec-edgar-aapl-fundamentals"], "2026-03-31"),
      lensMetric("debtToMarketCap", 0.1, ["market-aapl", "extended-sec-edgar-aapl-fundamentals"]),
    ],
  },
  {
    id: "financial-lens-value",
    title: "Financial Lens: Value",
    metrics: [
      lensMetric("evToAnnualizedRevenue", 6.2, [
        "market-aapl",
        "extended-sec-edgar-aapl-fundamentals",
      ]),
    ],
  },
];

function framework(
  existing: ExtendedEvidence = evidence(),
  generatedAt = AS_OF,
  financialStatements: ReturnType<typeof statements> | null = ANNUAL_STATEMENTS,
  lensSections: readonly MetricSection[] = LENS_SECTIONS,
) {
  return addBusinessFrameworkEvidence(
    command,
    [marketSnapshot({ sourceId: "market-aapl" })],
    existing,
    undefined,
    generatedAt,
    financialStatements ?? undefined,
    lensSections,
  );
}

function fyFact(val: number, fyear: number, start: string | undefined, end: string) {
  return {
    val,
    ...(start === undefined ? {} : { start }),
    end,
    form: "10-K",
    fy: fyear,
    fp: "FY",
    filed: `${String(fyear)}-11-01`,
  };
}

function gapOf(result: ReturnType<typeof framework>, id: string) {
  return result.metricSectionGaps?.find(({ source }) => source === id);
}

function metricOf(result: ReturnType<typeof framework>, sectionId: string, metricId: string) {
  return result.metricSections
    ?.find(({ id }) => id === sectionId)
    ?.metrics.find(({ id }) => id === metricId);
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
          revenuePeriodEnd: "2026-03-31",
          revenuePeriodMonths: 6,
          revenuePrior: 94,
          revenueDeltaPercent: 6,
          grossProfit: 45,
          grossProfitPeriodEnd: "2026-03-31",
          grossProfitPeriodMonths: 6,
          operatingIncome: 24,
          operatingIncomePeriodEnd: "2026-03-31",
          operatingIncomePeriodMonths: 6,
          operatingIncomePrior: 22,
          operatingIncomeDeltaPercent: 8,
          netIncome: 18,
          netIncomeDeltaPercent: 5,
          shareRepurchases: 10,
          currentAssetsPeriodEnd: "2026-03-31",
          currentLiabilitiesPeriodEnd: "2026-03-31",
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
          currentRatioPeriodEnd: "2026-03-31",
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
    expect(frameworkGaps("AAPL", [], "deep")).toEqual([]);
  });

  test("renders one object-shaped gap with the stable message", () => {
    // This exact producer format is parsed by frameworkGapCode.
    expect(frameworkGaps("AAPL", [analystConsensus], "deep")[0]?.message).toBe(
      "Business Framework partial for AAPL: analyst-consensus: Analyst consensus is not available from a provider-neutral authoritative capability",
    );
  });

  test("round-trips structured gap codes without interpreting legacy or unrelated gaps", () => {
    for (const expected of QUALITATIVE_GAPS) {
      expect(frameworkGapCode(frameworkGaps("AAPL", [expected], "deep")[0]!)).toBe(expected.code);
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
    expect(frameworkGapCode(frameworkGaps("AAPL", ["legacy qualitative gap"], "deep")[0]!)).toBe(
      undefined,
    );
  });

  test("renders multiple object-shaped gaps separately in input order", () => {
    const gaps = frameworkGaps("AAPL", [segmentMix, analystConsensus], "deep");

    expect(gaps.map((gap) => gap.message)).toEqual([
      "Business Framework partial for AAPL: segment-mix: Segment mix is not available from current normalized sources",
      "Business Framework partial for AAPL: analyst-consensus: Analyst consensus is not available from a provider-neutral authoritative capability",
    ]);
    expect(gaps.every((gap) => !gap.message.includes("; "))).toBe(true);
  });

  test("renders a legacy string-shaped gap without a code prefix", () => {
    expect(frameworkGaps("AAPL", ["legacy qualitative gap"], "deep")[0]?.message).toBe(
      "Business Framework partial for AAPL: legacy qualitative gap",
    );
  });

  test("renders mixed string and object-shaped gaps independently", () => {
    expect(
      frameworkGaps("AAPL", ["legacy qualitative gap", segmentMix], "deep").map(
        (gap) => gap.message,
      ),
    ).toEqual([
      "Business Framework partial for AAPL: legacy qualitative gap",
      "Business Framework partial for AAPL: segment-mix: Segment mix is not available from current normalized sources",
    ]);
  });

  test("keeps Source Gap context identical across split gaps", () => {
    for (const gap of frameworkGaps("AAPL", [segmentMix, analystConsensus], "deep")) {
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
    expect(dedupeSourceGaps(frameworkGaps("AAPL", QUALITATIVE_GAPS, "deep"))).toHaveLength(12);
  });

  test("keeps structured and report-text triage material", () => {
    const gap = frameworkGaps("AAPL", [analystConsensus], "deep")[0]!;

    expect(classifyGap(gap)).toBe("material");
    expect(classifyGap(sourceGapScopedReportText(gap))).toBe("material");
  });
});

const issuerYoyRow = (id: string, fields: Partial<MetricResult>): MetricResult => ({
  id,
  label: "Revenue change vs prior-year quarter",
  unit: "ratio-percent",
  basis: "(current − prior-year same period) / |prior-year same period|",
  status: "value",
  periodEnd: "2026-09-30",
  periodMonths: 3,
  inputs: [],
  sourceIds: ["web-x"],
  ...fields,
});

const issuerCell = (value: string, unit: string, periodEnd: string): MetricInput => ({
  label: "Revenue",
  value,
  artifact: "issuerReport",
  periodType: "interim",
  periodEnd,
  unit,
  currency: "MYR",
  sourceIds: ["web-x"],
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

  test("leaves the phase unclassified without revenue YoY or a falling revenue's income direction", () => {
    expect(
      classifyBusinessLifecyclePhase({ operatingIncome: 20, netIncome: 15, dividendYield: 0.02 }),
    ).toBeUndefined();
    expect(
      classifyBusinessLifecyclePhase({
        revenueDeltaPercent: -4,
        operatingIncome: 20,
        dividendYield: 0.02,
      }),
    ).toBeUndefined();
  });

  for (const phaseCase of phaseCases) {
    test(`classifies ${phaseCase.name}`, () => {
      expect(classifyBusinessLifecyclePhase(phaseCase.input)).toBe(phaseCase.expected);
    });
  }

  test("Risk counts the current ratio only while its balance-sheet period is current", () => {
    const risk = (generatedAt: string) =>
      framework(evidence(), generatedAt).artifact?.sections.find(({ name }) => name === "Risk");

    expect(risk(AS_OF)?.summary).toBe(
      "Risk criteria-supported (Current ratio 1.50x, Debt/market cap 10.0%)",
    );
    expect(
      metricOf(framework(evidence(), AS_OF), "business-framework-risk", "currentRatio"),
    ).toMatchObject({ status: "value", value: 1.5, periodEnd: "2026-03-31" });
    const staleAsOf = "2026-12-01T00:00:00.000Z";
    expect(risk(staleAsOf)?.summary).toBe("Risk criteria-supported (Debt/market cap 10.0%)");
    expect(
      metricOf(framework(evidence(), staleAsOf), "business-framework-risk", "currentRatio"),
    ).toMatchObject({ status: "missing", reason: "stale current ratio as of 2026-03-31" });
  });

  test("SEC-summary fallback reads the periods summarizeSecFundamentals writes", () => {
    const summarize = (revenueStarts: readonly (string | undefined)[]) => {
      const rows = (values: readonly number[], starts: readonly (string | undefined)[]) => [
        fyFact(values[0] ?? 0, 2024, starts[0], "2024-09-30"),
        fyFact(values[1] ?? 0, 2025, starts[1], "2025-09-30"),
      ];
      const concepts = {
        Revenues: rows([80, 100], revenueStarts),
        GrossProfit: rows([36, 45], ["2023-10-01", "2024-10-01"]),
      };
      const payload = {
        facts: {
          "us-gaap": Object.fromEntries(
            Object.entries(concepts).map(([concept, units]) => [
              concept,
              { units: { USD: units } },
            ]),
          ),
        },
      };
      const metrics = summarizeSecFundamentals(payload, AS_OF)?.metrics ?? {};
      const base = evidence();
      return framework(
        evidence({
          items: base.items.map((item) =>
            item.category === "sec-edgar" ? { ...item, metrics } : item,
          ),
        }),
        AS_OF,
        null,
      );
    };

    const dated = summarize(["2023-10-01", "2024-10-01"]);
    expect(metricOf(dated, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "value",
      value: 0.45,
      periodEnd: "2025-09-30",
      periodMonths: 12,
    });
    expect(metricOf(dated, "business-framework-growth", "revenueDeltaPercent")).toMatchObject({
      status: "value",
      periodEnd: "2025-09-30",
      periodMonths: 12,
    });
    const undated = summarize([undefined, undefined]);
    expect(metricOf(undated, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "missing",
    });
    expect(gapOf(undated, "business-framework-moat")).toBeDefined();
  });

  test("publishes a P/E on non-positive earnings as not meaningful with the raw value as input", () => {
    const base = evidence();
    const withYahoo = (metrics: Record<string, number>) =>
      framework(
        evidence({
          items: base.items.map((item) =>
            item.category === "yahoo-fundamentals" ? { ...item, metrics } : item,
          ),
        }),
      );
    const negative = withYahoo({ trailingPE: 24, epsTrailingTwelveMonths: -1, forwardPE: -40.02 });

    expect(metricOf(negative, "business-framework-valuation", "forwardPE")).toMatchObject({
      status: "not-meaningful",
      reason: "non-positive forward earnings",
      periodEnd: "2026-06-20T00:00:00.000Z",
      inputs: [expect.objectContaining({ key: "forwardPE", value: -40.02 })],
    });
    expect(metricOf(negative, "business-framework-valuation", "trailingPE")).toMatchObject({
      status: "not-meaningful",
      reason: "non-positive trailing earnings",
    });
    expect(
      metricOf(
        withYahoo({ trailingPE: 24, forwardPE: 21, epsForward: 2 }),
        "business-framework-valuation",
        "forwardPE",
      ),
    ).toMatchObject({ status: "value", value: 21 });
  });

  test("SEC-summary and evidence-backed values carry the period their own source publishes", () => {
    const periods: Record<string, Record<string, string | number>> = {
      "sec-edgar": { operatingIncomePeriodEnd: "2026-04-30", operatingIncomePeriodMonths: 6 },
      valuation: { revenuePeriodEnd: "2026-02-28", revenuePeriodMonths: 3 },
      "financial-lens": { debtToMarketCapPeriodEnd: "2025-12-31" },
    };
    const base = evidence();
    const dated = (extra: Record<string, Record<string, string | number>>) =>
      evidence({
        items: base.items.map((item) => ({
          ...item,
          metrics: { ...item.metrics, ...periods[item.category], ...extra[item.category] },
        })),
      });
    const period = (result: ReturnType<typeof framework>, sectionId: string, metricId: string) => {
      const metric = metricOf(result, sectionId, metricId);
      return [metric?.status, metric?.periodEnd, metric?.periodMonths];
    };
    const result = framework(dated({}), AS_OF, null);

    expect(period(result, "business-framework-growth", "revenueDeltaPercent")).toEqual([
      "value",
      "2026-03-31",
      6,
    ]);
    expect(period(result, "business-framework-moat", "grossMargin")).toEqual([
      "value",
      "2026-03-31",
      6,
    ]);
    expect(period(result, "business-framework-risk", "debtToMarketCap")).toEqual([
      "value",
      "2025-12-31",
      undefined,
    ]);
    expect(period(result, "business-framework-valuation", "evToAnnualizedRevenue")).toEqual([
      "value",
      "2026-02-28",
      12,
    ]);
    expect(period(result, "business-framework-valuation", "trailingPE")).toEqual([
      "value",
      "2026-06-20T00:00:00.000Z",
      undefined,
    ]);
    // A margin whose operands cannot be shown to share one span is withheld, not dated by either.
    expect(period(result, "business-framework-moat", "operatingMargin")).toEqual([
      "missing",
      undefined,
      undefined,
    ]);
    const undated = framework(
      dated({ "sec-edgar": { revenuePeriodMonths: "", grossProfitPeriodMonths: "" } }),
      AS_OF,
      null,
    );
    expect(metricOf(undated, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "missing",
      reason: "no same-period SEC gross profit and revenue",
    });
    expect(gapOf(undated, "business-framework-moat")).toBeDefined();
    expect(period(undated, "business-framework-growth", "revenueDeltaPercent")).toEqual([
      "value",
      "2026-03-31",
      undefined,
    ]);
  });

  test("derives seven framework sections, each backed by a Metric Section but Management", () => {
    const result = framework();

    expect(result.artifact?.version).toBe(3);
    expect(result.artifact?.phase).toBe("capital-return");
    expect(
      result.artifact?.sections.map(({ name, metricSectionIds }) => [name, metricSectionIds]),
    ).toEqual([
      ["Business", ["business-framework-business"]],
      ["Phase", ["business-framework-phase"]],
      ["Moat", ["business-framework-moat"]],
      ["Growth", ["business-framework-growth"]],
      ["Management", []],
      ["Risk", ["business-framework-risk"]],
      ["Valuation", ["business-framework-valuation"]],
    ]);
    expect(result.metricSections?.map(({ title }) => title)).toEqual([
      "Business Framework: Business",
      "Business Framework: Phase",
      "Business Framework: Moat",
      "Business Framework: Growth",
      "Business Framework: Risk",
      "Business Framework: Valuation",
    ]);
    expect(
      result.artifact?.sections.find((section) => section.name === "Management")?.posture,
    ).toBe("insufficient-data");
    expect(result.extendedEvidence?.items.at(-1)?.category).toBe("business-framework");
    expect(result.extendedEvidence?.items.at(-1)?.metrics).toEqual({
      phase: "capital-return",
      businessPosture: "criteria-supported",
      phasePosture: "criteria-supported",
      moatPosture: "criteria-supported",
      growthPosture: "criteria-supported",
      managementPosture: "insufficient-data",
      riskPosture: "criteria-supported",
      valuationPosture: "criteria-supported",
    });
    expect(result.artifact?.sections.find((section) => section.name === "Phase")?.summary).toBe(
      "Phase classification (Phase capital-return, Revenue YoY 6.0%)",
    );
    expect(metricOf(result, "business-framework-growth", "revenueDeltaPercent")).toMatchObject({
      status: "value",
      periodEnd: "2025-12-31",
      periodMonths: 12,
    });
    expect(result.sourceGaps).toHaveLength(12);
    expect(result.sourceGaps[0]).toEqual(
      expect.objectContaining({ source: "business-framework", evidenceQualityImpact: "no-cap" }),
    );
  });

  test.each(["brief", "deep"] as const)(
    "%s depth declares profile exclusions separately from unavailable analyst consensus",
    (depth) => {
      const result = addBusinessFrameworkEvidence(
        { ...command, depth },
        [],
        undefined,
        undefined,
        AS_OF,
      );
      expect(result.sourceGaps).toHaveLength(12);
      expect(result.extendedEvidence?.gaps).toEqual(result.sourceGaps);
      for (const gap of result.sourceGaps) {
        const excluded = depth === "brief" && frameworkGapCode(gap) !== "analyst-consensus";
        expect(gap.cause).toBe(excluded ? "suppressed-by-design" : "provider-data-missing");
        expect(gap.evidenceQualityImpact).toBe("no-cap");
        expect(
          gap.message.includes(
            "is not assessed at brief depth; filing prose and Web Subject Profile are excluded",
          ),
        ).toBe(excluded);
        expect(gap.message.includes("current normalized sources")).toBe(
          !excluded && frameworkGapCode(gap) !== "analyst-consensus",
        );
      }
      expect(result.artifact?.gaps).toHaveLength(12);
      for (const section of result.artifact!.sections) {
        for (const gap of section.gaps) {
          if (typeof gap === "string") {
            throw new TypeError("Expected coded qualitative gap");
          }
          expect(
            gap.text.includes(
              "is not assessed at brief depth; filing prose and Web Subject Profile are excluded",
            ),
          ).toBe(depth === "brief" && gap.code !== "analyst-consensus");
        }
      }
    },
  );

  test("anchors margins on the numerator period and keeps an interim latest fact's span", () => {
    const result = framework(
      evidence(),
      AS_OF,
      statements({
        Revenues: {
          units: {
            USD: [
              fact(100, 2025, "2025-01-01", "2025-12-31"),
              fact(30, 2026, "2026-01-01", "2026-03-31", "10-Q"),
            ],
          },
        },
        GrossProfit: { units: { USD: [fact(45, 2025, "2025-01-01", "2025-12-31")] } },
        OperatingIncomeLoss: { units: { USD: [fact(20, 2025, "2025-01-01", "2025-12-31")] } },
      }),
    );
    const moat = result.artifact?.sections.find((section) => section.name === "Moat");

    expect(moat?.posture).toBe("criteria-supported");
    expect(metricOf(result, "business-framework-moat", "grossMargin")?.value).toBe(0.45);
    expect(metricOf(result, "business-framework-moat", "operatingMargin")?.value).toBe(0.2);
    expect(metricOf(result, "business-framework-business", "revenue")).toMatchObject({
      value: 30,
      periodEnd: "2026-03-31",
      periodMonths: 3,
    });
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "AAPL",
        extras: { metricSections: result.metricSections },
      }),
    );
    expect(markdown).toContain(
      "### Business Framework: Business\n\n- Revenue: $30 (3-month period ending 2026-03-31;",
    );
    expect(markdown).toContain("- Gross margin: 45.0% (FY ending 2025-12-31;");
  });

  test("a never-filed gross profit is a diagnostic gap; an unmatched one stays material", () => {
    const base = {
      Revenues: annual(94.34, 100),
      OperatingIncomeLoss: annual(22.2, 24),
      NetIncomeLoss: annual(17.14, 18),
    };
    const unfiled = framework(evidence(), AS_OF, statements(base));
    const olderOnly = framework(
      evidence(),
      AS_OF,
      statements({
        ...base,
        GrossProfit: { units: { USD: [fact(40, 2023, "2023-01-01", "2023-12-31")] } },
      }),
    );

    expect(metricOf(unfiled, "business-framework-business", "grossProfit")).toMatchObject({
      status: "missing",
      reason: "gross profit not filed by the issuer",
      cause: "not-filed",
    });
    expect(metricOf(unfiled, "business-framework-moat", "grossMargin")?.cause).toBe("not-filed");
    expect(gapOf(unfiled, "business-framework-business")?.triage).toBe("diagnostic");
    expect(metricOf(olderOnly, "business-framework-moat", "grossMargin")?.cause).toBeUndefined();
    expect(gapOf(olderOnly, "business-framework-moat")?.triage).toBe("material");
    const filteredRevenue = framework(
      evidence(),
      AS_OF,
      statements({
        ...base,
        Revenues: { units: { USD: [fact(100, 2025, "2024-11-01", "2025-12-31")] } },
      }),
    );
    expect(metricOf(filteredRevenue, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual or interim revenue fact",
    });
    expect(gapOf(filteredRevenue, "business-framework-moat")?.triage).toBe("material");
    const negativeRevenue = framework(
      evidence(),
      AS_OF,
      statements({ ...base, Revenues: annual(-5, -10) }),
    );
    expect(metricOf(negativeRevenue, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "not-meaningful",
      reason: "revenue is not positive",
      periodEnd: "2025-12-31",
    });
    expect(metricOf(unfiled, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "missing",
      cause: "not-filed",
      periodEnd: "2025-12-31",
    });
  });

  // ORCL last tagged GrossProfit for FY ending 2018-05-31 (run 2026-10-31T11-27-34-541Z-6f265e0e).
  test("a gross profit series years older than the newest filed period is withheld as stale", () => {
    const filed = (val: number, start: string, end: string, form = "10-K") => ({
      ...fact(val, Number(end.slice(0, 4)), start, end, form),
      filed: "2026-09-28",
    });
    const revenue = {
      units: {
        USD: [
          filed(39.83, "2017-06-01", "2018-05-31"),
          filed(57.4, "2025-06-01", "2026-05-31"),
          filed(19.3, "2026-06-01", "2026-08-31", "10-Q"),
        ],
      },
    };
    const grossProfit = (start: string, end: string) => ({
      units: { USD: [filed(24.3, start, end)] },
    });
    const asOf = "2026-10-31T00:00:00.000Z";
    const derive = (gross: unknown) =>
      deriveFinancialStatements(
        { facts: { "us-gaap": { Revenues: revenue, GrossProfit: gross } } },
        {
          symbol: "ORCL",
          generatedAt: asOf,
          analysisAsOf: asOf,
          sourceId: "extended-sec-edgar-orcl-fundamentals",
        },
      );
    const stale = framework(evidence(), asOf, derive(grossProfit("2017-06-01", "2018-05-31")));
    const reason =
      "latest gross profit period ends 2018-05-31, more than a year before the newest filed period 2026-08-31";

    expect(metricOf(stale, "business-framework-business", "grossProfit")).toMatchObject({
      status: "missing",
      reason,
      periodEnd: "2018-05-31",
      sourceIds: ["extended-sec-edgar-orcl-fundamentals"],
    });
    expect(metricOf(stale, "business-framework-moat", "grossMargin")).toMatchObject({
      status: "missing",
      reason,
    });
    expect(gapOf(stale, "business-framework-business")?.triage).toBe("material");

    const fresh = framework(evidence(), asOf, derive(grossProfit("2025-06-01", "2026-05-31")));
    expect(metricOf(fresh, "business-framework-business", "grossProfit")).toMatchObject({
      status: "value",
      periodEnd: "2026-05-31",
    });
    expect(metricOf(fresh, "business-framework-moat", "grossMargin")?.status).toBe("value");
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
    const result = framework({
      ...baseEvidence,
      items: baseEvidence.items.map((item) =>
        item.category === "valuation"
          ? { ...item, metrics: { ...item.metrics, valuationSupportability: "not-meaningful" } }
          : item,
      ),
    });

    const valuation = result.artifact?.sections.find((section) => section.name === "Valuation");
    expect(valuation?.posture).toBe("insufficient-data");
    expect(
      result.metricSections?.find(({ id }) => id === "business-framework-valuation")?.metrics[0],
    ).toMatchObject({ id: "valuationCaveat", value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT });
    expect(valuation?.summary).toContain(REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT);
  });

  test("publishes EV/revenue as not meaningful below the revenue de-minimis floor", () => {
    // NBIS run 1c6c4809: FY2025 20-F (0001104659-26-052948, public 2026-04-30) revenue $529.8M against a $36.33B quote market cap.
    const sourceIds = ["market-aapl", "extended-sec-edgar-aapl-fundamentals"];
    const reason = "revenue below the 2% of market cap de-minimis floor";
    const baseEvidence = evidence();
    const result = framework(
      {
        ...baseEvidence,
        items: baseEvidence.items.map((item) =>
          item.category === "valuation"
            ? {
                ...item,
                metrics: {
                  ...item.metrics,
                  marketCap: 36_330_405_888,
                  annualizedRevenue: 529_800_000,
                  evToAnnualizedRevenue: 69.42,
                  revenuePeriodEnd: "2025-12-31",
                  valuationSupportability: "not-meaningful",
                },
              }
            : item,
        ),
      },
      AS_OF,
      ANNUAL_STATEMENTS,
      [
        {
          id: "financial-lens-value",
          title: "Financial Lens: Value",
          metrics: [
            {
              ...lensMetric("evToAnnualizedRevenue", 69.42, sourceIds),
              status: "not-meaningful",
              reason,
            },
          ],
        },
      ],
    );

    const metric = metricOf(result, "business-framework-valuation", "evToAnnualizedRevenue");
    expect(metric).toMatchObject({ status: "not-meaningful", reason, sourceIds });
  });

  test("carries the current-equity note on EV/revenue only when the valuation bridge used it", () => {
    const sourceIds = ["market-aapl", "extended-sec-edgar-aapl-fundamentals"];
    const lens: readonly MetricSection[] = [
      {
        id: "financial-lens-value",
        title: "Financial Lens: Value",
        metrics: [
          {
            ...lensMetric("evToAnnualizedRevenue", 6.2, sourceIds),
            inputs: [
              {
                label: "EV/revenue",
                value: 6.2,
                artifact: "evidence",
                category: "valuation",
                unit: "ratio",
                sourceIds,
              },
            ],
          },
        ],
      },
    ];
    const basisWith = (concept: string) => {
      const base = evidence();
      return metricOf(
        framework(
          {
            ...base,
            items: base.items.map((item) =>
              item.category === "valuation"
                ? { ...item, metrics: { ...item.metrics, shortTermInvestmentsConcept: concept } }
                : item,
            ),
          },
          AS_OF,
          ANNUAL_STATEMENTS,
          lens,
        ),
        "business-framework-valuation",
        "evToAnnualizedRevenue",
      )?.basis;
    };

    expect(basisWith("ShortTermInvestments + EquitySecuritiesFvNiCurrent")).toEndWith(
      `; ${CURRENT_EQUITY_NOTE}`,
    );
    expect(basisWith("ShortTermInvestments")).not.toContain(CURRENT_EQUITY_NOTE);
  });

  test("marks EV/revenue not-applicable for a depository issuer", () => {
    const baseEvidence = evidence();
    const result = framework({
      ...baseEvidence,
      items: baseEvidence.items.map((item) =>
        item.category === "sec-edgar"
          ? { ...item, metrics: { ...item.metrics, sic: "6021" } }
          : item,
      ),
    });

    expect(metricOf(result, "business-framework-valuation", "evToAnnualizedRevenue")?.status).toBe(
      "not-applicable",
    );
  });

  test("discloses missing source coverage instead of guessing", () => {
    const result = framework(
      { instrument: { symbol: "AAPL", assetClass: "equity" }, items: [], gaps: [] },
      AS_OF,
      null,
    );

    expect(result.artifact?.sections).toHaveLength(7);
    expect(result.artifact?.sections.find((section) => section.name === "Business")?.posture).toBe(
      "insufficient-data",
    );
    expect(metricOf(result, "business-framework-business", "revenue")).toMatchObject({
      status: "missing",
      reason: "financial statements unavailable",
    });
    expect(result.metricSectionGaps?.map(({ source, triage }) => [source, triage])).toEqual([
      ["business-framework-business", "material"],
      ["business-framework-phase", "material"],
      ["business-framework-moat", "material"],
      ["business-framework-growth", "material"],
      ["business-framework-risk", "material"],
      ["business-framework-valuation", "material"],
    ]);
    expect(
      result.artifact?.gaps.map((gap) => (typeof gap === "string" ? gap : gap.text)).join(" "),
    ).toContain("Management track record");
    expect(result.sourceGaps[0]?.cause).toBe("provider-data-missing");
  });

  test("compares YoY only against a year-aligned prior annual fact", () => {
    const yoy = (priorStart: string) =>
      metricOf(
        framework(
          evidence(),
          AS_OF,
          statements({
            Revenues: {
              units: {
                USD: [
                  fact(90, 2024, priorStart, "2024-12-31"),
                  fact(100, 2025, "2025-01-15", "2025-12-31"),
                ],
              },
            },
          }),
        ),
        "business-framework-growth",
        "revenueDeltaPercent",
      );

    expect(yoy("2024-01-26")?.status).toBe("missing");
    expect(yoy("2024-01-16")).toMatchObject({ status: "value" });
  });

  // NBIS FY2025 20-F and CECO FY2025 10-K endpoints, as (prior, latest).
  test.each([
    { prior: -641_400_000, latest: 82_500_000, reason: "prior-year operating income is negative" },
    { prior: 89_300_000, latest: -20_800_000, reason: "operating income turns negative" },
    {
      prior: -399_600_000,
      latest: -611_700_000,
      reason: "prior-year operating income is negative",
    },
    { prior: -4_100_000, latest: 121_400_000, reason: "prior-year operating income is negative" },
  ])(
    "YoY from $prior to $latest is not meaningful on the statement and summary paths",
    ({ prior, latest, reason }) => {
      const artifact = statements({ OperatingIncomeLoss: annual(prior, latest) });
      const canonical = withCanonicalFinancialLensInputs(undefined, artifact);
      for (const filed of [artifact, null]) {
        const metric = metricOf(
          framework(canonical, AS_OF, filed),
          "business-framework-growth",
          "operatingIncomeDeltaPercent",
        );
        expect(metric).toMatchObject({
          status: "not-meaningful",
          reason: `${reason} (${(prior / 1e6).toFixed(1)}M to ${(latest / 1e6).toFixed(1)}M)`,
          periodEnd: "2025-12-31",
        });
        expect(metric?.inputs.map(({ value }) => value)).toEqual([prior, latest]);
      }
    },
  );

  // RELL FY2026 10-K: operating income 968.0K on 54.6M prior revenue.
  test.each([
    { prior: 968_000, status: "not-meaningful" },
    { prior: 1_092_000, status: "value" },
  ])(
    "operating income YoY on a $prior base vs 54.6M revenue is $status on both paths",
    ({ prior, status }) => {
      const artifact = statements({
        Revenues: annual(54_600_000, 60_000_000),
        OperatingIncomeLoss: annual(prior, 5_112_000),
      });
      for (const filed of [artifact, null]) {
        const metric = metricOf(
          framework(withCanonicalFinancialLensInputs(undefined, artifact), AS_OF, filed),
          "business-framework-growth",
          "operatingIncomeDeltaPercent",
        );
        expect(metric?.status).toBe(status);
        if (status === "not-meaningful") {
          expect(metric?.inputs.map(({ value }) => value)).toEqual([prior, 5_112_000]);
          expect(metric?.reason).toBe(
            "prior-year operating income is below 2% of same-period revenue (968.0K of 54.6M)",
          );
        }
      }
    },
  );

  test("YoY between two positive endpoints keeps its value on both paths", () => {
    const artifact = statements({ Revenues: annual(91_500_000, 529_800_000) });
    for (const filed of [artifact, null]) {
      const metric = metricOf(
        framework(withCanonicalFinancialLensInputs(undefined, artifact), AS_OF, filed),
        "business-framework-growth",
        "revenueDeltaPercent",
      );
      expect(metric?.status).toBe("value");
      expect(metric?.value).toBeCloseTo(479.016_393_442_623, 9);
    }
  });

  test.each([
    { operatingIncome: [-10, -5], phase: "startup" },
    { operatingIncome: [10, -5], phase: "decline" },
  ])(
    "a falling revenue with operating income $operatingIncome classifies as $phase",
    ({ operatingIncome, phase }) => {
      const artifact = statements({
        Revenues: annual(100, 90),
        OperatingIncomeLoss: annual(operatingIncome[0]!, operatingIncome[1]!),
      });
      const result = framework(
        withCanonicalFinancialLensInputs(undefined, artifact),
        AS_OF,
        artifact,
      );
      expect(
        metricOf(result, "business-framework-growth", "operatingIncomeDeltaPercent")?.status,
      ).toBe("not-meaningful");
      expect(result.artifact?.phase).toBe(phase);
    },
  );

  test("keeps SEC summary values and classification when statements are absent", () => {
    const result = framework(evidence(), AS_OF, null);

    expect(metricOf(result, "business-framework-business", "revenue")).toMatchObject({
      status: "value",
      value: 100,
      currency: "USD",
    });
    expect(metricOf(result, "business-framework-moat", "grossMargin")?.value).toBeCloseTo(0.45);
    expect(metricOf(result, "business-framework-growth", "revenueDeltaPercent")?.value).toBeCloseTo(
      (6 / 94) * 100,
    );
    expect(result.artifact?.phase).toBe("capital-return");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "business-framework")
        ?.summary,
    ).toContain(
      "Business criteria-supported (Revenue $100, Gross profit $45, Operating income $24)",
    );
  });

  test("reads an issuer YoY direction from the figure row with the same declared unit", () => {
    const figure = (id: string, value: number, input: MetricInput): MetricResult =>
      issuerYoyRow(id, { unit: "currency", currency: "MYR", value, inputs: [input] });
    const thousandsQuarter = issuerCell("(1)", "MYR'000", "2026-09-30");
    const millionsYtd = issuerCell("(1)", "MYR million", "2026-09-30");
    const priorYtd = issuerCell("(0.5)", "MYR million", "2025-09-30");
    const result = businessFrameworkMetrics({
      symbol: "0097.KL",
      issuerReport: {
        id: "issuer-report",
        title: "Issuer report figures",
        metrics: [
          figure("issuer-report-revenue-quarter-2026-09-30", -1000, thousandsQuarter),
          figure("issuer-report-revenue-ytd-2026-09-30", -1_000_000, millionsYtd),
          figure("issuer-report-revenue-ytd-2025-09-30", -500_000, priorYtd),
          issuerYoyRow("issuer-report-revenue-yoy-ytd", {
            status: "not-meaningful",
            reason: "prior-year revenue is negative",
            periodMonths: 9,
            inputs: [millionsYtd, priorYtd],
          }),
        ],
      },
    });
    const revenue = result.sections.Growth?.metrics.find(({ id }) => id === "revenueDeltaPercent");
    expect(revenue?.inputs.map(({ value }) => value)).toEqual([-500_000, -1_000_000]);
    expect(yoyDirection(revenue)).toBe(-500_000);
  });

  test("issuer report YoY rows feed Growth only on the non-statement path, with their outcome", () => {
    const growth = (issuerRows: readonly MetricResult[], filed = false) =>
      businessFrameworkMetrics({
        symbol: "0097.KL",
        issuerReport: { id: "issuer-report", title: "Issuer report figures", metrics: issuerRows },
        ...(filed ? { statements: ANNUAL_STATEMENTS } : {}),
      }).sections.Growth?.metrics;
    const revenue = (rows: readonly MetricResult[]) =>
      growth(rows)?.find(({ id }) => id === "revenueDeltaPercent");

    expect(
      revenue([
        issuerYoyRow("issuer-report-revenue-yoy-quarter", {
          status: "missing",
          reason: "inputs are reported in different currencies",
        }),
      ]),
    ).toMatchObject({
      status: "missing",
      reason: "issuer report: inputs are reported in different currencies",
    });
    expect(
      revenue([
        issuerYoyRow("issuer-report-revenue-yoy-quarter", {
          status: "not-meaningful",
          reason: "prior-year figure is zero or negative",
        }),
      ]),
    ).toMatchObject({ status: "not-meaningful" });
    expect(
      revenue([
        issuerYoyRow("issuer-report-revenue-yoy-quarter", {
          label: "Revenue change vs prior-year quarter, continuing operations",
          value: 0.1,
        }),
      ]),
    ).toMatchObject({ label: "Revenue YoY, continuing operations", value: 10 });
    expect(
      growth([issuerYoyRow("issuer-report-revenue-yoy-quarter", { value: 0.1 })])?.find(
        ({ id }) => id === "netIncomeDeltaPercent",
      ),
    ).toMatchObject({
      status: "missing",
      reason:
        "no issuer report profit attributable to owners with a checked prior-year same-length comparative",
    });
    expect(
      growth([issuerYoyRow("issuer-report-revenue-yoy-quarter", { value: 0.9 })], true)?.find(
        ({ id }) => id === "revenueDeltaPercent",
      )?.inputs[0]?.artifact,
    ).toBe("statements");
  });

  test("SEC-only amounts carry the summary's USD unit, not a non-USD quote currency", () => {
    const result = addBusinessFrameworkEvidence(
      command,
      [
        marketSnapshot({
          sourceId: "market-aapl",
          identity: { quoteCurrency: "EUR" } as NonNullable<MarketSnapshot["identity"]>,
        }),
      ],
      evidence(),
      undefined,
      AS_OF,
    );

    expect(metricOf(result, "business-framework-business", "revenue")?.currency).toBe("USD");
    expect(metricOf(result, "business-framework-phase", "shareRepurchases")?.currency).toBe("USD");
  });

  test("fixture invariants accept SEC-summary pass-through metrics", () => {
    const result = framework(evidence(), AS_OF, null);
    const sections = result.metricSections ?? [];
    const sourceIds = new Set(
      sections.flatMap(({ metrics }) => metrics.flatMap((m) => m.sourceIds)),
    );
    const report = researchReport({
      jobType: "equity",
      symbol: "AAPL",
      sources: [...sourceIds].map((id) => ({
        id,
        title: id,
        fetchedAt: AS_OF,
        kind: "extended-evidence",
        assetClass: "equity",
      })),
      dataGaps: (result.metricSectionGaps ?? []).map((gap) => `${gap.source}: ${gap.message}`),
      extras: { metricSections: [...LENS_SECTIONS, ...sections] },
    });
    const run = (metricSections: typeof sections) => () =>
      assertBusinessFrameworkMetricInvariants(
        {
          collectedSources: collectedSources({
            sourceGaps: result.metricSectionGaps ?? [],
            ...(result.artifact !== undefined ? { businessFramework: result.artifact } : {}),
            ...(result.extendedEvidence !== undefined
              ? { extendedEvidence: result.extendedEvidence }
              : {}),
          }),
          markdown: renderMarkdownReport(report),
        },
        { ...report, extras: { metricSections: [...LENS_SECTIONS, ...metricSections] } },
      );
    const forged = sections.map((section) => ({
      ...section,
      metrics: section.metrics.map((metric) =>
        metric.id === "grossMargin" && metric.status === "value"
          ? { ...metric, value: 0.5 }
          : metric,
      ),
    }));

    const mutateDebt = (patch: Partial<MetricResult>) =>
      sections.map((section) => ({
        ...section,
        metrics: section.metrics.map((metric) =>
          metric.id === "debtToMarketCap" ? ({ ...metric, ...patch } as MetricResult) : metric,
        ),
      }));

    expect(metricOf(result, "business-framework-moat", "grossMargin")?.inputs).toHaveLength(2);
    expect(metricOf(result, "business-framework-risk", "debtToMarketCap")?.status).toBe("value");
    expect(run(sections)).not.toThrow();
    expect(run(forged)).toThrow();
    expect(run(mutateDebt({ sourceIds: [] }))).toThrow();
    expect(run(mutateDebt({ sourceIds: ["extended-sec-edgar-aapl-filings"] }))).toThrow();
    expect(run(mutateDebt({ value: 987_654 }))).toThrow();
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

test("pass-through risk metrics preserve never-filed causes", () => {
  const input = evidence();
  const withoutRiskValues = {
    ...input,
    items: input.items.map((item) =>
      item.category === "financial-lens" ? { ...item, metrics: {} } : item,
    ),
  };
  const result = framework(withoutRiskValues, AS_OF, statements({ Revenues: annual(94, 100) }));
  for (const id of ["currentRatio", "debtToMarketCap"]) {
    expect(metricOf(result, "business-framework-risk", id)).toMatchObject({
      status: "missing",
      cause: "not-filed",
      reason: expect.stringContaining("not filed by the issuer"),
    });
  }
  expect(gapOf(result, "business-framework-risk")?.triage).toBe("diagnostic");
});

test("pass-through lens values cite the lens metric's inputs, never the lens bundle", () => {
  const peerIds = ["market-yahoo-equity-nvda", "extended-sec-edgar-nvda-fundamentals"];
  const input = evidence();
  const widened = {
    ...input,
    items: input.items.map((item) =>
      item.category === "financial-lens" || item.category === "valuation"
        ? {
            ...item,
            sourceIds: [...item.sourceIds, ...peerIds],
            ...(item.category === "valuation"
              ? { metrics: { ...item.metrics, revenuePeriodEnd: "2026-03-28" } }
              : {}),
          }
        : item,
    ),
  };
  const result = framework(widened);
  for (const [sectionId, id, lensSection] of [
    ["business-framework-risk", "currentRatio", 0],
    ["business-framework-risk", "debtToMarketCap", 0],
    ["business-framework-valuation", "evToAnnualizedRevenue", 1],
  ] as const) {
    const lens = LENS_SECTIONS[lensSection]?.metrics.find((metric) => metric.id === id);
    expect(metricOf(result, sectionId, id)).toMatchObject({
      status: "value",
      inputs: lens?.inputs,
      sourceIds: lens?.sourceIds,
    });
  }

  const uncited = framework(widened, AS_OF, ANNUAL_STATEMENTS, []);
  expect(metricOf(uncited, "business-framework-risk", "currentRatio")).toMatchObject({
    status: "missing",
    reason: "no cited financial-lens current ratio",
    inputs: [],
    sourceIds: [],
  });
  expect(gapOf(uncited, "business-framework-risk")?.message).toContain(
    "no cited financial-lens current ratio",
  );
});

test("cited dividend yield without revenue YoY leaves the phase unclassified", () => {
  const yahoo = {
    category: "yahoo-fundamentals",
    title: "AAPL Yahoo Fundamentals Evidence",
    summary: "Yahoo Fundamentals.",
    sourceIds: ["market-aapl"],
    observedAt: "2026-06-20T00:00:00.000Z",
    metrics: { dividendYield: 1.2 },
  } as const;
  const result = framework({ items: [yahoo], gaps: [] }, AS_OF, null);
  expect(metricOf(result, "business-framework-phase", "phase")).toMatchObject({
    status: "missing",
    reason: "Revenue YoY missing, so no lifecycle phase is classified",
  });
  expect(result.artifact?.phase).toBeUndefined();
});

test("phase with no classification inputs is missing rather than an uncited value", () => {
  const result = framework({ items: [], gaps: [] }, AS_OF, null);
  expect(metricOf(result, "business-framework-phase", "phase")).toMatchObject({
    status: "missing",
    reason: "no cited lifecycle classification inputs",
  });
  expect(gapOf(result, "business-framework-phase")?.message).toContain(
    "no cited lifecycle classification inputs",
  );
});

function series(...facts: readonly unknown[]) {
  return { units: { USD: facts } };
}

describe("phase inputs share the revenue YoY period", () => {
  const asOf = "2026-10-31T00:00:00.000Z";
  const filed = (val: number, start: string, end: string, form = "10-Q") => ({
    ...fact(val, Number(end.slice(0, 4)), start, end, form),
    filed: "2026-09-28",
  });
  const phaseOf = (concepts: Record<string, unknown>) => {
    const derived = deriveFinancialStatements(
      { facts: { "us-gaap": concepts } },
      {
        symbol: "AAPL",
        generatedAt: asOf,
        analysisAsOf: asOf,
        sourceId: "extended-sec-edgar-aapl-fundamentals",
      },
    );
    const result = framework(evidence(), asOf, derived);
    const metric = metricOf(result, "business-framework-phase", "phase");
    const inputs = metric?.inputs ?? [];
    return {
      phase: result.artifact?.phase,
      metric,
      gap: gapOf(result, "business-framework-phase")?.message,
      periods: new Set(
        inputs.flatMap((input) =>
          input.periodKey === undefined ? [] : [`${input.periodKey}|${String(input.periodType)}`],
        ),
      ),
      series: new Set(inputs.map((input) => input.series)),
    };
  };
  const keelRevenue = series(
    filed(200, "2024-01-01", "2024-12-31", "10-K"),
    filed(180, "2025-01-01", "2025-12-31", "10-K"),
    filed(47.651, "2025-01-01", "2025-03-31"),
    filed(36.992, "2026-01-01", "2026-03-31"),
  );

  // KEEL run 2026-11-05T11-03-17-174Z-d8ee4c0c: Q1 revenue beside 6M income.
  test("an interim revenue anchors income on the same quarter, not a newer YTD", () => {
    const result = phaseOf({
      Revenues: keelRevenue,
      OperatingIncomeLoss: series(
        filed(-34.841, "2025-01-01", "2025-03-31"),
        filed(-98.388, "2026-01-01", "2026-03-31"),
        filed(-100, "2025-01-01", "2025-06-30"),
        filed(-239.2, "2026-01-01", "2026-06-30"),
      ),
      NetIncomeLoss: series(
        filed(-55.553, "2025-01-01", "2025-03-31"),
        filed(-145.353, "2026-01-01", "2026-03-31"),
        filed(-90, "2025-01-01", "2025-06-30"),
        filed(-210.3, "2026-01-01", "2026-06-30"),
      ),
    });

    expect(result.phase).toBe("decline");
    expect([...result.periods].toSorted()).toEqual([
      "duration:3|2025-03-31|interim",
      "duration:3|2026-03-31|interim",
    ]);
    expect(result.series).toEqual(new Set(["revenue", "operatingIncome", "netIncome"]));
  });

  // CLSK run 2026-11-05T10-45-16-771Z-df74b0c2: FY revenue beside 9M income.
  test("an annual revenue anchors income on the same fiscal year", () => {
    const result = phaseOf({
      Revenues: series(
        filed(378.968, "2023-10-01", "2024-09-30", "10-K"),
        filed(766.314, "2024-10-01", "2025-09-30", "10-K"),
      ),
      OperatingIncomeLoss: series(
        filed(-149.043, "2023-10-01", "2024-09-30", "10-K"),
        filed(318.949, "2024-10-01", "2025-09-30", "10-K"),
        filed(200, "2024-10-01", "2025-06-30"),
        filed(-894.6, "2025-10-01", "2026-06-30"),
      ),
      NetIncomeLoss: series(
        filed(-145.777, "2023-10-01", "2024-09-30", "10-K"),
        filed(364.464, "2024-10-01", "2025-09-30", "10-K"),
        filed(250, "2024-10-01", "2025-06-30"),
        filed(-996.9, "2025-10-01", "2026-06-30"),
      ),
    });

    expect(result.phase).toBe("hyper-growth");
    expect([...result.periods].toSorted()).toEqual([
      "duration:12|2024-09-30|annual",
      "duration:12|2025-09-30|annual",
    ]);
  });

  // Before alignment the newer 6M income read as rising and the label was operating-leverage.
  test("a falling revenue with no same-period income YoY withholds the phase", () => {
    const result = phaseOf({
      Revenues: series(
        filed(100, "2025-01-01", "2025-03-31"),
        filed(90, "2026-01-01", "2026-03-31"),
      ),
      OperatingIncomeLoss: series(
        filed(10, "2025-01-01", "2025-06-30"),
        filed(20, "2026-01-01", "2026-06-30"),
      ),
      NetIncomeLoss: series(
        filed(8, "2025-01-01", "2025-06-30"),
        filed(16, "2026-01-01", "2026-06-30"),
      ),
    });
    const reason =
      "income YoY direction unknown beside a falling revenue (no operating income for the revenue period ending 2026-03-31; no net income for the revenue period ending 2026-03-31), so no lifecycle phase is classified";

    expect(result.phase).toBeUndefined();
    expect(result.metric).toMatchObject({ status: "missing", reason });
    expect(result.gap).toContain(reason);
  });

  test("a missing revenue YoY still names the income it could not read", () => {
    const result = phaseOf({
      Revenues: series(filed(90, "2026-01-01", "2026-03-31")),
      OperatingIncomeLoss: series(filed(20, "2026-01-01", "2026-06-30")),
    });

    expect(result.metric).toMatchObject({
      status: "missing",
      reason: expect.stringContaining(
        "(no operating income for the revenue period ending 2026-03-31;",
      ),
    });
  });

  test("a published phase names the income it could not read for the revenue period", () => {
    const result = phaseOf({
      Revenues: series(
        filed(50, "2025-01-01", "2025-03-31"),
        filed(80, "2026-01-01", "2026-03-31"),
      ),
      OperatingIncomeLoss: series(filed(-239.2, "2026-01-01", "2026-06-30")),
    });

    expect(result.phase).toBe("hyper-growth");
    expect(result.metric?.basis).toContain(
      "; no operating income for the revenue period ending 2026-03-31",
    );
    expect(result.series).toEqual(new Set(["revenue"]));
  });
});
