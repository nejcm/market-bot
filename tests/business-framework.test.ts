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
import { classifyBusinessLifecyclePhase } from "../src/sources/extended-evidence/business-framework-metrics";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "../src/sources/extended-evidence/valuation-comps";
import { renderMarkdownReport } from "../src/report/markdown";
import type { MarketSnapshot } from "../src/domain/market-data";
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

function framework(
  existing: ExtendedEvidence = evidence(),
  generatedAt = AS_OF,
  financialStatements: ReturnType<typeof statements> | null = ANNUAL_STATEMENTS,
) {
  return addBusinessFrameworkEvidence(
    command,
    [marketSnapshot({ sourceId: "market-aapl" })],
    existing,
    undefined,
    generatedAt,
    financialStatements ?? undefined,
  );
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
          revenueDeltaPercent: 6,
          grossProfit: 45,
          operatingIncome: 24,
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
    expect(frameworkGaps("AAPL", [])).toEqual([]);
  });

  test("renders one object-shaped gap with the stable message", () => {
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

  test("Risk counts the current ratio only while its balance-sheet period is current", () => {
    const risk = (generatedAt: string) =>
      framework(evidence(), generatedAt).artifact?.sections.find(({ name }) => name === "Risk");

    expect(risk(AS_OF)?.summary).toBe(
      "Risk criteria-supported (Current ratio 1.50x, Debt/market cap 10.0%)",
    );
    const staleAsOf = "2026-12-01T00:00:00.000Z";
    expect(risk(staleAsOf)?.summary).toBe("Risk criteria-supported (Debt/market cap 10.0%)");
    expect(
      metricOf(framework(evidence(), staleAsOf), "business-framework-risk", "currentRatio"),
    ).toMatchObject({ status: "missing", reason: "stale current ratio as of 2026-03-31" });
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

  test("keeps SEC summary values and classification when statements are absent", () => {
    const result = framework(evidence(), AS_OF, null);

    expect(metricOf(result, "business-framework-business", "revenue")).toMatchObject({
      status: "value",
      value: 100,
      currency: "USD",
    });
    expect(metricOf(result, "business-framework-moat", "grossMargin")?.value).toBeCloseTo(0.45);
    expect(metricOf(result, "business-framework-growth", "revenueDeltaPercent")?.value).toBe(6);
    expect(result.artifact?.phase).toBe("capital-return");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "business-framework")
        ?.summary,
    ).toContain(
      "Business criteria-supported (Revenue $100, Gross profit $45, Operating income $24)",
    );
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
      extras: { metricSections: sections },
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
        { ...report, extras: { metricSections } },
      );
    const forged = sections.map((section) => ({
      ...section,
      metrics: section.metrics.map((metric) =>
        metric.id === "grossMargin" && metric.status === "value"
          ? { ...metric, value: 0.5 }
          : metric,
      ),
    }));

    expect(metricOf(result, "business-framework-moat", "grossMargin")?.inputs).toHaveLength(2);
    expect(run(sections)).not.toThrow();
    expect(run(forged)).toThrow();
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
