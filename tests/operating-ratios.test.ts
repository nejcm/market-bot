import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGap, sourceGapReportText } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/sources";
import { renderMarkdownReport } from "../src/report/markdown";
import {
  deriveFinancialStatements,
  financialStatementsHistoryGaps,
} from "../src/sources/extended-evidence/financial-statements";
import { balanceSheetHistory, financialPosition } from "../src/report/equity-reader-statements";
import { renderBalanceSheetAndShareCount } from "../src/report/markdown-equity-sections";
import {
  balanceSheetHistoryFromProjection,
  financialPositionFromProjection,
} from "../app/client/run-workspace-financials";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
import type { MetricContext } from "../src/sources/extended-evidence/metric-engine";
import { NEGATIVE_CAPEX_REASON } from "../src/sources/extended-evidence/financial-statement-definitions";
import { operatingRatiosSection } from "../src/sources/extended-evidence/operating-ratios";
import { collectedSources, researchReport } from "./support/fixtures";
import { assertOperatingRatioInvariants } from "./support/run-fixtures/assertions";
import { assertCompositeFactIntegrity } from "./support/run-fixtures/financial-invariants";
import { metricSectionsView } from "../app/client/view-model-metric-sections";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const AS_OF = "2026-07-23T00:00:00.000Z";
const YEARS = [2023, 2024, 2025];

type Fact = Record<string, unknown>;
type Concepts = Record<string, Fact | undefined>;

function fact(value: number, year: number, overrides: Fact = {}): Fact {
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

function flow(valueFor: (year: number) => number | undefined, unit = "USD"): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fact(value, year)];
      }),
    },
  };
}

function instant(valueFor: (year: number) => number | undefined, unit = "USD"): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fact(value, year, { start: undefined })];
      }),
    },
  };
}

function usGaap(overrides: Concepts = {}): Concepts {
  return {
    Revenues: flow(() => 1000),
    NetCashProvidedByUsedInOperatingActivities: flow(() => 300),
    PaymentsToAcquirePropertyPlantAndEquipment: flow(() => 100),
    OperatingIncomeLoss: flow(() => 200),
    InterestExpense: flow(() => 40),
    DepreciationDepletionAndAmortization: flow(() => 50),
    IncomeTaxExpenseBenefit: flow(() => 32),
    IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
      flow(() => 160),
    StockholdersEquity: instant(() => 700),
    LongTermDebt: instant(() => 400),
    CashAndCashEquivalentsAtCarryingValue: instant(() => 100),
    ...overrides,
  };
}

function context(
  concepts: Concepts,
  overrides: Partial<MetricContext> = {},
  taxonomy = "us-gaap",
  analysisAsOf = AS_OF,
): MetricContext {
  const facts = Object.fromEntries(
    Object.entries(concepts).filter((entry): entry is [string, Fact] => entry[1] !== undefined),
  );
  return {
    symbol: "TEST",
    statements: deriveFinancialStatements(
      { facts: { [taxonomy]: facts } },
      { symbol: "TEST", generatedAt: analysisAsOf, analysisAsOf, sourceId: SOURCE_ID },
    ),
    ...overrides,
  };
}

const evaluated: ReturnType<typeof operatingRatiosSection>[] = [];

function evaluate(ctx: MetricContext) {
  const result = operatingRatiosSection(ctx);
  evaluated.push(result);
  return {
    ...result,
    ctx,
    metric: (id: string) => {
      const metric = result.section.metrics.find((candidate) => candidate.id === id);
      if (metric === undefined) {
        throw new Error(`no metric ${id}`);
      }
      return metric;
    },
  };
}

function evidenceSource(id: string): Source {
  return { id, title: id, fetchedAt: AS_OF, kind: "extended-evidence", assetClass: "equity" };
}

// Gaps follow the given metrics, so a forged status trips its own assertion, not the gap check.
function invariantRun(ctx: MetricContext, metrics: readonly unknown[], rawPayload?: Fact) {
  const { section } = operatingRatiosSection(ctx);
  const rows = metrics as readonly Record<string, unknown>[];
  const missing = rows.filter(({ status }) => status === "missing");
  const sourceGaps = rows.some(({ status }) => status !== "value")
    ? [
        sourceGap({
          source: "operating-ratios",
          message: "Operating Ratios metrics for TEST not computed",
          symbol: "TEST",
          provider: "market-bot",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "no-cap",
          triage: missing.every(({ cause }) => cause === "not-filed") ? "diagnostic" : "material",
        }),
      ]
    : [];
  const report = researchReport({
    jobType: "equity",
    symbol: "TEST",
    sources: [evidenceSource(SOURCE_ID)],
    dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
    extras: { metricSections: [{ ...section, metrics }] },
  });
  return () =>
    assertOperatingRatioInvariants(
      {
        collectedSources: collectedSources({
          financialStatements:
            rawPayload === undefined
              ? ctx.statements!
              : {
                  ...ctx.statements!,
                  sourceUrl: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
                },
          ...(rawPayload === undefined
            ? {}
            : {
                rawSnapshots: [
                  {
                    id: SOURCE_ID,
                    adapter: "sec-companyfacts",
                    fetchedAt: AS_OF,
                    payload: rawPayload,
                  },
                ],
              }),
          sourceGaps,
        }),
        markdown: renderMarkdownReport(report),
      },
      report,
    );
}

