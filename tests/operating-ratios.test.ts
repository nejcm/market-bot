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
const FILINGS_ID = "extended-sec-edgar-test-filings";

function issuer(stateOfIncorporation: string, sic = "3674", entityName = "TEST CORP") {
  return { secIssuer: { stateOfIncorporation, sic, entityName, sourceIds: [FILINGS_ID] } };
}

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

function withoutBridge(ctx: MetricContext): MetricContext {
  const { enterpriseValueBridge: _bridge, ...statements } = ctx.statements!;
  return { ...ctx, statements };
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
    sources: [evidenceSource(SOURCE_ID), evidenceSource(FILINGS_ID)],
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
          ...(ctx.secIssuer === undefined
            ? {}
            : {
                extendedEvidence: {
                  instrument: { symbol: "TEST", assetClass: "equity" },
                  items: [
                    {
                      category: "sec-edgar",
                      title: "TEST SEC Fundamental Evidence",
                      summary: "TEST",
                      sourceIds: [...ctx.secIssuer.sourceIds],
                      observedAt: AS_OF,
                      metrics:
                        ctx.secIssuer.stateOfIncorporation === undefined
                          ? {}
                          : { stateOfIncorporation: ctx.secIssuer.stateOfIncorporation },
                    },
                  ],
                  gaps: [],
                },
              }),
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
            DepreciationAndAmortization: flow((year) => (year === 2024 ? 50 : undefined)),
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

  test("AdjustmentForAmortization only withholds D&A, and a zero component is kept", () => {
    const filed = (year: number, value: number) => ({
      units: {
        USD: [fact(value, year, { start: `${String(year)}-01-01`, end: `${String(year)}-12-31` })],
      },
    });
    const run = (year: number, concepts: Record<string, unknown>) =>
      evaluate(
        context(
          usGaap({
            Revenues: filed(year, 600_000_000),
            OperatingIncomeLoss: filed(year, 10_000_000),
            DepreciationDepletionAndAmortization: undefined,
            DepreciationAndAmortization: undefined,
            ...concepts,
          }),
          {},
          "us-gaap",
          `${String(year + 1)}-07-23T00:00:00.000Z`,
        ),
      ).ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual;
    // DDOG FY2022: 28M AdjustmentForAmortization is contract-cost amortization, so it is never
    // Published as D&A; it still withholds the 27M component sum, which is below the filed 34.629M.
    expect(
      run(2022, {
        Depreciation: filed(2022, 21_000_000),
        AmortizationOfIntangibleAssets: filed(2022, 6_000_000),
        AdjustmentForAmortization: filed(2022, 28_000_000),
      }),
    ).toEqual([]);
    // HRMN FY2023: zero intangible amortization, D&A 12.255M.
    expect(
      run(2023, {
        Depreciation: filed(2023, 12_255_000),
        AmortizationOfIntangibleAssets: filed(2023, 0),
      }),
    ).toMatchObject([{ value: 12_255_000, periodEnd: "2023-12-31" }]);
  });

  test("the D&A retention check fails a dropped LTRX FY2019 or an empty series", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2019, { start: "2018-07-01", end: "2019-06-30" })] },
    });
    // LTRX FY2019: depreciation 464k, zero intangible amortization.
    const concepts = usGaap({
      Revenues: filed(46_000_000),
      OperatingIncomeLoss: filed(1_000_000),
      DepreciationDepletionAndAmortization: undefined,
      DepreciationAndAmortization: undefined,
      Depreciation: filed(464_000),
      AmortizationOfIntangibleAssets: filed(0),
    });
    const result = evaluate(context(concepts, {}, "us-gaap", "2020-07-23T00:00:00.000Z"));
    const statements = result.ctx.statements!;
    const series = statements.statements.cashFlowStatement.depreciationAndAmortization;
    expect(series.annual).toMatchObject([{ value: 464_000, periodEnd: "2019-06-30" }]);
    const raw = { cik: 1, facts: { "us-gaap": concepts } };
    expect(invariantRun(result.ctx, result.section.metrics, raw)).not.toThrow();
    const dropped = {
      ...result.ctx,
      statements: {
        ...statements,
        statements: {
          ...statements.statements,
          cashFlowStatement: {
            ...statements.statements.cashFlowStatement,
            depreciationAndAmortization: { ...series, annual: [], interim: [] },
          },
        },
      },
    };
    expect(invariantRun(dropped, result.section.metrics, raw)).toThrow(/has filed components/u);
  });

  test("a DDA below DA withholds; a zero alias is ignored", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2025-01-01", end: "2025-12-31" })] },
    });
    const run = (total: number, alias: number) =>
      evaluate(
        context(
          usGaap({
            Revenues: filed(3_400_000_000),
            OperatingIncomeLoss: filed(-100_000_000),
            DepreciationDepletionAndAmortization: filed(total),
            DepreciationAndAmortization: filed(alias),
          }),
          {},
          "us-gaap",
          AS_OF,
        ),
      );
    // DDOG FY2025: the filed cash-flow total is the 55.756M alias, so the 49.2M DDA is withheld.
    const ddog = run(49_200_000, 55_756_000);
    // PYPL FY2018: DepreciationAndAmortization was zeroed by the opex reclassification.
    const pypl = run(776_000_000, 0);

    expect(
      ddog.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    expect(
      pypl.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: 776_000_000, concept: "DepreciationDepletionAndAmortization" }]);
  });

  test("a combined D&A below the filed cash-flow D&A lines withholds", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2025-01-01", end: "2025-12-31" })] },
    });
    const result = evaluate(
      context(
        usGaap({
          Revenues: filed(3_400_000_000),
          OperatingIncomeLoss: filed(100_000_000),
          DepreciationDepletionAndAmortization: filed(441_000_000),
          OtherDepreciationAndAmortization: filed(438_000_000),
          DepreciationAndAmortization: filed(400_000_000),
        }),
        {},
        "us-gaap",
        AS_OF,
      ),
    );
    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: 441_000_000 }]);
    const below = evaluate(
      context(
        usGaap({
          Revenues: filed(3_400_000_000),
          OperatingIncomeLoss: filed(100_000_000),
          DepreciationDepletionAndAmortization: filed(400_000_000),
          OtherDepreciationAndAmortization: filed(438_000_000),
        }),
        {},
        "us-gaap",
        AS_OF,
      ),
    );
    expect(
      below.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    expect(below.ctx.statements!.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        periodKey: "duration:12|2025-12-31",
        message: expect.stringMatching(/\(400000000\).*\(438000000\)/u),
      }),
    );
  });

  test.each([
    ["DDOG FY2021", "2021-01-01", "2021-12-31", "0001561550-22-000009", 18_500_000, 22_938_000],
    ["DDOG FY2023", "2023-01-01", "2023-12-31", "0001561550-24-000009", 35_600_000, 44_465_000],
    ["DDOG FY2024", "2024-01-01", "2024-12-31", "0001561550-25-000025", 48_500_000, 54_933_000],
    [
      "CRM FY2026",
      "2025-02-01",
      "2026-01-31",
      "0001108524-26-000060",
      1_200_000_000,
      3_631_000_000,
    ],
    ["EBAY FY2021", "2021-01-01", "2021-12-31", "0001065088-22-000006", 485_000_000, 502_000_000],
  ] as const)(
    "%s DepreciationDepletionAndAmortization below DepreciationAndAmortization withholds",
    (_, start, end, accn, dda, da) => {
      const year = Number(end.slice(0, 4));
      const filed = (value: number) => ({
        units: {
          USD: [fact(value, year, { start, end, accn, filed: `${String(year + 1)}-02-25` })],
        },
      });
      const result = evaluate(
        context(
          usGaap({
            Revenues: filed(1_000_000_000),
            OperatingIncomeLoss: filed(100_000_000),
            DepreciationDepletionAndAmortization: filed(dda),
            DepreciationAndAmortization: filed(da),
          }),
          {},
          "us-gaap",
          `${String(year + 1)}-07-23T00:00:00.000Z`,
        ),
      );

      expect(
        result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
      ).toEqual([]);
      expect(result.ctx.statements!.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "incomplete-composite-series",
          periodKey: `duration:12|${end}`,
          message: expect.stringContaining(
            `DepreciationDepletionAndAmortization (${String(dda)}) is below the same-period DepreciationAndAmortization (${String(da)})`,
          ),
        }),
      );
    },
  );

  test.each([
    // AAPL FY2016 (0000320193-18-000145): DDA 10,505M is the cash-flow line; the lower DA is not proof.
    ["DDA above DA", 10_505_000_000, 8_300_000_000, 10_505_000_000],
    // SPIRE FY2023: 18.228M vs 18.229M rounding.
    ["within tolerance", 18_228_000, 18_229_000, 18_228_000],
    ["agreeing tags", 50_000_000, 50_000_000, 50_000_000],
    ["DDA only", 50_000_000, undefined, 50_000_000],
    ["zero DA", 50_000_000, 0, 50_000_000],
  ] as const)("D&A split guard keeps DDA with %s", (_, dda, da, expected) => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2025-01-01", end: "2025-12-31" })] },
    });
    const result = evaluate(
      context(
        usGaap({
          Revenues: filed(1_000_000_000),
          OperatingIncomeLoss: filed(100_000_000),
          DepreciationDepletionAndAmortization: filed(dda),
          DepreciationAndAmortization: da === undefined ? undefined : filed(da),
        }),
        {},
        "us-gaap",
        AS_OF,
      ),
    );

    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: expected, concept: "DepreciationDepletionAndAmortization" }]);
  });

  test("AMD FY2023-25 component D&A below cash-flow D&A plus intangible add-back withholds", () => {
    // AMD 10-K 0000002488-26-000018: Depreciation + AmortizationOfIntangibleAssets vs filed cash-flow lines.
    const years = [
      { start: "2023-01-01", end: "2023-12-30", dep: 441, amort: 2800, other: 642, add: 2811 },
      { start: "2023-12-31", end: "2024-12-28", dep: 454, amort: 2400, other: 671, add: 2393 },
      { start: "2024-12-29", end: "2025-12-27", dep: 521, amort: 2300, other: 750, add: 2254 },
    ];
    const filed = (pick: (year: (typeof years)[number]) => number) => ({
      units: {
        USD: years.map((year) =>
          fact(pick(year) * 1_000_000, Number(year.end.slice(0, 4)), {
            start: year.start,
            end: year.end,
            accn: "0000002488-26-000018",
            fy: 2025,
            filed: "2026-02-04",
          }),
        ),
      },
    });
    const concepts = (adjustment: (year: (typeof years)[number]) => number) =>
      usGaap({
        Revenues: filed(() => 25_000),
        OperatingIncomeLoss: filed(() => 1000),
        DepreciationDepletionAndAmortization: undefined,
        DepreciationAndAmortization: undefined,
        Depreciation: filed((year) => year.dep),
        AmortizationOfIntangibleAssets: filed((year) => year.amort),
        OtherDepreciationAndAmortization: filed((year) => year.other),
        AdjustmentForAmortization: filed(adjustment),
      });
    const withheld = evaluate(
      context(
        concepts((year) => year.add),
        {},
        "us-gaap",
        AS_OF,
      ),
    );
    const zero = evaluate(
      context(
        concepts(() => 0),
        {},
        "us-gaap",
        AS_OF,
      ),
    );

    expect(
      withheld.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    for (const [end, published, cashFlow] of [
      ["2023-12-30", 3_241_000_000, 3_453_000_000],
      ["2024-12-28", 2_854_000_000, 3_064_000_000],
      ["2025-12-27", 2_821_000_000, 3_004_000_000],
    ] as const) {
      expect(withheld.ctx.statements!.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "incomplete-composite-series",
          periodKey: `duration:12|${end}`,
          message: expect.stringContaining(
            `(${String(published)}) is below the filed cash-flow D&A lines (${String(cashFlow)})`,
          ),
        }),
      );
    }
    expect(
      zero.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual.map(
        (row) => row.value,
      ),
    ).toEqual([3_241_000_000, 2_854_000_000, 2_821_000_000]);
  });

  test("AMD FY2020-22 depreciation without an amortization component withholds with a gap", () => {
    // AMD 10-K 0000002488-23-000047: Depreciation and OtherDepreciationAndAmortization only, no DA total.
    const years = [
      { start: "2019-12-29", end: "2020-12-26", dep: 217, other: 312 },
      { start: "2020-12-27", end: "2021-12-25", dep: 296, other: 407 },
      { start: "2021-12-26", end: "2022-12-31", dep: 439, other: 4174 },
    ];
    const filed = (pick: (year: (typeof years)[number]) => number) => ({
      units: {
        USD: years.map((year) =>
          fact(pick(year) * 1_000_000, Number(year.end.slice(0, 4)), {
            start: year.start,
            end: year.end,
            accn: "0000002488-23-000047",
            fy: 2022,
            filed: "2023-02-27",
          }),
        ),
      },
    });
    const result = evaluate(
      context(
        usGaap({
          Revenues: filed(() => 20_000),
          OperatingIncomeLoss: filed(() => 1000),
          DepreciationDepletionAndAmortization: undefined,
          DepreciationAndAmortization: undefined,
          Depreciation: filed((year) => year.dep),
          OtherDepreciationAndAmortization: filed((year) => year.other),
        }),
        {},
        "us-gaap",
        AS_OF,
      ),
    );

    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toEqual([]);
    for (const year of years) {
      expect(result.ctx.statements!.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "incomplete-composite-series",
          seriesKey: "depreciationAndAmortization",
          periodKey: `duration:12|${year.end}`,
          message: expect.stringContaining(
            `no AmortizationOfIntangibleAssets component; the filed cash-flow line (OtherDepreciationAndAmortization ${String(year.other * 1_000_000)})`,
          ),
        }),
      );
    }
  });

  test("HLIT FY2025 depreciation with no amortization or cash-flow D&A line withholds with a gap", () => {
    // HLIT 10-K 0001193125-26-067506: Depreciation 11,082K only.
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2025-01-01", end: "2025-12-31" })] },
    });
    const run = (depreciation: ReturnType<typeof filed> | undefined) =>
      evaluate(
        context(
          usGaap({
            Revenues: filed(300_000_000),
            OperatingIncomeLoss: filed(10_000_000),
            DepreciationDepletionAndAmortization: undefined,
            DepreciationAndAmortization: undefined,
            Depreciation: depreciation,
          }),
          {},
          "us-gaap",
          AS_OF,
        ),
      ).ctx.statements!;
    const withheld = run(filed(11_082_000));
    const unfiled = run(undefined);

    expect(withheld.statements.cashFlowStatement.depreciationAndAmortization.annual).toEqual([]);
    expect(withheld.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        seriesKey: "depreciationAndAmortization",
        periodKey: "duration:12|2025-12-31",
        message: expect.stringContaining(
          "no AmortizationOfIntangibleAssets component; no filed fact proves the filed components are total D&A",
        ),
      }),
    );
    expect(
      unfiled.omissionNotes.filter((note) => note.seriesKey === "depreciationAndAmortization"),
    ).toEqual([]);
    expect(withheld.unfiledSeries).not.toContain("depreciationAndAmortization");
    expect(unfiled.unfiledSeries).toContain("depreciationAndAmortization");
  });

  test("AMD FY2025 with its cash-flow D&A tags stripped publishes the component sum (accepted residual risk)", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2024-12-29", end: "2025-12-27" })] },
    });
    const result = evaluate(
      context(
        usGaap({
          Revenues: filed(34_639_000_000),
          OperatingIncomeLoss: filed(3_694_000_000),
          DepreciationDepletionAndAmortization: undefined,
          DepreciationAndAmortization: undefined,
          Depreciation: filed(521_000_000),
          AmortizationOfIntangibleAssets: filed(2_300_000_000),
        }),
        {},
        "us-gaap",
        AS_OF,
      ),
    );

    expect(result.metric("ebitdaProxy")).toMatchObject({ status: "value", value: 6_515_000_000 });
  });

  test("component D&A stays when the cash-flow decomposition agrees", () => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: "2025-01-01", end: "2025-12-31" })] },
    });
    // Rackspace FY2025: depreciation 151.4M + amortization 146.9M equals OtherDepreciationAndAmortization 298.3M.
    const concepts = usGaap({
      Revenues: filed(2_700_000_000),
      OperatingIncomeLoss: filed(-100_000_000),
      DepreciationDepletionAndAmortization: undefined,
      DepreciationAndAmortization: undefined,
      Depreciation: filed(151_400_000),
      AmortizationOfIntangibleAssets: filed(146_900_000),
      OtherDepreciationAndAmortization: filed(298_300_000),
    });
    const result = evaluate(context(concepts, {}, "us-gaap", "2026-07-23T00:00:00.000Z"));

    expect(
      result.ctx.statements!.statements.cashFlowStatement.depreciationAndAmortization.annual,
    ).toMatchObject([{ value: 298_300_000 }]);
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
    expect(sections?.find(({ id }) => id === "operating-ratios")?.notes).toEqual([
      ...statements.omissionNotes
        .filter(({ code }) => code === "unchecked-extension-capex")
        .map(({ message }) => message),
      ...notes.map(({ message }) => message),
    ]);
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
    "missing %s withholds D&A with a gap, not the not-filed cause",
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
        reason:
          "no same-period depreciation and amortization for the fiscal year ending 2025-12-31",
      });
      expect(result.metric("ebitdaProxy").cause).toBeUndefined();
      expect(result.ctx.statements!.unfiledSeries).not.toContain("depreciationAndAmortization");
      expect(result.ctx.statements!.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "incomplete-composite-series",
          seriesKey: "depreciationAndAmortization",
          periodKey: "duration:12|2025-12-31",
          message: expect.stringContaining(
            `no ${missing} component; no filed fact proves the filed components are total D&A`,
          ),
        }),
      );
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

  test("AMD FY2025 negative effective rate falls back to the 21% US statutory rate", () => {
    const year = (value: number) => ({
      units: {
        USD: [
          fact(value, 2025, {
            start: "2024-12-29",
            end: "2025-12-27",
            accn: "0000002488-26-000018",
          }),
        ],
      },
    });
    const at = (value: number) => ({
      units: { USD: [fact(value, 2025, { start: undefined, end: "2025-12-27" })] },
    });
    const amd = usGaap({
      OperatingIncomeLoss: year(3694e6),
      IncomeTaxExpenseBenefit: year(-103e6),
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
        year(4140e6),
      StockholdersEquity: at(62_999e6),
      LongTermDebt: at(3222e6),
      CashAndCashEquivalentsAtCarryingValue: at(5539e6),
      ShortTermInvestments: at(5013e6),
    });
    const result = evaluate(context(amd, issuer("DE")));
    expect(result.metric("effectiveTaxRate").value).toBeCloseTo(-103 / 4140, 12);
    expect(result.metric("roic").status).toBe("value");
    expect(result.metric("roic").value).toBeCloseTo((3694 * 0.79) / 55_669, 12);
    expect(result.metric("roic").basis).toContain(
      "NOPAT at the 21% US federal statutory rate (issuer incorporated in DE) because the effective tax rate is outside 0-100%",
    );
    expect(result.metric("roic").inputs.at(-1)).toMatchObject({
      label: "state of incorporation",
      value: "DE",
      key: "stateOfIncorporation",
      sourceIds: [FILINGS_ID],
    });
    expect(result.metric("roic").sourceIds).toContain(FILINGS_ID);
    expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    expect(evaluate(context(amd)).metric("roic")).toMatchObject({ status: "not-meaningful" });
  });

  test.each([
    ["positive rate ignores the statutory rate", 32, 160, "DE", "value", (200 * 0.8) / 1000],
    ["rate over 100% at 21%", 200, 160, "NY", "value", (200 * 0.79) / 1000],
    ["non-US incorporation", -16, 160, "L2", "not-meaningful", undefined],
    ["Puerto Rico is foreign for US federal tax", -16, 160, "PR", "not-meaningful", undefined],
    ["pretax loss", 10, -40, "DE", "not-meaningful", undefined],
  ] as const)("ROIC tax fallback: %s", (_name, tax, pretax, state, status, value) => {
    const result = evaluate(
      context(
        usGaap({
          IncomeTaxExpenseBenefit: flow(() => tax),
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            flow(() => pretax),
        }),
        issuer(state),
      ),
    );
    expect(result.metric("roic").status).toBe(status);
    if (value !== undefined) {
      expect(result.metric("roic").value).toBeCloseTo(value, 12);
    }
    expect(result.metric("roic").basis.includes("NOPAT at the")).toBe(
      status === "value" && tax / pretax > 1,
    );
    expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
  });

  test.each([
    ["2017-01-01", "2017-12-31", 0.35],
    ["2017-01-01", "2017-12-30", 0.35],
    ["2017-12-31", "2018-12-29", 0.21],
    ["2017-07-02", "2018-06-30", undefined],
  ] as const)("ROIC statutory rate for a fiscal year %s to %s", (start, end, rate) => {
    const filed = (value: number) => ({
      units: { USD: [fact(value, 2017, { start, end })] },
    });
    const at = (value: number) => ({
      units: { USD: [fact(value, 2017, { start: undefined, end })] },
    });
    const result = evaluate(
      context(
        usGaap({
          OperatingIncomeLoss: filed(200),
          IncomeTaxExpenseBenefit: filed(-16),
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            filed(160),
          StockholdersEquity: at(700),
          LongTermDebt: at(400),
          CashAndCashEquivalentsAtCarryingValue: at(100),
        }),
        issuer("DE"),
        "us-gaap",
        "2019-01-15T00:00:00.000Z",
      ),
    );
    expect(result.metric("roic")).toMatchObject(
      rate === undefined
        ? {
            status: "not-meaningful",
            reason: `effective tax rate is outside 0-100% and the fiscal year has no single US federal statutory rate for the fiscal year ending ${end}`,
          }
        : { status: "value" },
    );
    if (rate !== undefined) {
      expect(result.metric("roic").value).toBeCloseTo((200 * (1 - rate)) / 1000, 12);
    }
  });

  test.each([
    [
      "REIT SIC 6798",
      issuer("DE", "6798", "WELLTOWER INC."),
      "the issuer files under SIC 6798 (REIT)",
    ],
    [
      "partnership name",
      issuer("DE", "4922", "ENTERPRISE PRODUCTS PARTNERS L.P."),
      "indicates a partnership",
    ],
    [
      "LLC with EDGAR state tag",
      issuer("DE", "4911", "EXAMPLE ENERGY LLC /DE/"),
      "indicates a partnership",
    ],
    ["dotted LLC", issuer("DE", "4911", "FOO L.L.C."), "indicates a partnership"],
    ["undotted-end LLC", issuer("DE", "4911", "FOO L.L.C"), "indicates a partnership"],
    [
      "dotted LLC with state tag",
      issuer("DE", "4911", "FOO L.L.C. /DE/"),
      "indicates a partnership",
    ],
    ["dotted LP", issuer("DE", "4922", "FOO L.P."), "indicates a partnership"],
    [
      "missing SIC",
      { secIssuer: { stateOfIncorporation: "DE", sourceIds: [FILINGS_ID] } },
      "SIC was not collected",
    ],
  ] as const)(
    "ROIC statutory fallback withholds an uncertain tax regime: %s",
    (_name, overrides, reason) => {
      const result = evaluate(
        context(usGaap({ IncomeTaxExpenseBenefit: flow(() => -16) }), overrides),
      );
      expect(result.metric("roic").status).toBe("not-meaningful");
      expect(result.metric("roic").reason).toContain(reason);
      expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    },
  );

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
      reason:
        "effective tax rate is outside 0-100% and state of incorporation was not collected for the fiscal year ending 2025-12-31",
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

  test("ROIC invested capital subtracts short-term investments, and withholds when they are unresolved", () => {
    // MSFT FY2026 10-K ($M): ROIC was 0.2710 when invested capital kept the $55,908M short-term investments.
    const msft = usGaap({
      OperatingIncomeLoss: flow(() => 155_237),
      IncomeTaxExpenseBenefit: flow(() => 32_185),
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
        flow(() => 165_934),
      StockholdersEquity: instant(() => 442_387),
      LongTermDebt: instant(() => 40_294),
      CashAndCashEquivalentsAtCarryingValue: instant(() => 20_935),
      ShortTermInvestments: instant(() => 55_908),
    });
    const result = evaluate(context(msft));
    const roic = result.metric("roic");

    expect(roic.status).toBe("value");
    expect(roic.value).toBeCloseTo(
      (155_237 * (1 - 32_185 / 165_934)) / (442_387 + 40_294 - 20_935 - 55_908),
      12,
    );
    expect(roic.value).toBeCloseTo(0.3083, 4);
    expect(roic.inputs.at(-1)).toMatchObject({ value: 55_908, key: "ShortTermInvestments" });
    expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();

    const unclassified = evaluate(
      context({ ...msft, CashCashEquivalentsAndShortTermInvestments: instant(() => 90_000) }),
    );
    expect(unclassified.metric("roic")).toMatchObject({ status: "missing" });
    expect(unclassified.metric("roic").reason).toContain("does not equal ShortTermInvestments");

    const noBridge = evaluate(withoutBridge(context(msft)));
    expect(noBridge.metric("roic")).toMatchObject({ status: "missing" });
    expect(noBridge.metric("roic").reason).toContain("EV bridge");
    expect(noBridge.metric("roic").cause).toBeUndefined();
    const unfiledFlow = evaluate(
      withoutBridge(context({ ...msft, IncomeTaxExpenseBenefit: undefined })),
    );
    expect(unfiledFlow.metric("roic")).toMatchObject({ status: "missing", cause: "not-filed" });
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
