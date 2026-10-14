import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGapReportText } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/sources";
import { renderMarkdownReport } from "../src/report/markdown";
import { validateResearchReport } from "../src/report/schema";
import { projectExtendedEvidenceReportExtras } from "../src/research/extended-evidence-projections";
import { deriveCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import { capitalReturnSection } from "../src/sources/extended-evidence/capital-return";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type { FinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import type { MetricContext, MetricInput } from "../src/sources/extended-evidence/metric-engine";
import { resolveMarketSnapshotPriceAsOf } from "../src/domain/market-data";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertMetricSectionInvariants } from "./support/run-fixtures/assertions";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const QUOTE_SOURCE_ID = "yahoo-quote-test";
const AS_OF = "2026-07-23T00:00:00.000Z";
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

type Fact = Record<string, unknown>;

function fy(value: number, year: number, overrides: Fact = {}): Fact {
  return {
    start: `${String(year)}-01-01`,
    end: `${String(year)}-12-31`,
    val: value,
    accn: `test-${String(year)}`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${String(year + 1)}-02-15`,
    ...overrides,
  };
}

function series(unit: string, valueFor: (year: number) => number | undefined): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fy(value, year)];
      }),
    },
  };
}

function usGaap(overrides: Record<string, Fact | undefined> = {}): Record<string, Fact> {
  const concepts: Record<string, Fact | undefined> = {
    Revenues: series("USD", (year) => 1000 + year),
    NetCashProvidedByUsedInOperatingActivities: series("USD", () => 400),
    PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 100),
    PaymentsOfDividends: series("USD", () => 60),
    PaymentsForRepurchaseOfCommonStock: series("USD", () => 90),
    WeightedAverageNumberOfDilutedSharesOutstanding: series(
      "shares",
      (year) => 20_000 - 400 * (year - 2019),
    ),
    ShareBasedCompensation: series("USD", () => 25),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(concepts).filter((entry): entry is [string, Fact] => entry[1] !== undefined),
  );
}

function context(
  concepts: Record<string, Fact>,
  overrides: Partial<MetricContext> = {},
): MetricContext {
  const payload = { facts: { "us-gaap": concepts } };
  const statements = deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: SOURCE_ID,
  });
  return {
    symbol: "TEST",
    statements,
    capitalOwnership: deriveCapitalOwnershipArtifact(payload, statements),
    quote: { marketCap: 10_000, currency: "USD", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID },
    ...overrides,
  };
}

const evaluated: ReturnType<typeof capitalReturnSection>[] = [];

function evaluate(ctx: MetricContext) {
  const result = capitalReturnSection(ctx);
  evaluated.push(result);
  return {
    ...result,
    metric: (id: string) => {
      const metric = result.section.metrics.find((candidate) => candidate.id === id);
      if (metric === undefined) {
        throw new Error(`no metric ${id}`);
      }
      return metric;
    },
  };
}

function renderMaterialGaps(ctx: MetricContext): string {
  const { sourceGaps } = capitalReturnSection(ctx);
  const markdown = renderMarkdownReport(
    researchReport({
      jobType: "equity",
      symbol: "TEST",
      dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
    }),
    undefined,
    { sourceGaps },
  );
  return markdown.slice(markdown.indexOf("## Material Data Gaps"), markdown.indexOf("## Appendix"));
}

describe("capitalReturnSection", () => {
  test("AAPL-shaped payer: amounts, yields, payout ratios and share-count change", () => {
    const result = evaluate(context(usGaap()));

    expect(result.section).toMatchObject({ id: "capital-return", title: "Capital Return" });
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "value",
      value: 90,
      currency: "USD",
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 60 });
    expect(result.metric("buybackYield").value).toBeCloseTo(0.009, 12);
    expect(result.metric("dividendYieldFiled").value).toBeCloseTo(0.006, 12);
    expect(result.metric("shareholderYield")).toMatchObject({
      status: "value",
      sourceIds: [SOURCE_ID, QUOTE_SOURCE_ID],
    });
    expect(result.metric("shareholderYield").value).toBeCloseTo(0.015, 12);
    expect(result.metric("fcfPayoutRatio").value).toBeCloseTo(60 / 300, 12);
    expect(result.metric("totalPayoutToFcf").value).toBeCloseTo(150 / 300, 12);
    expect(result.metric("shareCountChange1y").value).toBeCloseTo(17_600 / 18_000 - 1, 12);
    expect(result.metric("shareCountChange5y").value).toBeCloseTo(17_600 / 19_600 - 1, 12);
    expect(result.metric("shareCountChange5y").inputs.map((input) => input.periodEnd)).toEqual([
      "2020-12-31",
      "2025-12-31",
    ]);
    expect(result.metric("shareCountTrend")).toMatchObject({
      status: "value",
      value: "declining",
    });
    expect(result.metric("sbcLatestFy")).toMatchObject({
      status: "value",
      value: 25,
      currency: "USD",
      inputs: [{ artifact: "capitalOwnership", series: "stockBasedCompensation" }],
    });
    expect(result.metric("totalPayoutToFcf").inputs.map((input) => input.series)).toEqual([
      "dividendsPaid",
      "shareRepurchases",
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
    expect(result.sourceGaps).toEqual([]);
  });

  test("GOOG-shaped dividend initiation: the latest FY anchors, earlier years do not matter", () => {
    const result = evaluate(
      context(
        usGaap({ PaymentsOfDividends: series("USD", (year) => (year >= 2024 ? 30 : undefined)) }),
      ),
    );

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 30 });
    expect(result.metric("shareholderYield").value).toBeCloseTo(0.012, 12);
    expect(result.sourceGaps).toEqual([]);
  });

  test("buybacks-only issuer: absent dividends stay missing, never zero", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: undefined })));

    expect(result.metric("buybackYield").status).toBe("value");
    for (const id of [
      "dividendsLatestFy",
      "dividendYieldFiled",
      "shareholderYield",
      "fcfPayoutRatio",
      "totalPayoutToFcf",
    ]) {
      expect(result.metric(id)).toMatchObject({
        status: "missing",
        reason: "no year-aligned annual dividends paid fact",
      });
      expect(result.metric(id).value).toBeUndefined();
    }
    expect(result.sourceGaps[0]).toMatchObject({
      source: "capital-return",
      triage: "material",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("filed zero dividends are a value of 0, never not-applicable", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: series("USD", () => 0) })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(result.metric("dividendYieldFiled")).toMatchObject({ status: "value", value: 0 });
    expect(result.section.metrics.some((metric) => metric.status === "not-applicable")).toBe(false);
  });

  test("no taxonomy: every metric is missing and the section still exists", () => {
    const result = evaluate(context({}));

    expect(result.section.metrics.every((metric) => metric.status === "missing")).toBe(true);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("R1: a 13-month annual fact never anchors; the latest year-aligned FY does", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [fy(80, 2024), fy(130, 2025, { start: "2024-12-01" })],
          },
        },
      }),
    );
    const annual = ctx.statements?.statements.cashFlowStatement.shareRepurchases.annual ?? [];

    const result = evaluate(ctx);

    expect(annual.map((fact) => fact.periodKey)).toContain("duration:13|2025-12-31");
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2024-12-31",
      periodEnd: "2024-12-31",
      inputs: [{ value: 80, periodKey: "duration:12|2024-12-31" }],
    });
    expect(result.metric("shareholderYield")).toMatchObject({
      status: "missing",
      reason: "no same-period share repurchases for the fiscal year ending 2025-12-31",
    });
  });

  test("R1: an interim 12-month fact never anchors", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [
              fy(90, 2025),
              fy(500, 2026, {
                start: "2025-04-01",
                end: "2026-03-31",
                fp: "Q1",
                form: "10-Q",
                filed: "2026-05-01",
              }),
            ],
          },
        },
      }),
    );
    const interim = ctx.statements?.statements.cashFlowStatement.shareRepurchases.interim ?? [];

    const result = evaluate(ctx);

    expect(interim.some((fact) => fact.periodEnd === "2026-03-31")).toBe(true);
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      value: 90,
      periodEnd: "2025-12-31",
    });
  });

  test("R1: a denominator only in an older FY is missing, not an older-period value", () => {
    const result = evaluate(
      context(
        usGaap({
          NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
            year <= 2024 ? 400 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "missing",
      reason: "no same-period operating cash flow for the fiscal year ending 2025-12-31",
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPaid", periodEnd: "2025-12-31" }],
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("fcfPayoutRatio").value).toBeUndefined();
  });

  test("R8: a stale anchor is missing with its lineage; a current FY is a value", () => {
    const stale = evaluate(
      context(
        usGaap({
          PaymentsForRepurchaseOfCommonStock: series("USD", (year) =>
            year <= 2020 ? 90 : undefined,
          ),
          WeightedAverageNumberOfDilutedSharesOutstanding: series("shares", (year) =>
            year <= 2020 ? 1000 : undefined,
          ),
        }),
      ),
    );
    const current = evaluate(context(usGaap()));

    expect(stale.metric("buybackYield")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2020-12-31",
      periodEnd: "2020-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(stale.metric("shareCountChange1y")).toMatchObject({
      status: "missing",
      reason: "stale diluted shares as of 2020-12-31",
    });
    expect(stale.sourceGaps[0]?.triage).toBe("material");
    expect(current.metric("buybackYield")).toMatchObject({
      status: "value",
      periodEnd: "2025-12-31",
    });
  });

  test("R8 cutoff is calendar-aware: FY end + 16 months (month-end kept) + 7 days", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [
              fy(90, 2024, { start: "2023-07-01", end: "2024-06-30", filed: "2024-08-15" }),
              fy(70, 2023, { start: "2023-10-02", end: "2024-09-28", filed: "2024-11-01" }),
            ],
          },
        },
      }),
    );
    const buybacksAsOf = (analysisAsOf: string, periodEnd: string) => {
      const { statements } = ctx;
      const repurchases = statements!.statements.cashFlowStatement.shareRepurchases;
      return evaluate({
        ...ctx,
        statements: {
          ...statements!,
          analysisAsOf,
          statements: {
            ...statements!.statements,
            cashFlowStatement: {
              ...statements!.statements.cashFlowStatement,
              shareRepurchases: {
                ...repurchases,
                annual: repurchases.annual.filter((fact) => fact.periodEnd === periodEnd),
              },
            },
          },
        },
      }).metric("buybacksLatestFy").status;
    };

    expect(buybacksAsOf("2025-10-29T00:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-10-31T00:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-11-07T23:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-11-08T00:00:00.000Z", "2024-06-30")).toBe("missing");
    // 52/53-week FYE: a 53-week FY ending 2025-10-04 has its 20-F due 2026-02-04.
    expect(buybacksAsOf("2026-02-04T00:00:00.000Z", "2024-09-28")).toBe("value");
    expect(buybacksAsOf("2026-02-05T00:00:00.000Z", "2024-09-28")).toBe("missing");
  });

  test("R1: an undated FY stock-based compensation fact is missing, not a value", () => {
    const ctx = context(
      usGaap({
        ShareBasedCompensation: { units: { USD: [{ ...fy(25, 2025), start: undefined }] } },
      }),
    );

    const result = evaluate(ctx);

    expect(ctx.capitalOwnership?.stockBasedCompensation).toMatchObject([
      { value: 25, periodEnd: "2025-12-31" },
    ]);
    expect(result.metric("sbcLatestFy")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual stock-based compensation fact",
    });
  });

  test("R2: zero or negative free cash flow is not-meaningful with its inputs kept", () => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 400) })),
    );

    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "not-meaningful",
      reason: "free cash flow is zero or negative for the fiscal year ending 2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  });

  test("R6: an earlier-share-basis period inside the window makes the change not-meaningful", () => {
    const ctx = context(usGaap());
    const statements = ctx.statements!;
    const fact2023 = statements.statements.perShare.dilutedShares.annual.find(
      (fact) => fact.periodEnd === "2023-12-31",
    )!;
    const split: FinancialStatementsArtifact = {
      ...statements,
      omissionNotes: [
        ...statements.omissionNotes,
        {
          code: "earlier-share-basis",
          seriesKey: "dilutedShares",
          periodKey: fact2023.periodKey,
          message: "test split",
        },
      ],
    };

    const result = evaluate({ ...ctx, statements: split });

    expect(result.metric("shareCountChange1y").status).toBe("value");
    expect(result.metric("shareCountChange3y")).toMatchObject({
      status: "not-meaningful",
      reason: "diluted shares inside the window are on an earlier share basis",
    });
    expect(result.metric("shareCountTrend").status).toBe("not-meaningful");
  });

  test("currency mismatch: yields are missing, filed amounts keep their values", () => {
    const result = evaluate(
      context(usGaap(), {
        quote: { marketCap: 10_000, currency: "EUR", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID },
      }),
    );

    for (const id of ["buybackYield", "dividendYieldFiled", "shareholderYield"]) {
      expect(result.metric(id)).toMatchObject({
        status: "missing",
        reason: "reporting currency USD differs from quote currency EUR",
      });
    }
    expect(result.metric("buybacksLatestFy").status).toBe("value");
    expect(result.metric("dividendYieldFiled")).toMatchObject({
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPaid" }, { artifact: "quote", currency: "EUR" }],
      sourceIds: [SOURCE_ID, QUOTE_SOURCE_ID],
    });
  });

  test("no quote market cap: yields are missing", () => {
    const { quote: _quote, ...withoutQuote } = context(usGaap());

    const result = evaluate(withoutQuote);

    expect(result.metric("buybackYield")).toMatchObject({
      status: "missing",
      reason: "no quote market cap",
    });
  });

  test("R3: depository issuers get not-applicable FCF ratios without computing them", () => {
    const result = evaluate(context(usGaap(), { depositorySic: "6022" }));

    for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
      expect(result.metric(id)).toMatchObject({ status: "not-applicable", inputs: [] });
    }
    expect(result.metric("dividendYieldFiled").status).toBe("value");
    expect(result.sourceGaps[0]).toMatchObject({ triage: "diagnostic" });
    expect(result.sourceGaps[0]?.message).toContain("depository issuer (SIC 6022)");
  });

  test("report.md lists a missing-metric gap as material and a diagnostic-only gap apart", () => {
    const material = renderMaterialGaps(context(usGaap({ PaymentsOfDividends: undefined })));
    const diagnostic = renderMaterialGaps(context(usGaap(), { depositorySic: "6022" }));

    expect(material).toContain("capital-return: Capital Return metrics for TEST not computed");
    expect(diagnostic).not.toContain("capital-return");
  });

  test("every label, basis, reason, text value and gap passes the research-only gate", () => {
    expect(evaluated.length).toBeGreaterThan(10);
    const texts = evaluated.flatMap(({ section, sourceGaps }) => [
      section.title,
      ...section.metrics.flatMap((metric) => [
        metric.label,
        metric.basis,
        metric.reason ?? "",
        typeof metric.value === "string" ? metric.value : "",
        ...metric.inputs.map((input) => input.label),
      ]),
      ...sourceGaps.map((gap) => gap.message),
    ]);

    expect(texts.filter((text) => violatesResearchOnly(text) !== null)).toEqual([]);
  });
});

function evidenceSource(id: string): Source {
  return { id, title: id, fetchedAt: AS_OF, kind: "extended-evidence", assetClass: "equity" };
}

function reportWith(ctx: MetricContext, sourceIds: readonly string[]) {
  const extras = projectExtendedEvidenceReportExtras({
    modelExtras: {},
    collectedSources: collectedSources({ metricSections: [capitalReturnSection(ctx).section] }),
  });
  return researchReport({
    jobType: "equity",
    symbol: "TEST",
    sources: sourceIds.map(evidenceSource),
    extras,
  });
}

describe("Capital Return in report.json and report.md", () => {
  test("every metric and input cites only statements, capital-ownership or quote ids", () => {
    const base = context(usGaap());
    const ids = [
      base,
      context(usGaap({ PaymentsOfDividends: undefined })),
      context(usGaap(), { depositorySic: "6022" }),
      context(usGaap(), { quote: { ...base.quote!, currency: "EUR" } }),
    ].flatMap((ctx) =>
      capitalReturnSection(ctx).section.metrics.flatMap((metric) => [
        ...metric.sourceIds,
        ...metric.inputs.flatMap((input) => input.sourceIds),
      ]),
    );
    expect(ids).toContain(SOURCE_ID);
    expect(ids).toContain(QUOTE_SOURCE_ID);
    expect(ids.filter((id) => id !== SOURCE_ID && id !== QUOTE_SOURCE_ID)).toEqual([]);
  });

  test("the fixture lineage invariant passes a real section and rejects forged lineage", () => {
    const snapshot = marketSnapshot({
      sourceId: QUOTE_SOURCE_ID,
      symbol: "TEST",
      marketCap: 10_000,
      observedAt: AS_OF,
    });
    const ctx = context(usGaap(), {
      quote: {
        marketCap: 10_000,
        currency: "USD",
        asOf: resolveMarketSnapshotPriceAsOf(snapshot).instant,
        sourceId: QUOTE_SOURCE_ID,
      },
    });
    const { section } = capitalReturnSection(ctx);
    const run = (metrics: readonly unknown[]) => {
      const report = researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID), evidenceSource(QUOTE_SOURCE_ID)],
        extras: { metricSections: [{ ...section, metrics }] },
      });
      return () =>
        assertMetricSectionInvariants(
          {
            collectedSources: collectedSources({
              financialStatements: ctx.statements!,
              capitalOwnership: ctx.capitalOwnership!,
              marketSnapshots: [snapshot],
              resolvedInstrumentIdentity: { quoteCurrency: "USD" } as never,
            }),
            markdown: renderMarkdownReport(report),
          },
          report,
        );
    };
    const forged = (id: string, change: (metric: Record<string, unknown>) => unknown) =>
      section.metrics.map((metric) =>
        metric.id === id ? change(metric as unknown as Record<string, unknown>) : metric,
      );
    const forgedInput = (patch: Record<string, unknown>) =>
      forged("buybackYield", (metric) => ({
        ...metric,
        inputs: (metric.inputs as readonly MetricInput[]).map((input, index) =>
          index === 0 ? { ...input, ...patch } : input,
        ),
      }));

    expect(section.metrics.every((metric) => metric.status === "value")).toBe(true);
    expect(run(section.metrics)).not.toThrow();
    expect(run(forgedInput({ periodStart: "2029-01-01", periodEnd: "2029-12-31" }))).toThrow(
      "lineage matches its artifact",
    );
    expect(run(forgedInput({ currency: "CAD" }))).toThrow("lineage matches its artifact");
    expect(
      run(forged("buybackYield", (metric) => ({ ...metric, periodEnd: "2030-12-31" }))),
    ).toThrow("ends at its anchor FY");
    expect(run(forged("buybacksLatestFy", ({ value: _value, ...metric }) => metric))).toThrow(
      "finite number or non-empty text",
    );
  });

  test("validates against report sources and rejects an unknown metric source id", () => {
    const ctx = context(usGaap());
    expect(() =>
      validateResearchReport(reportWith(ctx, [SOURCE_ID, QUOTE_SOURCE_ID])),
    ).not.toThrow();
    expect(() => validateResearchReport(reportWith(ctx, [SOURCE_ID]))).toThrow(
      `Metric Sections [0].metrics[6] (capital-return.buybackYield) cites unknown source ID: ${QUOTE_SOURCE_ID}`,
    );
  });

  test("renders values with period, basis and citations, and reasons for the rest", () => {
    const markdown = renderMarkdownReport(
      reportWith(context(usGaap(), { quote: { ...context(usGaap()).quote!, currency: "EUR" } }), [
        SOURCE_ID,
        QUOTE_SOURCE_ID,
      ]),
    );

    expect(markdown).toContain(
      `### Capital Return\n\n- Share repurchases \\(latest FY\\): $90 (FY ending 2025-12-31; cash paid for share repurchases in the latest year-aligned fiscal year) [${SOURCE_ID}]`,
    );
    expect(markdown).toContain(
      "- Buyback yield: not available, reporting currency USD differs from quote currency EUR",
    );
    expect(markdown).toContain(`- [${SOURCE_ID}] ${SOURCE_ID}`);
    // The quote is cited only by the missing yields, which render a reason and no reference.
    expect(markdown).not.toContain(`- [${QUOTE_SOURCE_ID}]`);
  });

  test("no Metric Section renders no Capital Return heading", () => {
    const markdown = renderMarkdownReport(researchReport({ jobType: "equity", symbol: "TEST" }));
    expect(markdown).not.toContain("Capital Return");
  });
});