describe("operatingRatiosSection", () => {
  test("derives every ratio from one fiscal year and that year-end's balance sheet", () => {
    const result = evaluate(context(usGaap()));

    expect(result.section).toMatchObject({ id: "operating-ratios", title: "Operating Ratios" });
    expect(result.metric("freeCashFlowMargin")).toMatchObject({
      status: "value",
      value: 0.2,
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("interestCoverage")).toMatchObject({ status: "value", value: 5 });
    expect(result.metric("ebitdaProxy")).toMatchObject({
      status: "value",
      value: 250,
      currency: "USD",
    });
    expect(result.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: 0.2 });
    expect(result.metric("roic").value).toBeCloseTo((200 * 0.8) / 1000, 12);
    expect(
      result.metric("roic").inputs.map(({ series, periodKey }) => [series, periodKey]),
    ).toEqual([
      ["operatingIncome", "duration:12|2025-12-31"],
      ["incomeTaxExpense", "duration:12|2025-12-31"],
      ["pretaxIncome", "duration:12|2025-12-31"],
      ["stockholdersEquity", "instant|2025-12-31"],
      ["debt", "instant|2025-12-31"],
      ["cash", "instant|2025-12-31"],
    ]);
    expect(result.sourceGaps).toEqual([]);
    expect(invariantRun(context(usGaap()), result.section.metrics)).not.toThrow();
  });

  test.each(["Depreciation", "DepreciationNonproduction"])(
    "uses %s plus intangible amortization only where combined D&A is absent",
    (depreciation) => {
      const result = evaluate(
        context(
          usGaap({
            DepreciationDepletionAndAmortization: flow((year) => (year === 2024 ? 50 : undefined)),
            DepreciationAndAmortization: flow((year) => (year === 2024 ? 51 : undefined)),
            [depreciation]: flow(() => 40),
            AmortizationOfIntangibleAssets: flow(() => 15),
          }),
        ),
      );
      const statements = result.ctx.statements!;
      const series = statements.statements.cashFlowStatement.depreciationAndAmortization;
      expect(series.annual.map(({ value, extractionMethod }) => [value, extractionMethod])).toEqual(
        [
          [55, "derived-sec-companyfacts"],
          [50, "sec-companyfacts"],
          [55, "derived-sec-companyfacts"],
        ],
      );
      expect(series.annual.at(-1)).toMatchObject({
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
        firstPublicAt: "2026-02-15",
        composite: {
          components: [
            { concept: depreciation, value: 40 },
            { concept: "AmortizationOfIntangibleAssets", value: 15 },
          ],
        },
      });
      expect(statements.unfiledSeries).not.toContain("depreciationAndAmortization");
      expect(() => assertCompositeFactIntegrity(statements)).not.toThrow();
      const metric = result.metric("ebitdaProxy");
      expect(metric).toMatchObject({
        status: "value",
        value: 255,
        currency: "USD",
        sourceIds: [SOURCE_ID],
      });
      expect(metric.basis).toContain("depreciation + intangible amortization");
      const report = researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID)],
        extras: { metricSections: [result.section] },
      });
      expect(renderMarkdownReport(report)).toContain(
        "D&A basis: depreciation + intangible amortization",
      );
      expect(
        metricSectionsView({ extras: report.extras })?.[0]?.metrics.find(
          ({ label }) => label === metric.label,
        )?.basis,
      ).toBe(metric.basis);
      expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    },
  );

  test("combined D&A wins over components and depreciation aliases are alternatives", () => {
    const concepts = usGaap({
      Depreciation: flow(() => 40),
      DepreciationNonproduction: flow(() => 41),
      AmortizationOfIntangibleAssets: flow(() => 15),
    });
    const direct = evaluate(context(concepts));
    expect(direct.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 250 });
    expect(direct.metric("ebitdaProxy").basis).not.toContain("intangible amortization");
    const fallback = evaluate(
      context({ ...concepts, DepreciationDepletionAndAmortization: undefined }),
    );
    expect(fallback.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 255 });
  });

  test("Intel legacy D&A below depreciation uses the complete component sum", () => {
    const periods = [
      {
        year: 2016,
        start: "2015-12-27",
        end: "2016-12-31",
        total: 294,
        depreciation: 6266,
        amortization: 1524,
      },
      {
        year: 2017,
        start: "2017-01-01",
        end: "2017-12-30",
        total: 177,
        depreciation: 6752,
        amortization: 1377,
      },
      {
        year: 2018,
        start: "2017-12-31",
        end: "2018-12-29",
        total: 200,
        depreciation: 7520,
        amortization: 1565,
      },
      {
        year: 2019,
        start: "2018-12-30",
        end: "2019-12-28",
        total: 200,
        depreciation: 9204,
        amortization: 1622,
      },
    ];
    const filed = (key: "total" | "depreciation" | "amortization") => ({
      units: {
        USD: periods.map(({ year, start, end, ...values }) =>
          fact(values[key] * 1_000_000, year, { start, end }),
        ),
      },
    });
    const concepts = usGaap({
      OperatingIncomeLoss: {
        units: {
          USD: periods.map(({ year, start, end }) => fact(200_000_000, year, { start, end })),
        },
      },
      DepreciationDepletionAndAmortization: undefined,
      DepreciationAndAmortization: filed("total"),
      Depreciation: filed("depreciation"),
      AmortizationOfIntangibleAssets: filed("amortization"),
    });
    const result = evaluate(context(concepts, {}, "us-gaap", "2020-07-23T00:00:00.000Z"));
    const statements = result.ctx.statements!;
    const series = statements.statements.cashFlowStatement.depreciationAndAmortization;
    expect(series.annual.map(({ value }) => value)).toEqual([
      7_790_000_000, 8_129_000_000, 9_085_000_000, 10_826_000_000,
    ]);
    expect(
      series.annual.every(
        ({ extractionMethod, composite }) =>
          extractionMethod === "derived-sec-companyfacts" && composite?.components.length === 2,
      ),
    ).toBe(true);
    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 11_026_000_000 });
    expect(result.metric("ebitdaProxy").basis).toContain("depreciation + intangible amortization");
    expect(() => assertCompositeFactIntegrity(statements)).not.toThrow();
    expect(
      invariantRun(result.ctx, result.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).not.toThrow();
    const first = series.annual[0]!;
    const depreciation = first.composite!.components[0]!;
    expect(() =>
      assertCompositeFactIntegrity({
        ...statements,
        statements: {
          ...statements.statements,
          cashFlowStatement: {
            ...statements.statements.cashFlowStatement,
            depreciationAndAmortization: {
              ...series,
              annual: [
                {
                  ...first,
                  value: depreciation.value,
                  composite: { ...first.composite!, components: [depreciation] },
                },
              ],
            },
          },
        },
      }),
    ).toThrow(/\[A8\].*complete depreciation/u);
  });

  test("combined D&A remains usable without components", () => {
    const result = evaluate(context(usGaap()));
    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 250 });
    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual.every(
        ({ composite }) => composite === undefined,
      ),
    ).toBe(true);
    expect(result.metric("ebitdaProxy").basis).not.toContain("intangible amortization");
  });

  test("Lantronix FY2021 D&A below amortization uses the full sum", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2021, { start: "2020-07-01", end: "2021-06-30" })] },
    });
    const combinedOnly = usGaap({
      Revenues: filed(100_000_000),
      OperatingIncomeLoss: filed(200_000),
      DepreciationDepletionAndAmortization: undefined,
      DepreciationAndAmortization: filed(817_000),
    });
    const concepts = {
      ...combinedOnly,
      Depreciation: filed(817_000),
      AmortizationOfIntangibleAssets: filed(3_094_000),
    };
    const result = evaluate(context(concepts, {}, "us-gaap", "2022-07-23T00:00:00.000Z"));
    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: 3_911_000, extractionMethod: "derived-sec-companyfacts" }]);
    expect(
      invariantRun(result.ctx, result.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).not.toThrow();
    const stale = evaluate(context(combinedOnly, {}, "us-gaap", "2022-07-23T00:00:00.000Z"));
    expect(
      invariantRun(stale.ctx, stale.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).toThrow(/D&A.*component/u);
  });

  test("D&A dominance uses the latest eligible filing for totals and components", () => {
    const result = evaluate(
      context(
        usGaap({
          DepreciationDepletionAndAmortization: {
            units: { USD: [fact(1, 2025), fact(50, 2025, { filed: "2026-03-01" })] },
          },
          Depreciation: {
            units: { USD: [fact(100, 2025), fact(40, 2025, { filed: "2026-03-01" })] },
          },
          AmortizationOfIntangibleAssets: flow(() => 50),
        }),
      ),
    );
    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 250 });
    expect(result.metric("ebitdaProxy").basis).not.toContain("intangible amortization");
  });

  test.each([
    {
      name: "Vertex FY2017",
      year: 2017,
      total: 61_397_000,
      component: 61_400_000,
      concept: "Depreciation",
    },
    {
      name: "AST FY2023",
      year: 2023,
      total: 54_469_000,
      component: 54_500_000,
      concept: "Depreciation",
    },
    {
      name: "exactly 1% below amortization",
      year: 2023,
      total: 54_450_000,
      component: 55_000_000,
      concept: "AmortizationOfIntangibleAssets",
    },
  ])("combined D&A tolerates rounding: $name", ({ year, total, component, concept }) => {
    const concepts = usGaap({
      Revenues: { units: { USD: [fact(100_000_000, year)] } },
      OperatingIncomeLoss: { units: { USD: [fact(200_000, year)] } },
      DepreciationDepletionAndAmortization: {
        units: { USD: [fact(total, year)] },
      },
      Depreciation: {
        units: { USD: [fact(concept === "Depreciation" ? component : 1000, year)] },
      },
      AmortizationOfIntangibleAssets: {
        units: {
          USD: [fact(concept === "AmortizationOfIntangibleAssets" ? component : 1000, year)],
        },
      },
    });
    const result = evaluate(
      context(concepts, {}, "us-gaap", `${String(year + 1)}-07-23T00:00:00.000Z`),
    );
    const statements = result.ctx.statements!;
    expect(
      statements.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: total, extractionMethod: "sec-companyfacts" }]);
    expect(
      statements.omissionNotes.filter((note) => note.seriesKey === "depreciationAndAmortization"),
    ).toEqual([]);
    expect(() => assertCompositeFactIntegrity(statements)).not.toThrow();
    expect(
      invariantRun(result.ctx, result.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).not.toThrow();
    const demoted = evaluate(
      context(
        { ...concepts, DepreciationDepletionAndAmortization: undefined },
        {},
        "us-gaap",
        `${String(year + 1)}-07-23T00:00:00.000Z`,
      ),
    );
    expect(
      demoted.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ extractionMethod: "derived-sec-companyfacts" }]);
    expect(
      invariantRun(demoted.ctx, demoted.section.metrics, {
        cik: 1,
        facts: { "us-gaap": concepts },
      }),
    ).toThrow(/D&A.*retain the combined fact/u);
  });

  test("an older component rejects a newer combined D&A more than 1% below it", () => {
    const concepts = usGaap({
      DepreciationDepletionAndAmortization: {
        units: { USD: [fact(54_449_999, 2023, { filed: "2026-03-02" })] },
      },
      Depreciation: {
        units: { USD: [fact(55_000_000, 2023, { filed: "2025-03-03" })] },
      },
      AmortizationOfIntangibleAssets: {
        units: { USD: [fact(5_000_000, 2023, { filed: "2025-03-03" })] },
      },
    });
    const result = evaluate(context(concepts));
    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([
      { value: 60_000_000, extractionMethod: "derived-sec-companyfacts", filedAt: "2025-03-03" },
    ]);
    expect(
      invariantRun(result.ctx, result.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).not.toThrow();
    const stale = evaluate(
      context({
        ...concepts,
        Depreciation: undefined,
        AmortizationOfIntangibleAssets: undefined,
      }),
    );
    expect(
      invariantRun(stale.ctx, stale.section.metrics, { cik: 1, facts: { "us-gaap": concepts } }),
    ).toThrow(/D&A.*component/u);
  });

  test.each([
    { name: "different start", overrides: { start: "2025-01-02" }, unit: "USD" },
    { name: "different duration", overrides: { start: "2025-07-01" }, unit: "USD" },
    { name: "different end", overrides: { end: "2025-12-30" }, unit: "USD" },
    { name: "after cutoff", overrides: { filed: "2026-08-01" }, unit: "USD" },
    { name: "different currency", overrides: {}, unit: "EUR" },
  ])("combined D&A ignores depreciation with $name", ({ overrides, unit }) => {
    const result = evaluate(
      context(
        usGaap({
          DepreciationDepletionAndAmortization: flow(() => 1),
          Depreciation: { units: { [unit]: [fact(40, 2025, overrides)] } },
          AmortizationOfIntangibleAssets: flow(() => 0.1),
        }),
      ),
    );
    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 201 });
    expect(result.metric("ebitdaProxy").basis).not.toContain("intangible amortization");
  });

  test("a rejected combined D&A never becomes a partial sum", () => {
    const result = evaluate(
      context(
        usGaap({
          DepreciationDepletionAndAmortization: flow(() => 1),
          Depreciation: flow(() => 40),
        }),
      ),
    );
    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "missing" });
    expect(result.metric("ebitdaProxy").cause).not.toBe("not-filed");
    expect(result.metric("ebitdaProxy").value).toBeUndefined();
    expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    const statements = result.ctx.statements!;
    const notes = statements.omissionNotes.filter(
      (note) => note.seriesKey === "depreciationAndAmortization",
    );
    expect(notes).toEqual(
      YEARS.map((year) => ({
        code: "incomplete-composite-series",
        seriesKey: "depreciationAndAmortization",
        periodKey: `duration:12|${String(year)}-12-31`,
        message: `SEC depreciation and amortization for ${String(year)}-01-01 to ${String(year)}-12-31 omitted: the combined fact is more than 1% below a same-period component and the matching component set is incomplete`,
      })),
    );
    expect(financialStatementsHistoryGaps(statements).map(({ message }) => message)).toEqual(
      notes.map(({ message }) => message),
    );
    const history = balanceSheetHistory(statements, AS_OF);
    const position = financialPosition(statements, AS_OF);
    const report = researchReport({
      jobType: "equity",
      extras: { metricSections: [result.section] },
    });
    const sections = metricSectionsView({ extras: report.extras }, statements);
    expect(sections?.find(({ id }) => id === "operating-ratios")?.notes).toEqual(
      notes.map(({ message }) => message),
    );
    const markdown = renderMarkdownReport(
      report,
      undefined,
      collectedSources({ financialStatements: statements }),
    );
    expect(markdown).toContain("### Operating Ratios");
    const balanceSheetMarkdown = renderBalanceSheetAndShareCount(report, history);
    for (const note of notes) {
      expect(history?.notes).not.toContainEqual(note);
      expect(position?.notes).not.toContainEqual(note);
      expect(balanceSheetHistoryFromProjection(history)?.notes).not.toContainEqual(note);
      expect(financialPositionFromProjection(position)?.notes).not.toContainEqual(note);
      expect(markdown.split(note.message)).toHaveLength(2);
      expect(markdown.indexOf(note.message)).toBeGreaterThan(
        markdown.indexOf("### Operating Ratios"),
      );
      expect(balanceSheetMarkdown).not.toContain(note.message);
      expect(violatesResearchOnly(note.message)).toBeNull();
    }
  });

  test.each(["Depreciation", "AmortizationOfIntangibleAssets"])(
    "missing %s keeps the not-filed cause",
    (missing) => {
      const result = evaluate(
        context(
          usGaap({
            DepreciationDepletionAndAmortization: undefined,
            Depreciation: flow(() => 40),
            AmortizationOfIntangibleAssets: flow(() => 15),
            [missing]: undefined,
          }),
        ),
      );
      expect(result.metric("ebitdaProxy")).toMatchObject({
        status: "missing",
        cause: "not-filed",
        reason: "depreciation and amortization not filed by the issuer",
      });
      expect(result.metric("ebitdaProxy").value).toBeUndefined();
      expect(
        result.ctx.statements!.omissionNotes.filter(
          (note) => note.seriesKey === "depreciationAndAmortization",
        ),
      ).toEqual([]);
    },
  );

  test.each([
    { name: "different fiscal years", overrides: { start: "2024-01-01", end: "2024-12-31" } },
    { name: "same end, different duration", overrides: { start: "2025-07-01" } },
    { name: "same duration bucket, different start", overrides: { start: "2025-01-02" } },
    { name: "amortization after cutoff", overrides: { filed: "2026-08-01" } },
  ])("never combines D&A with $name", ({ overrides }) => {
    const result = evaluate(
      context(
        usGaap({
          DepreciationDepletionAndAmortization: undefined,
          Depreciation: { units: { USD: [fact(40, 2025)] } },
          AmortizationOfIntangibleAssets: { units: { USD: [fact(15, 2025, overrides)] } },
        }),
      ),
    );
    expect(
      result.ctx.statements?.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    expect(result.metric("ebitdaProxy").status).toBe("missing");
    expect(result.metric("ebitdaProxy").value).toBeUndefined();
  });

  test("does not sum D&A components in different currencies", () => {
    const result = evaluate(
      context(
        usGaap({
          DepreciationDepletionAndAmortization: undefined,
          Depreciation: flow(() => 40),
          AmortizationOfIntangibleAssets: flow(() => 15, "EUR"),
        }),
      ),
    );
    expect(result.metric("ebitdaProxy").status).toBe("missing");
    expect(result.metric("ebitdaProxy").value).toBeUndefined();
  });

  test("labels an IFRS figure with its filed currency, never a quote currency", () => {
    const result = evaluate(
      context(
        {
          ProfitLossFromOperatingActivities: flow(() => 200, "EUR"),
          DepreciationAndAmortisationExpense: flow(() => 50, "EUR"),
          IncomeTaxExpenseContinuingOperations: flow(() => 30, "EUR"),
          ProfitLossBeforeTax: flow(() => 150, "EUR"),
          InterestExpense: flow(() => 25, "EUR"),
          Revenue: flow(() => 900, "EUR"),
        },
        {},
        "ifrs-full",
      ),
    );

    expect(result.metric("ebitdaProxy")).toMatchObject({ value: 250, currency: "EUR" });
    expect(result.metric("effectiveTaxRate")).toMatchObject({ value: 0.2 });
    expect(result.metric("interestCoverage")).toMatchObject({ value: 8 });
  });

  test("a 13-month fact never anchors and an older same-period fact is never used", () => {
    const longYear = evaluate(
      context(
        usGaap({
          IncomeTaxExpenseBenefit: {
            units: { USD: [fact(32, 2025, { start: "2024-12-01" })] },
          },
        }),
      ),
    );
    const olderPretax = evaluate(
      context(
        usGaap({
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            flow((year) => (year === 2025 ? undefined : 160)),
        }),
      ),
    );

    expect(longYear.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual income tax expense fact",
    });
    expect(olderPretax.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "no same-period pretax income for the fiscal year ending 2025-12-31",
    });
    expect(olderPretax.sourceGaps[0]?.triage).toBe("material");
  });

  test("an instant at any other date than the flow's period end gives a material missing", () => {
    const result = evaluate(
      context(
        usGaap({
          StockholdersEquity: {
            units: {
              USD: [
                fact(700, 2025, { start: undefined, end: "2025-12-30" }),
                fact(650, 2024, { start: undefined }),
              ],
            },
          },
        }),
      ),
    );

    expect(result.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no stockholders' equity at the fiscal year end 2025-12-31",
      periodEnd: "2025-12-31",
    });
    expect(result.metric("roic").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("zero or negative denominators are not meaningful; nothing is clamped", () => {
    const negative = evaluate(
      context(
        usGaap({
          Revenues: flow(() => -5),
          InterestExpense: flow(() => 0),
          DepreciationDepletionAndAmortization: flow(() => -1),
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            flow(() => -10),
        }),
      ),
    );
    const unclamped = evaluate(
      context(
        usGaap({
          IncomeTaxExpenseBenefit: flow(() => 200),
          OperatingIncomeLoss: flow(() => -80),
        }),
      ),
    );
    const benefit = evaluate(context(usGaap({ IncomeTaxExpenseBenefit: flow(() => -16) })));
    const noCapital = evaluate(
      context(usGaap({ CashAndCashEquivalentsAtCarryingValue: instant(() => 1100) })),
    );

    for (const [id, reason] of [
      ["freeCashFlowMargin", "revenue is zero or negative"],
      ["interestCoverage", "interest expense is zero or negative"],
      ["ebitdaProxy", "depreciation and amortization is negative"],
      ["effectiveTaxRate", "pretax income is zero or negative"],
      ["roic", "pretax income is zero or negative"],
    ] as const) {
      expect(negative.metric(id)).toMatchObject({
        status: "not-meaningful",
        reason: `${reason} for the fiscal year ending 2025-12-31`,
      });
    }
    expect(negative.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(unclamped.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: 1.25 });
    expect(unclamped.metric("interestCoverage")).toMatchObject({ status: "value", value: -2 });
    expect(unclamped.metric("roic")).toMatchObject({
      status: "not-meaningful",
      reason: "effective tax rate is outside 0-100% for the fiscal year ending 2025-12-31",
    });
    expect(benefit.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: -0.1 });
    expect(benefit.metric("roic")).toMatchObject({ status: "not-meaningful" });
    expect(noCapital.metric("roic")).toMatchObject({
      status: "not-meaningful",
      reason: "invested capital is zero or negative at the fiscal year end 2025-12-31",
    });
    for (const result of [negative, unclamped, benefit, noCapital]) {
      expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    }
    const happy = context(usGaap());
    for (const metric of operatingRatiosSection(happy).section.metrics) {
      const forged = operatingRatiosSection(happy).section.metrics.map((candidate) =>
        candidate.id === metric.id
          ? { ...candidate, status: "not-meaningful", value: undefined, reason: "forged" }
          : candidate,
      );
      expect(invariantRun(happy, forged), metric.id).toThrow("not-meaningful hits a bound");
    }
  });

  test("R3: a depository issuer has no FCF margin, interest coverage or ROIC", () => {
    const result = evaluate(context(usGaap(), { depositorySic: "6022" }));

    for (const id of ["freeCashFlowMargin", "interestCoverage", "roic"]) {
      expect(result.metric(id)).toMatchObject({ status: "not-applicable", inputs: [] });
      expect(result.metric(id).reason).toContain("depository issuer (SIC 6022)");
    }
    expect(result.metric("ebitdaProxy").status).toBe("value");
    expect(result.metric("effectiveTaxRate").status).toBe("value");
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  });

  test("a stale fiscal year is missing, never an old value", () => {
    const result = evaluate(context(usGaap(), {}, "us-gaap", "2028-07-01T00:00:00.000Z"));

    expect(result.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "stale income tax expense as of 2025-12-31",
    });
    expect(result.metric("roic").reason).toBe("stale operating income as of 2025-12-31");
  });

  test("never-filed inputs, debt included, are diagnostic; a filed instant missing at the year end stays material", () => {
    const unfiled = evaluate(
      context(
        usGaap({
          InterestExpense: undefined,
          DepreciationDepletionAndAmortization: undefined,
          CashAndCashEquivalentsAtCarryingValue: undefined,
        }),
      ),
    );
    const noDebt = evaluate(context(usGaap({ LongTermDebt: undefined })));
    const mixed = evaluate(
      context(
        usGaap({
          CashAndCashEquivalentsAtCarryingValue: undefined,
          StockholdersEquity: instant((year) => (year === 2025 ? undefined : 700)),
        }),
      ),
    );

    expect(unfiled.metric("interestCoverage")).toMatchObject({
      status: "missing",
      reason: "interest expense not filed by the issuer",
      cause: "not-filed",
      periodEnd: "2025-12-31",
    });
    expect(unfiled.metric("ebitdaProxy").cause).toBe("not-filed");
    expect(unfiled.metric("roic")).toMatchObject({
      status: "missing",
      reason: "cash and cash equivalents not filed by the issuer",
      cause: "not-filed",
    });
    expect(unfiled.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(
      invariantRun(
        context(
          usGaap({
            InterestExpense: undefined,
            DepreciationDepletionAndAmortization: undefined,
            CashAndCashEquivalentsAtCarryingValue: undefined,
          }),
        ),
        unfiled.section.metrics,
      ),
    ).not.toThrow();
    expect(noDebt.ctx.statements?.unfiledSeries).toContain("debt");
    expect(noDebt.metric("roic")).toMatchObject({
      status: "missing",
      reason: "debt not filed by the issuer",
      cause: "not-filed",
    });
    expect(noDebt.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(invariantRun(noDebt.ctx, noDebt.section.metrics)).not.toThrow();
    const otherYearDebt = evaluate(
      context(
        usGaap({
          LongTermDebt: undefined,
          NotesPayableCurrent: instant((year) => (year === 2024 ? 400 : undefined)),
        }),
      ),
    );
    expect(otherYearDebt.ctx.statements?.unfiledSeries).not.toContain("debt");
    expect(otherYearDebt.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no debt at the fiscal year end 2025-12-31",
    });
    expect(otherYearDebt.metric("roic").cause).toBeUndefined();
    expect(otherYearDebt.sourceGaps[0]?.triage).toBe("material");
    const zeroDebt = evaluate(context(usGaap({ LongTermDebt: instant(() => 0) })));
    expect(zeroDebt.metric("roic")).toMatchObject({ status: "value", value: 160 / 600 });
    expect(mixed.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no stockholders' equity at the fiscal year end 2025-12-31",
    });
    expect(mixed.metric("roic").cause).toBeUndefined();
  });

  test("unselected IFRS debt stays filed and makes ROIC and Financial Strength gaps material", () => {
    for (const [concept, debt] of [
      ["BondsIssued", instant(() => 400, "EUR")],
      [
        "CurrentPortionOfLongtermBorrowings",
        { units: { shares: [fact(400, 2010, { form: "6-K" })] } },
      ],
      ["BondsIssued", { units: { shares: [null] } }],
      ["BondsIssued", { units: { shares: [{ filed: "invalid" }] } }],
    ] as const) {
      const concepts = {
        Revenue: flow(() => 1000, "EUR"),
        CashFlowsFromUsedInOperatingActivities: flow(() => 300, "EUR"),
        PurchaseOfPropertyPlantAndEquipment: flow(() => 100, "EUR"),
        ProfitLossFromOperatingActivities: flow(() => 200, "EUR"),
        InterestExpense: flow(() => 40, "EUR"),
        DepreciationAndAmortisationExpense: flow(() => 50, "EUR"),
        IncomeTaxExpenseContinuingOperations: flow(() => 32, "EUR"),
        ProfitLossBeforeTax: flow(() => 160, "EUR"),
        Equity: instant(() => 700, "EUR"),
        CashAndCashEquivalents: instant(() => 100, "EUR"),
        [concept]: debt,
      };
      const ctx = context(concepts, {}, "ifrs-full");
      const result = evaluate(ctx);
      const payload = { cik: 1, facts: { "ifrs-full": concepts } };

      expect(result.metric("roic")).toMatchObject({
        status: "missing",
        reason: "no debt at the fiscal year end 2025-12-31",
      });
      expect(result.metric("roic").cause).toBeUndefined();
      expect(result.sourceGaps[0]?.triage).toBe("material");
      expect(ctx.statements?.unfiledSeries).not.toContain("debt");
      expect(ctx.statements?.statements.balanceSheet.debt.annual).toEqual([]);
      expect(ctx.statements?.statements.balanceSheet.debt.interim).toEqual([]);
      expect(invariantRun(ctx, result.section.metrics, payload)).not.toThrow();

      const lens = financialLensMetrics(ctx);
      for (const id of [
        "debt",
        "netDebt",
        "debtToEquity",
        "debtToMarketCap",
        "netDebtToMarketCap",
      ]) {
        const metric = lens.lensMetrics["Financial Strength"].find((row) => row.id === id);
        expect(metric, id).toMatchObject({ status: "missing" });
        expect(metric?.cause, id).toBeUndefined();
      }
      expect(
        lens.sourceGaps.find((gap) => gap.source === "financial-lens-financial-strength")?.triage,
      ).toBe("material");

      const forgedCtx = {
        ...ctx,
        statements: {
          ...ctx.statements!,
          unfiledSeries: [...(ctx.statements?.unfiledSeries ?? []), "debt" as const],
        },
      };
      const forged = operatingRatiosSection(forgedCtx);
      expect(invariantRun(forgedCtx, forged.section.metrics, payload)).toThrow(
        `debt unfiled but ifrs-full:${concept} has facts`,
      );
    }
  });

  test("the fixture invariant re-derives values and rejects forged lineage or causes", () => {
    const ctx = context(usGaap());
    const { section } = operatingRatiosSection(ctx);
    const forged = (id: string, change: (metric: Record<string, unknown>) => unknown) =>
      section.metrics.map((metric) =>
        metric.id === id ? change(metric as unknown as Record<string, unknown>) : metric,
      );
    const forgedInput = (id: string, index: number, patch: Record<string, unknown>) =>
      forged(id, (metric) => ({
        ...metric,
        inputs: (metric.inputs as readonly Record<string, unknown>[]).map((input, at) =>
          at === index ? { ...input, ...patch } : input,
        ),
      }));

    expect(invariantRun(ctx, section.metrics)).not.toThrow();
    for (const id of section.metrics.map((metric) => metric.id)) {
      expect(
        invariantRun(
          ctx,
          forged(id, (metric) => ({ ...metric, value: 0.123 })),
        ),
        id,
      ).toThrow(`operating-ratios.${id}`);
    }
    expect(
      invariantRun(
        ctx,
        forgedInput("roic", 3, {
          periodKey: "instant|2024-12-31",
          periodEnd: "2024-12-31",
          value: 700,
        }),
      ),
    ).toThrow("instants sit at the flow period end");
    expect(
      invariantRun(
        ctx,
        forgedInput("interestCoverage", 1, {
          periodKey: "duration:12|2024-12-31",
          periodStart: "2024-01-01",
          periodEnd: "2024-12-31",
        }),
      ),
    ).toThrow("flow inputs join one period");
    expect(
      invariantRun(
        ctx,
        forged("interestCoverage", (metric) => ({
          ...metric,
          status: "missing",
          value: undefined,
          cause: "not-filed",
          reason: "interest expense not filed by the issuer",
        })),
      ),
    ).toThrow("not-filed needs one of its own inputs unfiled");
    expect(
      invariantRun(
        ctx,
        forged("roic", (metric) => ({
          ...metric,
          status: "not-applicable",
          inputs: [],
          sourceIds: [],
        })),
      ),
    ).toThrow("not-applicable iff the issuer is a depository");
    for (const id of section.metrics.map((metric) => metric.id)) {
      expect(
        invariantRun(
          ctx,
          forged(id, (metric) => ({
            ...metric,
            status: "missing",
            value: undefined,
            reason: "no same-period input",
          })),
        ),
        id,
      ).toThrow(`operating-ratios.${id} missing has a filed input that fails to resolve`);
    }
    expect(
      invariantRun(
        ctx,
        section.metrics.filter((metric) => metric.id !== "ebitdaProxy"),
      ),
    ).toThrow("operating-ratios carries every metric in order");
  });

  test("renders coverage as a multiple and the EBITDA proxy in currency", () => {
    const { section } = operatingRatiosSection(context(usGaap()));
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID)],
        extras: { metricSections: [section] },
      }),
    );

    expect(markdown).toContain("### Operating Ratios\n");
    expect(markdown).toContain(
      String.raw`- Interest coverage \(operating income / interest expense\): 5.00x`,
    );
    expect(markdown).toContain(String.raw`- Operating income + D&A \(EBITDA proxy\): $250`);
    expect(markdown).toContain("- Free cash flow margin: 20.0%");
  });

  test("qualifies ETR and ROIC when pretax income falls back to the pre-equity-method concept", () => {
    const fallback = usGaap({
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
        undefined,
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments:
        flow(() => 160),
    });
    const scoped = evaluate(context(fallback));
    const plain = evaluate(context(usGaap()));
    const scope =
      "pretax income is pretax income (continuing operations, before equity-method income)";

    for (const id of ["effectiveTaxRate", "roic"]) {
      expect(scoped.metric(id).status, id).toBe("value");
      expect(scoped.metric(id).basis, id).toEndWith(scope);
      expect(plain.metric(id).basis, id).not.toContain("equity-method");
    }
    expect(invariantRun(scoped.ctx, scoped.section.metrics)).not.toThrow();
    expect(
      invariantRun(
        scoped.ctx,
        scoped.section.metrics.map((metric) =>
          metric.id === "roic" ? { ...metric, basis: plain.metric("roic").basis } : metric,
        ),
      ),
    ).toThrow("operating-ratios.roic basis names the pretax scope");
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID)],
        extras: { metricSections: [scoped.section] },
      }),
    );
    expect(markdown).toContain(String.raw`before equity-method income\)`);
  });

  test("every label, basis, reason and gap passes the research-only gate", () => {
    expect(evaluated.length).toBeGreaterThan(8);
    const texts = evaluated.flatMap(({ section, sourceGaps }) => [
      section.title,
      ...section.metrics.flatMap((metric) => [
        metric.label,
        metric.basis,
        metric.reason ?? "",
        ...metric.inputs.map((input) => input.label),
      ]),
      ...sourceGaps.map((gap) => gap.message),
    ]);

    expect(texts.filter((text) => violatesResearchOnly(text) !== null)).toEqual([]);
  });
});

describe("operatingRatiosSection — capex sign", () => {
  test.each([
    [100, { status: "value", value: 0.2 }],
    [0, { status: "value", value: 0.3 }],
    [
      -100,
      {
        status: "not-meaningful",
        reason: `${NEGATIVE_CAPEX_REASON} for the fiscal year ending 2025-12-31`,
      },
    ],
  ])("FCF margin with capex %d", (capex, expected) => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: flow(() => capex) })),
    );
    const metric = result.metric("freeCashFlowMargin");
    expect(metric).toMatchObject(expected);
    expect(metric.inputs.map(({ series }) => series)).toEqual([
      "operatingCashFlow",
      "capitalExpenditure",
      "revenue",
    ]);
    expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
  });
});
