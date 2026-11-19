import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGapReportText } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/sources";
import { renderMarkdownReport } from "../src/report/markdown";
import { validateResearchReport } from "../src/report/schema";
import { projectExtendedEvidenceReportExtras } from "../src/research/extended-evidence-projections";
import { deriveCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import { resolveMetricReferences } from "../src/research/metric-references";
import { capitalReturnSection } from "../src/sources/extended-evidence/capital-return";
import { financialStatementSeriesByKey } from "../src/sources/extended-evidence/financial-statement-selection";
import { noFact } from "../src/sources/extended-evidence/financial-lens-inputs";
import { NEGATIVE_CAPEX_REASON } from "../src/sources/extended-evidence/financial-statement-definitions";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  readFinancialStatementsArtifact,
  type FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import type { MetricContext, MetricInput } from "../src/sources/extended-evidence/metric-engine";
import { resolveMarketSnapshotPriceAsOf } from "../src/domain/market-data";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertMetricSectionInvariants } from "./support/run-fixtures/assertions";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const QUOTE_SOURCE_ID = "yahoo-quote-test";
const AS_OF = "2026-07-23T00:00:00.000Z";
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

type Fact = Record<string, unknown>;
type MetricRecord = Record<string, unknown>;

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

function dps(year: number): number {
  return 0.4 + 0.04 * (year - 2019);
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
    CommonStockDividendsPerShareDeclared: series("USD/shares", (year) => dps(year)),
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

function quoteless({ quote: _quote, ...rest }: MetricContext): MetricContext {
  return rest;
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

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function yearsFrom(from: number): number[] {
  return Array.from({ length: 2026 - from }, (_, index) => from + index);
}

function annualFrom(from: number, unit: string, value: (year: number) => number): Fact {
  return { units: { [unit]: yearsFrom(from).map((year) => fy(value(year), year)) } };
}

function filedAs(concept: Fact, end: string, accn: string): Fact {
  const units = concept.units as Record<string, Fact[]>;
  return {
    units: Object.fromEntries(
      Object.entries(units).map(([unit, rows]) => [
        unit,
        rows.map((row) => (row.end === end ? { ...row, accn } : row)),
      ]),
    ),
  };
}

function earliestPaidWithAccession(ctx: MetricContext) {
  const metric = evaluate(ctx).metric("earliestDividendFyInHistory");
  const [input] = metric.inputs as readonly MetricInput[];
  const fact = ctx.statements?.earliestCommonDividendPaid;
  return {
    metric,
    accession:
      input?.series === "dividendsPaid" && input.periodKey === fact?.periodKey
        ? fact?.accessionNumber
        : undefined,
  };
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
    expect(result.metric("dpsLatestFy")).toMatchObject({
      status: "value",
      unit: "currency-per-share",
      currency: "USD",
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPerShare", unit: "USD/shares" }],
    });
    expect(result.metric("dpsLatestFy").value).toBeCloseTo(dps(2025), 12);
    expect(result.metric("dpsCagr3y").value).toBeCloseTo(
      (dps(2025) / dps(2022)) ** (1 / 3) - 1,
      12,
    );
    expect(result.metric("dpsCagr5y").value).toBeCloseTo(
      (dps(2025) / dps(2020)) ** (1 / 5) - 1,
      12,
    );
    expect(
      resolveMetricReferences(
        researchReport({
          keyFindings: [{ text: "DPS grew <<metric:capital-return.dpsCagr3y>>.", sourceIds: [] }],
        }),
        [{ id: "capital-return", title: "Capital return", metrics: [result.metric("dpsCagr3y")] }],
      ).keyFindings[0]!.text,
    ).toMatch(/^DPS grew \+\d+\.\d% \(Dividends per share growth \(3y CAGR\)\)\.$/u);
    expect(result.metric("earliestDividendFyInHistory")).toMatchObject({
      status: "value",
      value: "FY2019 or earlier",
      periodEnd: "2019-12-31",
    });
    expect(result.sourceGaps).toEqual([]);
  });

  // Equinix run 3151f393: Declared skips FY2019-21, cash paid fills them; 5y is (18.76 / 10.64)^(1/5) - 1.
  test("EQIX-shaped: a cash-paid endpoint computes the CAGR and the basis names both bases", () => {
    const eqix: Record<number, number> = {
      2019: 9.84,
      2020: 10.64,
      2021: 11.48,
      2022: 12.4,
      2023: 14.49,
      2024: 17.04,
      2025: 18.76,
    };
    const result = evaluate(
      context(
        usGaap({
          WeightedAverageNumberOfDilutedSharesOutstanding: series("shares", () => 100),
          PaymentsOfDividends: series("USD", (year) => eqix[year]! * 100),
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year >= 2022 ? eqix[year] : undefined,
          ),
          CommonStockDividendsPerShareCashPaid: series("USD/shares", (year) => eqix[year]),
        }),
      ),
    );

    expect(result.metric("dpsCagr5y").value).toBeCloseTo(0.12, 3);
    expect(result.metric("dpsCagr5y").basis).toEndWith(
      "the endpoints differ in basis, cash paid per share for the year ending 2020-12-31 and declared per share for 2025-12-31, so payment timing can differ",
    );
    expect(result.metric("dpsCagr3y").basis).toBe(
      "compound annual change in dividends per share, latest fiscal year vs the fiscal year 3y earlier",
    );
  });

  // EQIX 10-K 0001101239-26-000032 and priors tag DPS FY2015-FY2025; the 10-period cap drops FY2015.
  test("EQIX-shaped: a capped dividend history reads its earliest year as an upper bound", () => {
    const declared: Record<number, number> = {
      2015: 17.71,
      2016: 7,
      2017: 8,
      2018: 9.12,
      2019: 9.84,
      2020: 10.64,
      2021: 11.48,
      2022: 12.4,
      2023: 14.49,
      2024: 17.04,
      2025: 18.76,
    };
    const years = (from: number) =>
      Object.keys(declared)
        .map(Number)
        .filter((year) => year >= from);
    const annual = (from: number, unit: string, value: (year: number) => number) => ({
      units: { [unit]: years(from).map((year) => fy(value(year), year)) },
    });
    const earliest = (from: number) =>
      evaluate(
        context(
          usGaap({
            NetCashProvidedByUsedInOperatingActivities: annual(2015, "USD", () => 400),
            WeightedAverageNumberOfDilutedSharesOutstanding: annual(from, "shares", () => 100),
            PaymentsOfDividends: annual(from, "USD", (year) => declared[year]! * 100),
            CommonStockDividendsPerShareDeclared: annual(
              from,
              "USD/shares",
              (year) => declared[year]!,
            ),
          }),
        ),
      ).metric("earliestDividendFyInHistory");

    expect(earliest(2015)).toMatchObject({
      status: "value",
      value: "FY2016 or earlier",
      periodEnd: "2016-12-31",
    });
    expect(earliest(2016)).toMatchObject({
      status: "value",
      value: "FY2016",
      periodEnd: "2016-12-31",
    });
  });

  // CALX-shaped: only the capped-out FY2015 declares a positive dividend; retained years declare zero.
  test("a capped history with no positive retained year says retained, not filed, history", () => {
    const years = Array.from({ length: 11 }, (_, index) => 2015 + index);
    const annual = (unit: string, value: (year: number) => number) => ({
      units: { [unit]: years.map((year) => fy(value(year), year)) },
    });
    const result = evaluate(
      context(
        usGaap({
          WeightedAverageNumberOfDilutedSharesOutstanding: annual("shares", () => 100),
          PaymentsOfDividends: annual("USD", (year) => (year === 2015 ? 50 : 0)),
          CommonStockDividendsPerShareDeclared: annual("USD/shares", (year) =>
            year === 2015 ? 0.5 : 0,
          ),
        }),
      ),
    );

    expect(result.metric("earliestDividendFyInHistory")).toMatchObject({
      status: "missing",
      reason:
        "no positive annual dividends per share or common dividends paid fact in retained history",
    });
  });

  describe("earliest dividend year from per-share and common dividends paid evidence", () => {
    const dividendContext = (concepts: Record<string, Fact | undefined>, from = 2015) =>
      context(
        usGaap({
          Revenues: annualFrom(from, "USD", (year) => 1000 + year),
          NetCashProvidedByUsedInOperatingActivities: annualFrom(from - 1, "USD", () => 400),
          WeightedAverageNumberOfDilutedSharesOutstanding: annualFrom(from, "shares", () => 100),
          PaymentsOfDividends: undefined,
          CommonStockDividendsPerShareDeclared: undefined,
          ...concepts,
        }),
      );
    const earliest = (concepts: Record<string, Fact | undefined>, from = 2015) =>
      evaluate(dividendContext(concepts, from)).metric("earliestDividendFyInHistory");

    // Realty Income 10-K 0001104659-17-011170: PaymentsOfDividendsCommonStock FY2016 610,516,000;
    // CommonStockDividendsPerShareCashPaid starts FY2017 (10-K 0000726728-20-000033, 2.527).
    test("O-shaped: common dividends paid sets a year the per-share tag starts after", () => {
      const o = (from: number) =>
        earliest(
          {
            PaymentsOfDividendsCommonStock: annualFrom(from, "USD", () => 610_516_000),
            CommonStockDividendsPerShareCashPaid: annualFrom(2017, "USD/shares", () => 2.527),
          },
          from,
        );

      expect(o(2015)).toMatchObject({
        status: "value",
        value: "FY2015",
        periodEnd: "2015-12-31",
        inputs: [{ series: "dividendsPaid", periodEnd: "2015-12-31", value: 610_516_000 }],
      });
      expect(o(2015).basis).toEndWith(
        "set by common dividends paid (PaymentsOfDividendsCommonStock), which can trail the first declaration; no earlier positive dividends per share",
      );
      expect(o(2016)).toMatchObject({ status: "value", value: "FY2016" });
    });

    test("a shared cap that drops only years after the earliest DPS year adds no bound", () => {
      const result = earliest(
        {
          PaymentsOfDividendsCommonStock: annualFrom(2007, "USD", () => 50),
          CommonStockDividendsPerShareDeclared: {
            units: {
              "USD/shares": yearsFrom(2007)
                .filter((year) => year <= 2016)
                .map((year) => fy(0.5, year)),
            },
          },
        },
        2007,
      );

      expect(result).toMatchObject({ status: "value", value: "FY2007", periodEnd: "2007-12-31" });
      expect(result.inputs).toMatchObject([{ series: "dividendsPerShare" }]);
    });

    // WULF 10-K 0001104659-14-016261: PaymentsOfDividendsCommonStock FY2012 1,998,475, past the cap.
    test.each([
      ["zero", annualFrom(2022, "USD/shares", () => 0)],
      ["positive", annualFrom(2022, "USD/shares", () => 0.1)],
      ["no", undefined],
    ])(
      "WULF-shaped: a capped-away common payment dates the year over %s retained DPS",
      (_, perShare) => {
        const { metric: result, accession } = earliestPaidWithAccession(
          dividendContext(
            {
              PaymentsOfDividendsCommonStock: {
                units: { USD: [fy(1_998_475, 2012, { accn: "0001104659-14-016261" })] },
              },
              CommonStockDividendsPerShareDeclared: perShare,
            },
            2012,
          ),
        );

        expect(accession).toBe("0001104659-14-016261");
        expect(result).toMatchObject({
          status: "value",
          value: "FY2012",
          periodEnd: "2012-12-31",
          inputs: [{ series: "dividendsPaid", value: 1_998_475 }],
        });
      },
    );

    // SLNH 10-K 0001003297-21-000039: PaymentsOfDividendsCommonStock FY2019 3,541,000; the newer
    // Generic PaymentsOfDividends (FY2021 630,000, 10-K 0001753926-22-000384) is the elected series.
    test("SLNH: a common payment hidden by the generic-concept election dates FY2019", () => {
      const ctx = dividendContext(
        {
          PaymentsOfDividendsCommonStock: {
            units: {
              USD: [
                fy(3_541_000, 2019, { accn: "0001003297-21-000039", filed: "2021-03-31" }),
                fy(0, 2020, { accn: "0001003297-21-000039", filed: "2021-03-31" }),
              ],
            },
          },
          PaymentsOfDividends: {
            units: { USD: [fy(630_000, 2021, { accn: "0001753926-22-000384" })] },
          },
        },
        2019,
      );
      const { metric: result, accession } = earliestPaidWithAccession(ctx);

      expect(
        financialStatementSeriesByKey(ctx.statements!, "dividendsPaid")?.annual.map(
          (fact) => fact.concept,
        ),
      ).not.toContain("PaymentsOfDividendsCommonStock");
      expect(accession).toBe("0001003297-21-000039");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2019",
        periodEnd: "2019-12-31",
        inputs: [{ series: "dividendsPaid", value: 3_541_000 }],
      });
    });

    // AMGN 10-K 0001193125-12-086670: PaymentsOfDividendsCommonStock FY2009-10 zero, FY2011 500,000,000;
    // Operating cash flow is filed from FY2007.
    test("AMGN: a first payment after filed zero years is exact", () => {
      const { metric: result, accession } = earliestPaidWithAccession(
        dividendContext(
          {
            NetCashProvidedByUsedInOperatingActivities: annualFrom(
              2007,
              "USD",
              () => 5_401_000_000,
            ),
            PaymentsOfDividendsCommonStock: filedAs(
              annualFrom(2009, "USD", (year) => (year < 2011 ? 0 : 500_000_000)),
              "2011-12-31",
              "0001193125-12-086670",
            ),
          },
          2009,
        ),
      );

      expect(accession).toBe("0001193125-12-086670");
      expect(result).toMatchObject({ status: "value", value: "FY2011", periodEnd: "2011-12-31" });
    });

    // EMR 10-K 0001144204-09-061535: CommonStockDividendsPerShareDeclared FY2007 1.05, FY2008 1.20;
    // 10-K 0001144204-11-066373 starts the elected CashPaid DPS and common paid at FY2009 (1.32, 998M).
    test("EMR: an earlier DPS under an unelected concept bounds the paid-set FY2009", () => {
      const fiscal = (unit: string, years: readonly number[], value: (year: number) => number) => ({
        units: {
          [unit]: years.map((year) =>
            fy(value(year), year, {
              start: `${String(year - 1)}-10-01`,
              end: `${String(year)}-09-30`,
            }),
          ),
        },
      });
      const result = evaluate(
        context({
          Revenues: fiscal("USD", yearsFrom(2007), () => 20_000_000_000),
          NetCashProvidedByUsedInOperatingActivities: fiscal(
            "USD",
            yearsFrom(2007),
            () => 3_016_000_000,
          ),
          WeightedAverageNumberOfDilutedSharesOutstanding: fiscal(
            "shares",
            yearsFrom(2009),
            () => 758_700_000,
          ),
          CommonStockDividendsPerShareDeclared: fiscal("USD/shares", [2007, 2008], (year) =>
            year === 2007 ? 1.05 : 1.2,
          ),
          CommonStockDividendsPerShareCashPaid: fiscal("USD/shares", yearsFrom(2009), () => 1.32),
          PaymentsOfDividendsCommonStock: fiscal("USD", yearsFrom(2009), () => 998_000_000),
        }),
      ).metric("earliestDividendFyInHistory");

      expect(result).toMatchObject({
        status: "value",
        value: "FY2009 or earlier",
        periodEnd: "2009-09-30",
      });
    });

    test("a same-period 10-K/A correcting a payment to zero drops it from the filed bound", () => {
      const paid = {
        units: {
          USD: [
            fy(10, 2020),
            fy(0, 2020, { form: "10-K/A", filed: "2021-06-01", accn: "test-2020-a" }),
            fy(0, 2021),
            fy(25, 2022),
          ],
        },
      };
      const filedEnd = (analysisAsOf: string) =>
        deriveFinancialStatements(
          { facts: { "us-gaap": { PaymentsOfDividendsCommonStock: paid } } },
          { symbol: "TEST", generatedAt: analysisAsOf, analysisAsOf, sourceId: SOURCE_ID },
        ).earliestCommonDividendPaid?.periodEnd;

      expect(filedEnd("2021-05-01T00:00:00.000Z")).toBe("2020-12-31");
      expect(filedEnd(AS_OF)).toBe("2022-12-31");
      expect(earliest({ PaymentsOfDividendsCommonStock: paid }, 2020)).toMatchObject({
        status: "value",
        value: "FY2022 or earlier",
      });
    });

    test("a later zero in another unit does not revise a capped USD payment", () => {
      const usd = annualFrom(2015, "USD", (year) => (year === 2015 ? 10 : 25)).units as Fact;
      const eur = [fy(0, 2015, { filed: "2017-03-01", accn: "test-2015-eur" })];

      expect(
        earliest({ PaymentsOfDividendsCommonStock: { units: { ...usd, EUR: eur } } }),
      ).toMatchObject({ status: "value", value: "FY2015" });
    });

    test("a malformed raw period end never reaches the artifact readers", () => {
      const statements = deriveFinancialStatements(
        {
          facts: {
            "us-gaap": {
              Revenues: annualFrom(2016, "USD", () => 1000),
              PaymentsOfDividendsCommonStock: {
                units: {
                  USD: [
                    fy(5, 2012, { start: "2011-03-01", end: "2012-02-30", filed: "2012-03-15" }),
                    ...yearsFrom(2016).map((year) => fy(25, year)),
                  ],
                },
              },
            },
          },
        },
        { symbol: "TEST", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: SOURCE_ID },
      );

      expect(
        readFinancialStatementsArtifact(JSON.parse(JSON.stringify(statements)))
          ?.earliestCommonDividendPaid?.periodEnd,
      ).toBe("2016-12-31");
    });

    test.each([
      ["PaymentsOfDividendsCommonStock", "USD", "FY2015", "2015-12-31"],
      ["PaymentsOfOrdinaryDividends", "USD", "FY2015", "2015-12-31"],
      ["CommonStockDividendsPerShareDeclared", "USD/shares", "FY2016 or earlier", "2016-12-31"],
    ])(
      "a capped 356-day FY2015 %s keyed by dates dates or bounds the year",
      (concept, unit, value, periodEnd) => {
        const units = [
          fy(1, 2015, { start: "2015-01-09" }),
          ...yearsFrom(2016).map((year) => fy(1, year)),
        ];
        const ocf = annualFrom(2014, "USD", () => 400);
        expect(
          earliest(
            {
              [concept]: { units: { [unit]: units } },
              NetCashProvidedByUsedInOperatingActivities: ocf,
            },
            2016,
          ),
        ).toMatchObject({
          status: "value",
          value,
          periodEnd,
        });
      },
    );

    // CECO 10-K 0001193125-13-109153: PaymentsOfDividendsCommonStock FY2011 728,000; FY2016 8,995,000.
    test("CECO: a capped-away FY2011 payment dates a paid-only history", () => {
      const ceco: Record<number, number> = { 2011: 728_000, 2016: 8_995_000, 2017: 7_792_000 };
      const { metric: result, accession } = earliestPaidWithAccession(
        dividendContext(
          {
            PaymentsOfDividendsCommonStock: filedAs(
              annualFrom(2011, "USD", (year) => (year <= 2017 ? (ceco[year] ?? 5_000_000) : 0)),
              "2011-12-31",
              "0001193125-13-109153",
            ),
          },
          2011,
        ),
      );

      expect(accession).toBe("0001193125-13-109153");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2011",
        periodEnd: "2011-12-31",
        inputs: [{ series: "dividendsPaid", periodStart: "2011-01-01", value: 728_000 }],
      });
      expect(result.basis).toContain("(PaymentsOfDividendsCommonStock)");
    });

    // RELL 10-K 0001387131-18-003556: PaymentsOfDividendsCommonStock FY ended 2016-05-28 3,079,000;
    // 10-K 0001193125-12-319450: PaymentsOfDividends FY ended 2010-05-29 1,399,000, so not exact.
    test("RELL: a capped 52/53-week FY2016 payment is bounded by an earlier generic payment", () => {
      const ends = [
        "2016-05-28",
        "2017-05-27",
        ...Array.from({ length: 9 }, (_, index) => `${String(2018 + index)}-05-31`),
      ];
      const rows = (value: (end: string) => number) =>
        ends.map((end, index) =>
          fy(value(end), Number(end.slice(0, 4)), {
            start: index === 0 ? "2015-05-31" : nextDay(ends[index - 1]!),
            end,
            filed: `${end.slice(0, 4)}-07-20`,
          }),
        );
      const { metric: result, accession } = earliestPaidWithAccession(
        context({
          Revenues: { units: { USD: rows(() => 200_000_000) } },
          NetCashProvidedByUsedInOperatingActivities: { units: { USD: rows(() => 9_000_000) } },
          WeightedAverageNumberOfDilutedSharesOutstanding: {
            units: { shares: rows(() => 13_000_000) },
          },
          PaymentsOfDividends: {
            units: {
              USD: [
                fy(1_399_000, 2010, {
                  start: "2009-05-31",
                  end: "2010-05-29",
                  filed: "2012-07-27",
                  accn: "0001193125-12-319450",
                }),
              ],
            },
          },
          PaymentsOfDividendsCommonStock: filedAs(
            {
              units: {
                USD: rows((end) =>
                  end === "2016-05-28" ? 3_079_000 : end === "2017-05-27" ? 3_031_000 : 3_100_000,
                ),
              },
            },
            "2016-05-28",
            "0001387131-18-003556",
          ),
        }),
      );

      expect(accession).toBe("0001387131-18-003556");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2016 or earlier",
        periodEnd: "2016-05-28",
        inputs: [{ series: "dividendsPaid", periodStart: "2015-05-31", value: 3_079_000 }],
      });
    });

    // DPS x diluted shares below 0.4x of the same year's common paid is withheld as dps-unreconciled.
    const withheldDps = (
      paid: (year: number) => number,
      dpsFor: (year: number) => number,
      dpsFrom: number,
      shares: number,
      [paidEnd, accn]: readonly [string, string] = ["", ""],
      paidFrom = 2015,
    ) =>
      earliestPaidWithAccession(
        dividendContext({
          WeightedAverageNumberOfDilutedSharesOutstanding: annualFrom(2015, "shares", () => shares),
          PaymentsOfDividendsCommonStock: filedAs(annualFrom(paidFrom, "USD", paid), paidEnd, accn),
          CommonStockDividendsPerShareDeclared: annualFrom(dpsFrom, "USD/shares", dpsFor),
        }),
      );

    // ADTN 10-K 0000950123-11-018429: PaymentsOfDividendsCommonStock FY2008 22,919,000;
    // Dps-unreconciled only in later years (FY2019 shown).
    test("ADTN: a later unreconciled DPS year does not withhold the paid-set FY2008", () => {
      // FY2008 is the start of the cash flow history, so it is only an upper bound.
      const { metric: result, accession } = withheldDps(
        (year) => (year === 2008 ? 22_919_000 : 17_400_000),
        (year) => (year === 2019 ? 0.09 : 0.36),
        2018,
        48_000_000,
        ["2008-12-31", "0000950123-11-018429"],
        2008,
      );

      expect(accession).toBe("0000950123-11-018429");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2008 or earlier",
        periodEnd: "2008-12-31",
        inputs: [{ series: "dividendsPaid", value: 22_919_000 }],
      });
    });

    // IRDM 10-K 0001418819-26-000009: PaymentsOfDividendsCommonStock FY2023 64,774,000, FY2021-22 zero;
    // DPS FY2023 is unreconciled in the same year.
    test("IRDM: a same-year unreconciled DPS does not withhold the paid-set FY2023", () => {
      const { metric: result, accession } = withheldDps(
        (year) => (year < 2023 ? 0 : year === 2023 ? 64_774_000 : 66_000_000),
        (year) => (year === 2023 ? 0.13 : 0.54),
        2023,
        125_000_000,
        ["2023-12-31", "0001418819-26-000009"],
      );

      expect(accession).toBe("0001418819-26-000009");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2023",
        periodEnd: "2023-12-31",
        inputs: [{ series: "dividendsPaid", value: 64_774_000 }],
      });
    });

    // RFIL 10-K 0001144204-12-004278: PaymentsOfDividendsCommonStock FY ended 2010-10-31 84,113;
    // CommonStockDividendsPerShareCashPaid FY2012 0.05 and FY2013 0.1 do not reconcile with paid.
    test("RFIL: unreconciled DPS years after the paid-set FY2010 do not withhold it", () => {
      const rfil: Record<number, readonly [number, number]> = {
        2010: [84_113, 0],
        2011: [2_528_971, 0],
        2012: [1_386_751, 0.05],
        2013: [2_349_000, 0.1],
      };
      const years = Object.keys(rfil).map(Number);
      const rows = (unit: string, pick: (year: number) => number) => ({
        units: {
          [unit]: years.flatMap((year) =>
            unit === "USD/shares" && year < 2012
              ? []
              : [
                  fy(pick(year), year, {
                    start: `${String(year - 1)}-11-01`,
                    end: `${String(year)}-10-31`,
                    filed: `${String(year + 1)}-01-20`,
                  }),
                ],
          ),
        },
      });
      const ctx = context({
        Revenues: rows("USD", () => 30_000_000),
        WeightedAverageNumberOfDilutedSharesOutstanding: rows("shares", () => 8_455_631),
        PaymentsOfDividendsCommonStock: filedAs(
          rows("USD", (year) => rfil[year]![0]),
          "2010-10-31",
          "0001144204-12-004278",
        ),
        CommonStockDividendsPerShareCashPaid: rows("USD/shares", (year) => rfil[year]![1]),
      });
      const { metric: result, accession } = earliestPaidWithAccession(ctx);

      expect(
        ctx.statements!.omissionNotes.filter((note) => note.code === "dps-unreconciled"),
      ).not.toHaveLength(0);
      expect(accession).toBe("0001144204-12-004278");
      expect(result).toMatchObject({
        status: "value",
        value: "FY2010 or earlier",
        periodEnd: "2010-10-31",
        inputs: [{ series: "dividendsPaid", value: 84_113 }],
      });
    });

    // AMAT-shaped: generic paid only, so DPS sets the year; an earlier unreconciled DPS year withholds it.
    test("an earlier unreconciled DPS year still withholds an exact DPS-set year", () => {
      const result = earliest({
        WeightedAverageNumberOfDilutedSharesOutstanding: annualFrom(2015, "shares", () => 100),
        PaymentsOfDividends: annualFrom(2015, "USD", () => 36),
        CommonStockDividendsPerShareDeclared: annualFrom(2015, "USD/shares", (year) =>
          year === 2015 ? 0.09 : 0.36,
        ),
      });

      expect(result).toMatchObject({ status: "missing", periodEnd: "2015-12-31" });
      expect(result.reason).toStartWith("dividends per share withheld: ");
    });

    test("DPS-only: per-share evidence sets the year and keeps the plain basis", () => {
      const result = earliest({
        CommonStockDividendsPerShareDeclared: annualFrom(2018, "USD/shares", () => 1),
      });

      expect(result).toMatchObject({ status: "value", value: "FY2018" });
      expect(result.inputs).toMatchObject([{ series: "dividendsPerShare" }]);
      expect(result.basis).not.toContain("set by common dividends paid");
    });

    test.each(["PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"])(
      "paid-only: %s without a per-share tag dates the first year",
      (concept) => {
        const result = earliest({ [concept]: annualFrom(2016, "USD", () => 50) }, 2016);

        expect(result).toMatchObject({ status: "value", value: "FY2016", periodEnd: "2016-12-31" });
        expect(result.basis).toContain(`set by common dividends paid (${concept})`);
      },
    );

    test("preferred-only and generic payments never date a common dividend year", () => {
      const preferred = earliest({
        PaymentsOfDividends: annualFrom(2016, "USD", () => 24),
        PaymentsOfDividendsPreferredStockAndPreferenceStock: annualFrom(2016, "USD", () => 24),
      });

      expect(preferred).toMatchObject({ status: "missing", cause: "not-filed" });
    });

    test("non-payer: zero common dividends paid and zero DPS stay not applicable", () => {
      expect(
        earliest(
          {
            PaymentsOfDividendsCommonStock: annualFrom(2016, "USD", () => 0),
            CommonStockDividendsPerShareDeclared: annualFrom(2016, "USD/shares", () => 0),
          },
          2016,
        ),
      ).toMatchObject({ status: "not-applicable", reason: "no dividend history in filed data" });
    });
  });

  test("GOOG-shaped dividend initiation: the latest FY anchors, earlier years do not matter", () => {
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: series("USD", (year) => (year >= 2024 ? 30 : undefined)),
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year >= 2024 ? 0.2 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 30 });
    expect(result.metric("shareholderYield").value).toBeCloseTo(0.012, 12);
    expect(result.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0.2 });
    expect(result.metric("earliestDividendFyInHistory").value).toBe("FY2024");
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends per share fact 3y before the fiscal year ending 2025-12-31",
    });
    expect(
      result.section.metrics.filter(({ status }) => status !== "value").map(({ id }) => id),
    ).toEqual(["dpsCagr3y", "dpsCagr5y"]);
  });

  test("buybacks-only issuer: never-filed dividends stay missing, never zero, gap diagnostic", () => {
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
        reason: "dividends paid not filed by the issuer",
        cause: "not-filed",
      });
      expect(result.metric(id).value).toBeUndefined();
    }
    expect(result.sourceGaps[0]).toMatchObject({
      source: "capital-return",
      cause: "provider-data-missing",
      triage: "diagnostic",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("PP&E payments under component tags only: not-filed reason names them", () => {
    // HIVE 10-K 0001062993-26-002973, FY ending 2026-03-31: no total capex tag, two component lines.
    const hiveFact = (val: number): Fact => ({
      units: {
        USD: [
          fy(val, 2025, {
            start: "2025-04-01",
            end: "2026-03-31",
            accn: "0001062993-26-002973",
            fy: 2026,
            filed: "2026-06-02",
          }),
        ],
      },
    });
    const components = {
      PaymentsToAcquirePropertyPlantAndEquipment: undefined,
      PaymentsToAcquireMachineryAndEquipment: hiveFact(148_310_000),
      PaymentsToAcquireOtherPropertyPlantAndEquipment: hiveFact(21_573_000),
      PaymentsToAcquireEquipmentOnLease: hiveFact(5_000_000),
    };
    const componentsOnly = context(usGaap(components));
    const note =
      "; capital expenditure has no total line: the issuer has tagged PP&E purchases under component concepts PaymentsToAcquireMachineryAndEquipment and PaymentsToAcquireOtherPropertyPlantAndEquipment, which are not read as total capex";
    expect(componentsOnly.statements?.unfiledSeries).toContain("capitalExpenditure");
    expect(evaluate(componentsOnly).metric("fcfPayoutRatio")).toMatchObject({
      status: "missing",
      cause: "not-filed",
      reason: `capital expenditure not filed by the issuer${note}`,
    });
    expect(noFact(componentsOnly, "capitalExpenditure")).toMatchObject({
      cause: "not-filed",
      reason: `capital expenditure not filed by the issuer${note}`,
    });
    expect(
      evaluate(context(usGaap({ ...components, PaymentsOfDividends: undefined }))).metric(
        "totalPayoutToFcf",
      ),
    ).toMatchObject({
      cause: "not-filed",
      reason: `dividends paid and capital expenditure not filed by the issuer${note}`,
    });
    const withTotal = context(
      usGaap({
        ...components,
        PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 100),
      }),
    );
    expect(withTotal.statements?.capexComponentConcepts).toBeUndefined();
    const noComponents = context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: undefined }));
    expect(noComponents.statements?.capexComponentConcepts).toBeUndefined();
    expect(noFact(noComponents, "capitalExpenditure")).toMatchObject({
      cause: "not-filed",
      reason: "capital expenditure not filed by the issuer",
    });
  });

  test("REIT without PP&E capex: FCF payout metrics are not applicable, others stay not filed", () => {
    const reit = { secIssuer: { sic: "6798", sourceIds: [] } };
    const improvementsOnly = usGaap({
      PaymentsToAcquirePropertyPlantAndEquipment: undefined,
      PaymentsForCapitalImprovements: series("USD", () => 30),
      PaymentsToAcquireCommercialRealEstate: series("USD", () => 900),
    });
    const ids = ["fcfPayoutRatio", "totalPayoutToFcf"];
    const metrics = (ctx: MetricContext) => ids.map((id) => evaluate(ctx).metric(id));

    expect(metrics(context(improvementsOnly, reit))).toEqual(
      ids.map(() =>
        expect.objectContaining({
          status: "not-applicable",
          reason:
            "REIT issuer (SIC 6798) tags no property, plant and equipment purchases; operating cash flow less capex would omit its investment in properties or mortgage assets",
          inputs: [],
        }),
      ),
    );
    for (const ctx of [
      context(improvementsOnly, { secIssuer: { sic: "7372", sourceIds: [] } }),
      context(improvementsOnly),
    ]) {
      expect(metrics(ctx)).toEqual(
        ids.map(() =>
          expect.objectContaining({
            status: "missing",
            cause: "not-filed",
            reason: "capital expenditure not filed by the issuer",
          }),
        ),
      );
    }
    expect(evaluate(context(usGaap(), reit)).metric("fcfPayoutRatio")).toMatchObject({
      status: "value",
      value: 0.2,
    });
    const ppeBesideRealEstate = usGaap({
      PaymentsToAcquireRealEstate: series("USD", () => 900),
    });
    expect(metrics(context(ppeBesideRealEstate, reit))).toEqual(
      ids.map(() =>
        expect.objectContaining({
          status: "not-applicable",
          reason: expect.stringContaining("tags real estate acquisition"),
          inputs: [],
        }),
      ),
    );
    expect(
      evaluate(context(ppeBesideRealEstate, { secIssuer: { sic: "7372", sourceIds: [] } })).metric(
        "fcfPayoutRatio",
      ),
    ).toMatchObject({ status: "value", value: 0.2 });
  });

  test("never-filed beside a stale series keeps the gap material", () => {
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          PaymentsForRepurchaseOfCommonStock: series("USD", (year) =>
            year <= 2020 ? 90 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy").cause).toBe("not-filed");
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2020-12-31",
    });
    expect(result.metric("buybacksLatestFy").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a concept filed only as interim or wrong-span facts is not not-filed", () => {
    const interimOnly = {
      units: {
        USD: [
          fy(30, 2025, { start: "2025-01-01", end: "2025-06-30", fp: "Q2", form: "10-Q" }),
          fy(60, 2025, { start: "2024-01-01", end: "2025-02-28" }),
        ],
      },
    };
    const result = evaluate(context(usGaap({ PaymentsOfDividends: interimOnly })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "missing" });
    expect(result.metric("dividendsLatestFy").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a never-filed numerator never hides a filed-but-filtered denominator", () => {
    const interimOcf = {
      units: {
        USD: YEARS.map((year) =>
          fy(400, year, { end: `${String(year)}-06-30`, fp: "Q2", form: "10-Q" }),
        ),
      },
    };
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          NetCashProvidedByUsedInOperatingActivities: interimOcf,
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy").cause).toBe("not-filed");
    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual operating cash flow fact",
    });
    expect(result.metric("totalPayoutToFcf")).toMatchObject({
      status: "missing",
      reason: "no same-period operating cash flow for the fiscal year ending 2025-12-31",
    });
    for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
      expect(result.metric(id).cause).toBeUndefined();
    }
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("unfiled dividends: the filed FCF inputs must still join, fresh, in one fiscal year", () => {
    const fcf = (overrides: Record<string, Fact | undefined>) =>
      evaluate(context(usGaap({ PaymentsOfDividends: undefined, ...overrides }))).metric(
        "fcfPayoutRatio",
      );
    const unjoined = fcf({
      NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
        year === 2025 ? 400 : undefined,
      ),
      PaymentsToAcquirePropertyPlantAndEquipment: series("USD", (year) =>
        year === 2024 ? 100 : undefined,
      ),
    });
    const stale = fcf({
      NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
        year <= 2020 ? 400 : undefined,
      ),
      PaymentsToAcquirePropertyPlantAndEquipment: series("USD", (year) =>
        year <= 2020 ? 100 : undefined,
      ),
    });
    const joined = fcf({});

    expect(unjoined).toMatchObject({
      status: "missing",
      reason: "no same-period capital expenditure for the fiscal year ending 2025-12-31",
    });
    expect(unjoined.cause).toBeUndefined();
    expect(stale).toMatchObject({
      status: "missing",
      reason: "stale operating cash flow as of 2020-12-31",
    });
    expect(stale.cause).toBeUndefined();
    expect(joined).toMatchObject({
      status: "missing",
      reason: "dividends paid not filed by the issuer",
      cause: "not-filed",
      periodEnd: "2025-12-31",
    });
    expect(joined.inputs.map(({ series: key }) => key)).toEqual([
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
  });

  test("a never-filed yield numerator never hides an absent quote", () => {
    const { quote: _quote, ...withoutQuote } = context(usGaap({ PaymentsOfDividends: undefined }));
    const result = evaluate(withoutQuote);

    expect(result.metric("dividendYieldFiled").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a concept whose only rows are malformed is filed, not not-filed", () => {
    for (const val of [null, "60", {}]) {
      const ctx = context(
        usGaap({ PaymentsOfDividends: { units: { USD: [fy(0, 2025, { val })] } } }),
      );

      expect(ctx.statements?.unfiledSeries).not.toContain("dividendsPaid");
      expect(evaluate(ctx).metric("dividendsLatestFy").cause).toBeUndefined();
    }
  });

  test("an artifact without unfiled-series evidence never claims not-filed", () => {
    const ctx = context(usGaap({ PaymentsOfDividends: undefined }));
    expect(ctx.statements?.unfiledSeries).toContain("dividendsPaid");
    const { unfiledSeries: _unrecorded, ...preFlag } = ctx.statements!;
    const historical = evaluate({ ...ctx, statements: preFlag });

    expect(historical.metric("dividendsLatestFy")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual dividends paid fact",
    });
    expect(historical.metric("dividendsLatestFy").cause).toBeUndefined();
    expect(historical.sourceGaps[0]?.triage).toBe("material");
  });

  test("a filing dated after analysisAsOf does not count as filed", () => {
    const ctx = context(
      usGaap({ PaymentsOfDividends: { units: { USD: [fy(60, 2026, { filed: "2027-02-15" })] } } }),
    );

    expect(ctx.statements?.unfiledSeries).toContain("dividendsPaid");
  });

  test("filed zero dividends are a value of 0, never not-applicable", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: series("USD", () => 0) })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(result.metric("dividendYieldFiled")).toMatchObject({ status: "value", value: 0 });
    expect(result.section.metrics.some((metric) => metric.status === "not-applicable")).toBe(false);
  });

  test("R7(b): zero dividends paid never gates positive declared dividends per share", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: series("USD", () => 0) })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    for (const id of ["dpsLatestFy", "dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"]) {
      expect(result.metric(id).status).toBe("value");
    }
  });

  test("R7: zero paid after earlier positive payments is never not-applicable", () => {
    const paidThenStopped = series("USD", (year) => (year <= 2022 ? 50 : 0));
    const withoutPerShare = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: paidThenStopped,
          CommonStockDividendsPerShareDeclared: undefined,
        }),
      ),
    );
    const withPerShare = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: paidThenStopped,
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year <= 2022 ? 0.5 : 0,
          ),
        }),
      ),
    );

    for (const id of ["dpsLatestFy", "dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"]) {
      expect(withoutPerShare.metric(id)).toMatchObject({
        status: "missing",
        reason: "dividends per share not filed by the issuer",
        cause: "not-filed",
      });
    }
    expect(withPerShare.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(withPerShare.metric("dpsCagr3y")).toMatchObject({ status: "value", value: -1 });
    expect(withPerShare.metric("earliestDividendFyInHistory").value).toBe("FY2019 or earlier");
    for (const result of [withoutPerShare, withPerShare]) {
      expect(result.section.metrics.some(({ status }) => status === "not-applicable")).toBe(false);
    }
  });

  test("only an affirmed non-payer gets not-applicable dividend history", () => {
    const zeroPaid = series("USD", () => 0);
    const zeroPerShare = series("USD/shares", () => 0);
    const history = ["dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"];
    const nonPayer = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: zeroPaid,
          CommonStockDividendsPerShareDeclared: zeroPerShare,
        }),
      ),
    );
    const statusesWith = (overrides: Record<string, Fact | undefined>) => {
      const result = evaluate(
        context(
          usGaap({
            PaymentsOfDividends: zeroPaid,
            CommonStockDividendsPerShareDeclared: zeroPerShare,
            ...overrides,
          }),
        ),
      );
      return history.map((id) => result.metric(id).status);
    };

    for (const id of history) {
      expect(nonPayer.metric(id)).toMatchObject({
        status: "not-applicable",
        reason: "no dividend history in filed data",
        inputs: [],
      });
    }
    expect(nonPayer.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(nonPayer.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(statusesWith({ CommonStockDividendsPerShareDeclared: undefined })).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(statusesWith({ PaymentsOfDividends: undefined })).toEqual([
      "not-meaningful",
      "not-meaningful",
      "missing",
    ]);
    expect(
      statusesWith({
        PaymentsOfDividends: {
          units: {
            USD: [
              ...YEARS.map((year) => fy(0, year)),
              fy(15, 2026, {
                start: "2026-01-01",
                end: "2026-03-31",
                fp: "Q1",
                form: "10-Q",
                filed: "2026-05-01",
              }),
            ],
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    for (const paid of [40, -40]) {
      expect(
        statusesWith({
          PaymentsOfDividends: series("USD", (year) => (year === 2019 ? paid : 0)),
        }),
      ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    }
    expect(
      statusesWith({
        PaymentsOfDividends: series("USD", (year) => (year <= 2020 ? 0 : undefined)),
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statusesWith({
        CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
          year <= 2020 ? 0 : undefined,
        ),
      }),
    ).toEqual(["missing", "missing", "missing"]);
    expect(
      statusesWith({
        CommonStockDividendsPerShareDeclared: {
          units: {
            "USD/shares": [
              ...YEARS.map((year) => fy(0, year)),
              fy(0.25, 2025, { start: "2025-12-01", end: "2025-12-31" }),
            ],
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statusesWith({
        PaymentsOfDividends: {
          units: {
            USD: YEARS.map((year) =>
              fy(0, year, { start: `${String(year - 1)}-07-01`, end: `${String(year)}-06-30` }),
            ),
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
  });

  test("Non-payer classification rests on raw dividend evidence, not on the selected per-share series", () => {
    const history = ["dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"];
    const zeroPaid = series("USD", () => 0);
    const stub = fy(0.8, 2025, { start: "2025-03-01" });
    const statuses = (overrides: Record<string, Fact | undefined>) => {
      const ctx = context(usGaap({ PaymentsOfDividends: zeroPaid, ...overrides }));
      return history.map((id) => evaluate(ctx).metric(id).status);
    };

    expect(
      statuses({
        CommonStockDividendsPerShareDeclared: { units: { "USD/shares": [stub] } },
        CommonStockDividendsPerShareCashPaid: series("USD/shares", () => 0),
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statuses({ CommonStockDividendsPerShareDeclared: { units: { "USD/shares": [stub] } } }),
    ).not.toContain("not-applicable");

    const nonPayer = context(
      usGaap({
        PaymentsOfDividends: zeroPaid,
        CommonStockDividendsPerShareDeclared: series("USD/shares", () => 0),
      }),
    );
    expect(nonPayer.statements?.dividendPaymentFiled).toBe(false);
    const zeroDps = series("USD/shares", () => 0).units as Record<string, Fact[]>;
    const withRawDps = (extra: Fact) =>
      context(
        usGaap({
          PaymentsOfDividends: zeroPaid,
          CommonStockDividendsPerShareDeclared: {
            units: { "USD/shares": [...zeroDps["USD/shares"]!, extra] },
          },
        }),
      );
    const eightK = fy(0.5, 2025, { form: "8-K", start: "2025-11-01", end: "2025-11-30" });
    const { fp: _fp, ...noFp } = fy(0.5, 2024, { start: "2024-12-01" });
    for (const raw of [
      eightK,
      noFp,
      { ...eightK, filed: "unknown" },
      { ...eightK, filed: "2027-02-30" },
      { ...eightK, filed: "2026-13-45" },
    ]) {
      const ctx = withRawDps(raw);
      expect(ctx.statements?.dividendPaymentFiled).toBe(true);
      expect(history.map((id) => evaluate(ctx).metric(id).status)).not.toContain("not-applicable");
    }
    expect(withRawDps({ ...eightK, filed: "2026-08-01" }).statements?.dividendPaymentFiled).toBe(
      false,
    );
    const { dividendPaymentFiled: _unrecorded, ...preFlag } = nonPayer.statements!;
    const historical = evaluate({ ...nonPayer, statements: preFlag });
    for (const id of history) {
      expect(historical.metric(id)).toMatchObject({
        status: "missing",
        reason: "dividend payment evidence is not recorded in this artifact",
      });
    }
    const payer = context(usGaap());
    const { dividendPaymentFiled: _payerFlag, ...payerPreFlag } = payer.statements!;
    expect(evaluate({ ...payer, statements: payerPreFlag }).metric("dpsCagr3y").status).toBe(
      "value",
    );
  });

  test("a negative filed dividend per share is refused, never shown as its absolute value", () => {
    const result = evaluate(
      context(
        usGaap({
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year === 2025 ? -0.5 : dps(year),
          ),
        }),
      ),
    );

    expect(result.metric("dpsLatestFy")).toMatchObject({
      status: "not-meaningful",
      reason: "latest dividends per share is negative",
      periodEnd: "2025-12-31",
      inputs: [{ value: -0.5 }],
    });
    expect(result.metric("dpsLatestFy").value).toBeUndefined();
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "not-meaningful",
      reason: "latest dividends per share is negative",
      periodEnd: "2025-12-31",
    });
  });

  test("a withheld unreconciled latest year does not let an older year stand in", () => {
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: series("USD", (year) => (year === 2025 ? 100_000 : 60)),
        }),
      ),
    );

    for (const id of ["dpsLatestFy", "dpsCagr3y", "dpsCagr5y"]) {
      expect(result.metric(id)).toMatchObject({ status: "missing", periodEnd: "2025-12-31" });
      expect(result.metric(id).reason).toMatch(
        /^dividends per share withheld: .+ below the 0\.4x floor$/u,
      );
    }
    expect(result.metric("earliestDividendFyInHistory").status).toBe("value");

    const oldest = evaluate(
      context(
        usGaap({ PaymentsOfDividends: series("USD", (year) => (year === 2019 ? 100_000 : 60)) }),
      ),
    );
    expect(oldest.metric("dpsLatestFy").status).toBe("value");
    expect(oldest.metric("earliestDividendFyInHistory")).toMatchObject({
      status: "missing",
      periodEnd: "2019-12-31",
    });
  });

  test("no taxonomy: every metric is missing and the section still exists", () => {
    const result = evaluate(context({}));

    expect(result.section.metrics.every((metric) => metric.status === "missing")).toBe(true);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a 13-month annual fact never anchors; the latest year-aligned FY does", () => {
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

  test("an interim 12-month fact never anchors", () => {
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

  test("a denominator only in an older FY is missing, not an older-period value", () => {
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

  test("a stale anchor is missing with its lineage; a current FY is a value", () => {
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

  test("Annual filing cutoff is calendar-aware: FY end + 16 months (month-end kept) + 7 days", () => {
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

  test("an undated FY stock-based compensation fact is missing, not a value", () => {
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

  test("zero or negative free cash flow is not-meaningful with its inputs kept", () => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 400) })),
    );

    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "not-meaningful",
      reason: "free cash flow is zero or negative for the fiscal year ending 2025-12-31",
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  });

  test("an earlier-share-basis period inside the window makes the change not-meaningful", () => {
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
        {
          code: "earlier-share-basis",
          seriesKey: "dividendsPerShare",
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
      periodEnd: "2025-12-31",
    });
    expect(result.metric("shareCountTrend").status).toBe("not-meaningful");
    expect(result.metric("dpsLatestFy").status).toBe("value");
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "not-meaningful",
      reason: "dividends per share inside the window are on an earlier share basis",
      periodEnd: "2025-12-31",
      inputs: [{ periodEnd: "2022-12-31" }, { periodEnd: "2025-12-31" }],
    });
    expect(result.metric("earliestDividendFyInHistory").status).toBe("value");
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

  test("not-meaningful share and payout rows retain the known fiscal year", () => {
    const result = evaluate(
      context(
        usGaap({
          WeightedAverageNumberOfDilutedSharesOutstanding: series("shares", (year) =>
            year < 2025 ? 0 : 100,
          ),
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year < 2025 ? 0 : 0.5,
          ),
        }),
        { quote: { marketCap: 0, currency: "USD", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID } },
      ),
    );
    for (const id of [
      "shareCountChange1y",
      "shareCountChange3y",
      "shareCountChange5y",
      "dpsCagr3y",
      "dpsCagr5y",
      "buybackYield",
      "dividendYieldFiled",
      "shareholderYield",
    ]) {
      expect(result.metric(id)).toMatchObject({
        status: "not-meaningful",
        periodEnd: "2025-12-31",
      });
    }
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
    const base = context(usGaap());
    const material = renderMaterialGaps(
      context(usGaap(), { quote: { ...base.quote!, currency: "EUR" } }),
    );
    const diagnostic = renderMaterialGaps(context(usGaap(), { depositorySic: "6022" }));
    const notFiled = renderMaterialGaps(context(usGaap({ PaymentsOfDividends: undefined })));

    expect(material).toContain("capital-return: Capital Return metrics for TEST not computed");
    expect(diagnostic).not.toContain("capital-return");
    expect(notFiled).not.toContain("capital-return");
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
    sources: sourceIds.map((id) => evidenceSource(id)),
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
    expect(run(forged("dpsCagr3y", (metric) => ({ ...metric, value: 0.5 })))).toThrow(
      "capital-return.dpsCagr3y",
    );
    expect(
      run(forged("earliestDividendFyInHistory", (metric) => ({ ...metric, value: "FY2020" }))),
    ).toThrow("names the earliest positive FY");
  });

  test("the fixture invariant checks each not-filed cause against the metric's own inputs", () => {
    const snapshot = marketSnapshot({
      sourceId: QUOTE_SOURCE_ID,
      symbol: "TEST",
      marketCap: 10_000,
      observedAt: AS_OF,
    });
    const quoted = (ctx: MetricContext, currency = "USD"): MetricContext => ({
      ...ctx,
      quote: {
        marketCap: 10_000,
        currency,
        asOf: resolveMarketSnapshotPriceAsOf(snapshot).instant,
        sourceId: QUOTE_SOURCE_ID,
      },
    });
    const runWith = (ctx: MetricContext, change: (metric: MetricRecord) => MetricRecord) => {
      const { section, sourceGaps } = capitalReturnSection(ctx);
      const metrics = section.metrics.map((metric) => change(metric as unknown as MetricRecord));
      const allNotFiled = metrics
        .filter(({ status }) => status === "missing")
        .every(({ cause }) => cause === "not-filed");
      const report = researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID), evidenceSource(QUOTE_SOURCE_ID)],
        dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
        extras: { metricSections: [{ ...section, metrics }] },
      });
      return () =>
        assertMetricSectionInvariants(
          {
            collectedSources: collectedSources({
              financialStatements: ctx.statements!,
              capitalOwnership: ctx.capitalOwnership!,
              ...(ctx.quote === undefined
                ? {}
                : {
                    marketSnapshots: [snapshot],
                    resolvedInstrumentIdentity: { quoteCurrency: ctx.quote.currency } as never,
                  }),
              sourceGaps: sourceGaps.map((gap) => ({
                ...gap,
                triage: allNotFiled ? "diagnostic" : "material",
              })),
            }),
            markdown: renderMarkdownReport(report),
          },
          report,
        );
    };
    const tag =
      (...ids: string[]) =>
      (metric: MetricRecord): MetricRecord =>
        ids.includes(String(metric.id))
          ? {
              ...metric,
              status: "missing",
              cause: "not-filed",
              value: undefined,
              periodEnd: (metric.inputs as readonly MetricInput[]).find(
                ({ artifact }) => artifact === "statements",
              )?.periodEnd,
            }
          : metric;
    const unfiledDividends = quoteless(context(usGaap({ PaymentsOfDividends: undefined })));
    const filteredOcf = quoteless(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: [fy(400, 2025, { end: "2025-06-30", fp: "Q2", form: "10-Q" })] },
          },
        }),
      ),
    );

    expect(runWith(unfiledDividends, (metric) => metric)).not.toThrow();
    expect(runWith(unfiledDividends, tag("buybacksLatestFy"))).toThrow(
      "capital-return.buybacksLatestFy not-filed needs one of its own inputs unfiled",
    );
    const withFcf = (
      ocf: (year: number) => number | undefined,
      capex: (year: number) => number | undefined,
    ) =>
      quoteless(
        context(
          usGaap({
            PaymentsOfDividends: undefined,
            NetCashProvidedByUsedInOperatingActivities: series("USD", ocf),
            PaymentsToAcquirePropertyPlantAndEquipment: series("USD", capex),
          }),
        ),
      );
    const staleOcf = withFcf(
      (year) => (year <= 2020 ? 400 : undefined),
      (year) => (year <= 2020 ? 100 : undefined),
    );
    const unjoined = withFcf(
      (year) => (year === 2025 ? 400 : undefined),
      (year) => (year === 2024 ? 100 : undefined),
    );

    expect(
      capitalReturnSection(unfiledDividends).section.metrics.find(
        ({ id }) => id === "fcfPayoutRatio",
      )?.cause,
    ).toBe("not-filed");
    const negativeFcf = withFcf(
      () => 50,
      () => 100,
    );
    expect(
      capitalReturnSection(negativeFcf).section.metrics.find(({ id }) => id === "fcfPayoutRatio")
        ?.status,
    ).toBe("not-meaningful");
    const quotedDividends = quoted(unfiledDividends);
    const yieldCauses = capitalReturnSection(quotedDividends).section.metrics.flatMap(
      ({ id, cause }) => (id === "dividendYieldFiled" || id === "shareholderYield" ? [cause] : []),
    );
    expect(yieldCauses).toEqual(["not-filed", "not-filed"]);
    expect(runWith(quotedDividends, (metric) => metric)).not.toThrow();
    for (const ctx of [unfiledDividends, quoted(unfiledDividends, "EUR")]) {
      expect(runWith(ctx, (metric) => metric)).not.toThrow();
      expect(runWith(ctx, tag("dividendYieldFiled"))).toThrow(
        "capital-return.dividendYieldFiled not-filed but filed inputs fail",
      );
    }
    for (const ctx of [filteredOcf, staleOcf, unjoined, negativeFcf]) {
      expect(runWith(ctx, (metric) => metric)).not.toThrow();
      expect(runWith(ctx, tag("fcfPayoutRatio"))).toThrow(
        "capital-return.fcfPayoutRatio not-filed but filed inputs fail",
      );
    }
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

  test("structural causes validate on missing metrics only", () => {
    const report = reportWith(context(usGaap({ PaymentsOfDividends: undefined })), [
      SOURCE_ID,
      QUOTE_SOURCE_ID,
    ]);
    const sections = report.extras?.metricSections as readonly Record<string, unknown>[];
    const forged = (cause: string, status: string) => ({
      ...report,
      extras: {
        ...report.extras,
        metricSections: sections.map((section) => ({
          ...section,
          metrics: (section.metrics as readonly Record<string, unknown>[]).map((metric) =>
            metric.id === "buybacksLatestFy" ? { ...metric, cause, status } : metric,
          ),
        })),
      },
    });

    expect(() => validateResearchReport(report)).not.toThrow();
    for (const cause of ["not-filed", "insufficient-history", "outside-price-history-window"]) {
      expect(() => validateResearchReport(forged(cause, "missing"))).not.toThrow();
      expect(() => validateResearchReport(forged(cause, "value"))).toThrow(
        `buybacksLatestFy has cause "${cause}" on a value metric`,
      );
    }
    expect(() => validateResearchReport(forged("stale", "missing"))).toThrow(
      'has cause "stale" on a missing metric',
    );
    for (const [cause, text] of [
      [42, "42"],
      [null, "null"],
      [{}, "{}"],
    ] as const) {
      expect(() => validateResearchReport(forged(cause as never, "missing"))).toThrow(
        `has cause ${text} on a missing metric`,
      );
    }
  });

  test("renders a not-applicable metric as not applicable with its reason", () => {
    const markdown = renderMarkdownReport(
      reportWith(context(usGaap(), { depositorySic: "6022" }), [SOURCE_ID, QUOTE_SOURCE_ID]),
    );

    expect(markdown).toContain(
      String.raw`- Dividends / free cash flow: not applicable, depository issuer \(SIC 6022\)`,
    );
    expect(markdown).not.toMatch(/not available, depository issuer/u);
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
    expect(markdown).toContain(
      `- Dividends per share \\(latest FY\\): $0.64 (FY ending 2025-12-31; dividends declared per share, else cash paid per share, whichever reconciles with dividends paid in its own filing, else in the selected same-year series, in the latest year-aligned fiscal year; a year without dividends paid or diluted shares publishes unchecked; a declared zero that no concept replaces publishes as declared) [${SOURCE_ID}]`,
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

describe("capitalReturnSection — capex sign", () => {
  test.each([
    [100, { status: "value", value: 60 / 300 }],
    [0, { status: "value", value: 60 / 400 }],
    [
      -100,
      {
        status: "not-meaningful",
        reason: `${NEGATIVE_CAPEX_REASON} for the fiscal year ending 2025-12-31`,
      },
    ],
  ])("FCF payout ratios with capex %d", (capex, expected) => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => capex) })),
    );
    expect(result.metric("fcfPayoutRatio")).toMatchObject(expected);
    expect(result.metric("totalPayoutToFcf")).toMatchObject({ status: expected.status });
    expect(result.metric("fcfPayoutRatio").inputs.map((input) => input.series)).toEqual([
      "dividendsPaid",
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
  });
});
