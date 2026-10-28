import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { collectFinancialStatements } from "../src/sources/collector-equity-enrichment";
import {
  deriveFinancialStatements,
  financialStatementsHistoryGaps,
} from "../src/sources/extended-evidence/financial-statements";
import type { CollectContext } from "../src/sources/types";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { buildSecFilingSourceItem } from "../src/sources/sec-filing-item";
import { classifyGap } from "../src/report/gap-triage";
import type {
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { geographicRevenueSection } from "../src/sources/extended-evidence/geographic-revenue";
import {
  depositoryIssuerSic,
  secIssuerRegistration,
} from "../src/sources/extended-evidence/industry-classification";
import { operatingRatiosSection } from "../src/sources/extended-evidence/operating-ratios";
import {
  secExtensionCapexFactMetrics,
  secGeographyFactMetrics,
} from "../src/sources/sec-segment-facts";

const FIXTURES = join(import.meta.dir, "fixtures", "sec-reference-set");

interface Expected {
  readonly value: number;
  readonly line: string;
}
type MetricExpectation =
  | { readonly status: "value"; readonly value: number; readonly line: string }
  | { readonly status: "not-meaningful" | "not-applicable" | "missing"; readonly reason: string };

interface ReferenceCase {
  readonly symbol: string;
  readonly fiscalYearEnd: string;
  readonly accession: string;
  readonly statements: Partial<Record<FinancialStatementSeriesKey, Expected>>;
  readonly absent?: readonly FinancialStatementSeriesKey[];
  readonly metrics: Readonly<Record<string, MetricExpectation>>;
  readonly depreciationAndAmortization?: Readonly<Record<string, Expected | { omitted: string }>>;
}

function load(symbol: string, secFilings?: readonly ExtendedEvidenceItem[]) {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, `${symbol}.json`), "utf8"));
  const statements = deriveFinancialStatements(fixture.companyFacts, {
    ...(secFilings !== undefined ? { secFilings } : {}),
    symbol: fixture.symbol,
    generatedAt: fixture.analysisAsOf,
    analysisAsOf: fixture.analysisAsOf,
    sourceId: "sec",
    submissionsPayload: fixture.submissions,
  });
  const evidence = {
    items: [
      {
        category: "sec-edgar",
        metrics: {
          sic: String(fixture.submissions.sic),
          stateOfIncorporation: fixture.submissions.stateOfIncorporation,
        },
        identity: { displayName: fixture.submissions.name },
      },
    ],
  };
  const depositorySic = depositoryIssuerSic(evidence);
  const secIssuer = secIssuerRegistration(evidence);
  const ratios = operatingRatiosSection({
    symbol: fixture.symbol,
    statements,
    ...(depositorySic !== undefined ? { depositorySic } : {}),
    ...(secIssuer !== undefined ? { secIssuer } : {}),
  });
  const series: Partial<Record<FinancialStatementSeriesKey, FinancialStatementSeries>> =
    Object.assign({}, ...Object.values(statements.statements));
  return { statements, series, metrics: ratios.section?.metrics ?? [] };
}

function irenHtml() {
  return readFileSync(join(FIXTURES, "iren-10k-0001878848-26-000052.xbrl.html"), "utf8");
}

function iren10K(html: string): ExtendedEvidenceItem {
  const built = buildSecFilingSourceItem(
    { jobType: "equity", assetClass: "equity", symbol: "IREN", depth: "deep" },
    { cik: "0001878848", ticker: "IREN" },
    {
      form: "10-K",
      filingDate: "2026-08-28",
      reportDate: "2026-06-30",
      accessionNumber: "0001878848-26-000052",
      primaryDocument: "iren-20260630.htm",
    },
    "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000052/iren-20260630.htm",
    {
      rawSnapshot: {
        id: "raw-iren-10k",
        adapter: "sec-filing-text",
        fetchedAt: "2026-09-29T00:00:00.000Z",
        payload: "",
      },
      payload: `ITEM 7. MANAGEMENT'S DISCUSSION ${"Revenue grew on stronger demand while margins held steady. ".repeat(8)} ${html}`,
    },
  );
  if (built.kind !== "built") {
    throw new Error(`IREN filing item ${built.kind}`);
  }
  return built.item;
}

const recent = (tenKReportDate: string, withTenQ: boolean) => ({
  form: ["10-K", ...(withTenQ ? ["10-Q"] : [])],
  filingDate: ["2025-08-28", ...(withTenQ ? ["2026-05-08"] : [])].map((date) =>
    tenKReportDate === "2026-06-30" && date === "2025-08-28" ? "2026-08-28" : date,
  ),
  reportDate: [tenKReportDate, ...(withTenQ ? ["2026-03-31"] : [])],
  accessionNumber: ["0001878848-26-000052", ...(withTenQ ? ["0001878848-26-000099"] : [])],
  primaryDocument: ["iren-20260630.htm", ...(withTenQ ? ["iren-20260331.htm"] : [])],
});
const collect = async (ctx: CollectContext) => {
  const { statements, periodicFilings } = await collectFinancialStatements(ctx, "IREN");
  return {
    fy2026: statements?.statements.cashFlowStatement.capitalExpenditure.annual.find(
      ({ periodEnd }) => periodEnd === "2026-06-30",
    )?.value,
    codes: (statements?.omissionNotes ?? [])
      .filter(({ seriesKey }) => seriesKey === "capitalExpenditure")
      .map(({ code }) => code),
    periodicFilings,
  };
};

const statement = (value: number, line: string): Expected => ({ value, line });
const ratio = (value: number, line: string): MetricExpectation => ({
  status: "value",
  value,
  line,
});

const CASES: readonly ReferenceCase[] = [
  {
    symbol: "aapl",
    fiscalYearEnd: "2025-09-27",
    accession: "0000320193-25-000079",
    statements: {
      revenue: statement(416_161_000_000, "R3 Total net sales"),
      operatingIncome: statement(133_050_000_000, "R3 Operating income"),
      dilutedEps: statement(7.46, "R3 Diluted earnings per share"),
      operatingCashFlow: statement(111_482_000_000, "R8 Cash generated by operating activities"),
      capitalExpenditure: statement(12_715_000_000, "R8 Payments for acquisition of PP&E"),
      debt: statement(98_657_000_000, "R5 Commercial paper 7,979 + term debt 12,350 + 78,328"),
      cash: statement(35_934_000_000, "R5 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(0.237_33, "R8 (111,482 - 12,715) / R3 416,161"),
      roic: ratio(
        0.954_02,
        "R3 133,050 x (1 - 20,719 / 132,729) / R5 (73,733 + 98,657 - 35,934 - 18,763)",
      ),
      interestCoverage: {
        status: "missing",
        reason: "no same-period interest expense for the fiscal year ending 2025-09-27",
      },
    },
    depreciationAndAmortization: {
      "2025-09-27": statement(11_698_000_000, "R8 Depreciation and amortization"),
    },
  },
  {
    symbol: "msft",
    fiscalYearEnd: "2026-06-30",
    accession: "0001193125-26-323660",
    statements: {
      revenue: statement(331_839_000_000, "R2 Total revenue"),
      operatingIncome: statement(155_237_000_000, "R2 Operating income"),
      dilutedEps: statement(17.95, "R2 Diluted earnings per share"),
      operatingCashFlow: statement(182_935_000_000, "R6 Net cash from operations"),
      capitalExpenditure: statement(115_948_000_000, "R6 Additions to property and equipment"),
      debt: statement(
        40_294_000_000,
        "R4 Current portion of long-term debt 9,227 + long-term debt 31,067",
      ),
      cash: statement(20_935_000_000, "R4 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(0.201_87, "R6 (182,935 - 115,948) / R2 331,839"),
      roic: ratio(
        0.308_32,
        "R2 155,237 x (1 - 32,185 / 165,934) / R4 (442,387 + 40,294 - 20,935 - 55,908)",
      ),
    },
    depreciationAndAmortization: {
      "2026-06-30": statement(
        39_000_000_000,
        "R16 depreciation 34.3B + R19 amortization of intangibles 4.7B",
      ),
    },
  },
  {
    symbol: "amd",
    fiscalYearEnd: "2025-12-27",
    accession: "0000002488-26-000018",
    statements: {
      revenue: statement(34_639_000_000, "R3 Net revenue"),
      operatingIncome: statement(3_694_000_000, "R3 Operating income"),
      dilutedEps: statement(2.65, "R3 Diluted earnings per share"),
      operatingCashFlow: statement(
        6_493_000_000,
        "R8 Net cash provided by operating activities, continuing",
      ),
      capitalExpenditure: statement(974_000_000, "R8 Purchases of property and equipment"),
      debt: statement(
        3_222_000_000,
        "R5 Current portion of long-term debt 874 + long-term debt 2,348",
      ),
      cash: statement(5_539_000_000, "R5 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(0.159_33, "R8 (6,493 - 974) / R3 34,639"),
      roic: ratio(
        0.052_42,
        "R3 3,694 x (1 - 21% statutory; filed rate -2.5%) / R5 (62,999 + 3,222 - 5,539 - 5,013)",
      ),
      ebitdaProxy: {
        status: "missing",
        reason:
          "no same-period depreciation and amortization for the fiscal year ending 2025-12-27",
      },
    },
    depreciationAndAmortization: {
      "2023-12-30": { omitted: "below the filed cash-flow D&A lines (3453000000)" },
      "2024-12-28": { omitted: "below the filed cash-flow D&A lines (3064000000)" },
      "2025-12-27": { omitted: "below the filed cash-flow D&A lines (3004000000)" },
    },
  },
  {
    symbol: "nvda",
    fiscalYearEnd: "2026-01-25",
    accession: "0001045810-26-000021",
    statements: {
      revenue: statement(215_938_000_000, "R3 Revenue"),
      operatingIncome: statement(130_387_000_000, "R3 Operating income"),
      dilutedEps: statement(4.9, "R3 Diluted net income per share"),
      operatingCashFlow: statement(102_718_000_000, "R9 Net cash provided by operating activities"),
      capitalExpenditure: statement(
        6_042_000_000,
        "R9 Purchases related to PP&E and intangible assets",
      ),
      debt: statement(8_468_000_000, "R5 Short-term debt 999 + long-term debt 7,469"),
      cash: statement(10_605_000_000, "R5 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(0.4477, "R9 (102,718 - 6,042) / R3 215,938"),
      roic: ratio(
        1.072_39,
        "R3 130,387 x (1 - 21,383 / 141,450) / R5 (157,293 + 8,468 - 10,605 - 51,951)",
      ),
    },
    depreciationAndAmortization: {
      "2026-01-25": statement(2_843_000_000, "R9 Depreciation and amortization"),
    },
  },
  {
    symbol: "intc",
    fiscalYearEnd: "2025-12-27",
    accession: "0000050863-26-000011",
    statements: {
      revenue: statement(52_853_000_000, "R3 Net revenue"),
      operatingIncome: statement(-2_214_000_000, "R3 Operating income (loss)"),
      netIncome: statement(-267_000_000, "R3 Net income (loss) attributable to Intel"),
      dilutedEps: statement(-0.06, "R3 Diluted EPS attributable to Intel"),
      operatingCashFlow: statement(9_697_000_000, "R7 Net cash provided by operating activities"),
      capitalExpenditure: statement(14_646_000_000, "R7 Additions to PP&E (investing)"),
      debt: statement(46_585_000_000, "R5 Short-term debt 2,499 + debt 44,086"),
      cash: statement(14_265_000_000, "R5 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(-0.093_64, "R7 (9,697 - 14,646) / R3 52,853"),
      roic: ratio(
        -0.0003,
        "R3 -2,214 x (1 - 1,531 / 1,557) / R5 (114,281 + 46,585 - 14,265 - 23,151)",
      ),
    },
    depreciationAndAmortization: {
      "2025-12-27": statement(
        11_706_000_000,
        "R7 Depreciation 10,757 + amortization of intangibles 949",
      ),
    },
  },
  {
    symbol: "hlit",
    fiscalYearEnd: "2025-12-31",
    accession: "0001193125-26-067506",
    statements: {
      revenue: statement(360_523_000, "R4 Total net revenue"),
      operatingIncome: statement(14_080_000, "R4 Income (loss) from operations"),
      continuingIncome: statement(1_216_000, "R4 Income from continuing operations"),
      dilutedEps: statement(-0.38, "R4 Diluted net income (loss) per share"),
      operatingCashFlow: statement(
        105_434_000,
        "R7 Net cash provided by operating activities 107,966 less discontinued 2,532",
      ),
      capitalExpenditure: statement(11_080_000, "R7 Purchases of property and equipment"),
      debt: statement(112_084_000, "R2 Current portion of long-term debt 2,944 + 109,140"),
      cash: statement(124_105_000, "R2 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(0.261_71, "(105,434 - 11,080) / R4 360,523"),
      roic: ratio(0.0052, "R4 14,080 x (1 - 7,645 / 8,861) / R2 (383,246 + 112,084 - 124,105)"),
    },
  },
  {
    symbol: "clfd",
    fiscalYearEnd: "2025-09-30",
    accession: "0001171843-25-007594",
    statements: {
      revenue: statement(150_134_000, "R4 Net sales"),
      operatingIncome: statement(2_118_000, "R4 Income from operations"),
      dilutedEps: statement(-0.58, "R4 Diluted net loss per share"),
      operatingCashFlow: statement(
        26_553_000,
        "R7 Net cash provided by operating activities, continuing",
      ),
      capitalExpenditure: statement(4_743_000, "R7 Purchases of PP&E and intangible assets"),
      cash: statement(21_493_000, "R2 Cash and cash equivalents"),
    },
    metrics: { freeCashFlowMargin: ratio(0.145_27, "R7 (26,553 - 4,743) / R4 150,134") },
    depreciationAndAmortization: {
      "2025-09-30": statement(6_121_000, "R7 Depreciation and amortization"),
    },
  },
  {
    symbol: "ltrx",
    fiscalYearEnd: "2026-06-30",
    accession: "0001683168-26-006754",
    statements: {
      revenue: statement(120_899_000, "R4 Net revenue"),
      operatingIncome: statement(-4_121_000, "R4 Loss from operations"),
      dilutedEps: statement(-0.1, "R4 Diluted net loss per share"),
      operatingCashFlow: statement(9_877_000, "R6 Net cash provided by operating activities"),
      capitalExpenditure: statement(612_000, "R6 Purchases of property and equipment"),
      debt: statement(0, "R2 Current portion of long-term debt 0 + long-term debt 0"),
      cash: statement(60_466_000, "R2 Cash and cash equivalents"),
    },
    // R6 files 1,602K "Depreciation and amortization" (DDA) beside 1,561K amortization of intangibles; no tagged total.
    depreciationAndAmortization: {
      "2026-06-30": {
        omitted: "(1602000) in filing 0001683168-26-006754 is below a same-filing component",
      },
    },
    metrics: {
      freeCashFlowMargin: ratio(0.076_63, "R6 (9,877 - 612) / R4 120,899"),
      roic: {
        status: "not-meaningful",
        reason: "pretax income is zero or negative for the fiscal year ending 2026-06-30",
      },
    },
  },
  {
    symbol: "mara",
    fiscalYearEnd: "2025-12-31",
    accession: "0001507605-26-000007",
    statements: {
      revenue: statement(907_093_000, "R5 Total revenues"),
      operatingIncome: statement(-1_224_250_000, "R5 Operating income (loss)"),
      dilutedEps: statement(-3.69, "R5 Diluted net loss per share"),
      operatingCashFlow: statement(-802_725_000, "R7 Net cash used in operating activities"),
      capitalExpenditure: statement(407_071_000, "R7 Purchase of property and equipment"),
      cash: statement(547_132_000, "R3 Cash and cash equivalents"),
    },
    metrics: {
      freeCashFlowMargin: ratio(-1.333_71, "R7 (-802,725 - 407,071) / R5 907,093"),
      interestCoverage: ratio(-25.304_36, "R5 -1,224,250 / interest expense 48,381"),
      roic: {
        status: "not-meaningful",
        reason: "pretax income is zero or negative for the fiscal year ending 2025-12-31",
      },
    },
    depreciationAndAmortization: {
      "2025-12-31": statement(772_768_000, "R7 Depreciation and amortization"),
    },
  },
  {
    symbol: "iren",
    fiscalYearEnd: "2026-06-30",
    accession: "0001878848-26-000052",
    statements: {
      revenue: statement(707_007_000, "R5 Total revenue"),
      operatingIncome: statement(-1_046_714_000, "R5 Operating loss"),
      dilutedEps: statement(-2.22, "R5 Diluted net loss per share"),
      operatingCashFlow: statement(2_100_418_000, "R7 Net cash from operating activities"),
      debt: statement(7_592_944_000, "R3 Debt current 169,370 + non-current 7,423,574"),
      cash: statement(5_895_591_000, "R3 Cash and cash equivalents"),
    },
    metrics: {
      roic: {
        status: "not-meaningful",
        reason: "pretax income is zero or negative for the fiscal year ending 2026-06-30",
      },
    },
    depreciationAndAmortization: {
      "2026-06-30": statement(417_729_000, "R7 Depreciation and amortization"),
    },
  },
  {
    symbol: "mrk",
    fiscalYearEnd: "2025-12-31",
    accession: "0000310158-26-000063",
    statements: {
      revenue: statement(65_011_000_000, "R3 Sales"),
      dilutedEps: statement(7.28, "R3 Earnings per share assuming dilution"),
      operatingCashFlow: statement(16_472_000_000, "R9 Net cash provided by operating activities"),
      capitalExpenditure: statement(4_112_000_000, "R9 Capital expenditures"),
      cash: statement(14_565_000_000, "R5 Cash and cash equivalents"),
      debt: statement(49_339_000_000, "R5 current debt 2,589 + long-term debt 46,750"),
    },
    absent: ["operatingIncome"],
    metrics: {
      freeCashFlowMargin: ratio(0.190_12, "R9 (16,472 - 4,112) / R3 65,011"),
      roic: { status: "missing", reason: "operating income not filed by the issuer" },
    },
    depreciationAndAmortization: {
      "2025-12-31": statement(5_838_000_000, "R9 Depreciation 3,045 + Amortization 2,793"),
      "2024-12-31": statement(
        4_499_000_000,
        "10-K 0000310158-26-000063 R9 Depreciation 2,104 + Amortization 2,395",
      ),
      "2023-12-31": statement(
        3_828_000_000,
        "R9 Amortization 2,044 is 2.2% off note 2,000; composite 1,828 + 2,000 kept",
      ),
    },
  },
  {
    symbol: "bns",
    fiscalYearEnd: "2025-10-31",
    accession: "0001193125-25-304643",
    statements: {
      revenue: statement(37_741_000_000, "R3 Total revenue (CAD)"),
      netIncome: statement(7_758_000_000, "R3 Net income (CAD)"),
      dilutedEps: statement(5.67, "R3 Diluted earnings per share (CAD)"),
      operatingCashFlow: statement(5_407_000_000, "R8 Net cash from operating activities (CAD)"),
      cash: statement(10_256_000_000, "R8 Cash and cash equivalents at end of year (CAD)"),
    },
    absent: ["operatingIncome", "debt", "capitalExpenditure"],
    metrics: {
      freeCashFlowMargin: {
        status: "not-applicable",
        reason: "depository issuer (SIC 6022): operating cash flow is not a free cash flow basis",
      },
      interestCoverage: {
        status: "not-applicable",
        reason:
          "depository issuer (SIC 6022): interest is an operating cost, not a financing charge",
      },
      roic: {
        status: "not-applicable",
        reason:
          "depository issuer (SIC 6022): debt and cash are operating balances, not invested capital",
      },
    },
    depreciationAndAmortization: {
      "2025-10-31": statement(1_604_000_000, "R8 Depreciation and amortization (CAD)"),
    },
  },
];

describe("SEC reference set (hand-checked against filed statements)", () => {
  for (const reference of CASES) {
    describe(`${reference.symbol.toUpperCase()} FY ending ${reference.fiscalYearEnd} (${reference.accession})`, () => {
      const { statements, series, metrics } = load(reference.symbol);
      const annual = (key: FinancialStatementSeriesKey, periodEnd = reference.fiscalYearEnd) =>
        series[key]?.annual.find((fact) => fact.periodEnd === periodEnd);

      test("reads the filing's statement lines", () => {
        for (const [key, expected] of Object.entries(reference.statements)) {
          const fact = annual(key as FinancialStatementSeriesKey);
          expect({ key, value: fact?.value }).toEqual({ key, value: expected.value });
          const accessions = fact?.composite?.components.map(
            ({ accessionNumber }) => accessionNumber,
          );
          expect({ key, accession: fact?.accessionNumber ?? accessions?.[0] }).toEqual({
            key,
            accession: reference.accession,
          });
        }
        for (const key of reference.absent ?? []) {
          expect({ key, fact: annual(key) }).toEqual({ key, fact: undefined });
        }
      });

      test("derives operating ratios and their statuses", () => {
        for (const [id, expected] of Object.entries(reference.metrics)) {
          const metric = metrics.find((candidate) => candidate.id === id);
          expect({ id, status: metric?.status }).toEqual({ id, status: expected.status });
          if (expected.status === "value") {
            expect(metric?.status === "value" ? metric.value : undefined).toBeCloseTo(
              expected.value,
              4,
            );
          } else {
            expect(metric && "reason" in metric ? metric.reason : undefined).toBe(expected.reason);
          }
        }
      });

      if (reference.depreciationAndAmortization !== undefined) {
        test("reports or withholds depreciation and amortization", () => {
          const notes = [...statements.validationNotes, ...statements.omissionNotes];
          for (const [periodEnd, expected] of Object.entries(
            reference.depreciationAndAmortization ?? {},
          )) {
            const fact = annual("depreciationAndAmortization", periodEnd);
            if ("omitted" in expected) {
              expect(fact).toBeUndefined();
              const note = notes.find(
                (candidate) =>
                  candidate.seriesKey === "depreciationAndAmortization" &&
                  candidate.code === "incomplete-composite-series" &&
                  candidate.periodKey?.endsWith(`|${periodEnd}`),
              );
              expect(note?.message).toContain(expected.omitted);
            } else {
              expect({ periodEnd, value: fact?.value }).toEqual({
                periodEnd,
                value: expected.value,
              });
            }
          }
        });
      }
    });
  }

  // Pipeline disagrees with the filing; expected values come from the filing, not the code.
  const fact = (symbol: string, key: FinancialStatementSeriesKey, periodEnd: string) =>
    load(symbol).series[key]?.annual.find((candidate) => candidate.periodEnd === periodEnd)?.value;

  test("MRK FY2023 D&A discloses the 10-K 0000310158-26-000063 R9 Amortization 2,044M above the 2,000M note", () => {
    const notes = load("mrk").statements.omissionNotes.filter(
      ({ code }) => code === "unreconciled-component",
    );
    expect(notes.map(({ periodKey }) => periodKey)).toEqual(["duration:12|2023-12-31"]);
    expect(notes[0]?.message).toContain("AdjustmentForAmortization (2044000000) is higher");
  });

  test("IREN FY2024-26 capex and FCF are withheld: 10-K R7 also pays computer hardware (1,335,081K FY2026)", () => {
    const { statements, series, metrics } = load("iren", [iren10K(irenHtml())]);
    const capex = series.capitalExpenditure!;
    expect(
      capex.annual.map(({ periodEnd }) => periodEnd).filter((end) => end > "2023-06-30"),
    ).toEqual([]);
    expect(capex.annual.length).toBeGreaterThan(0);
    expect(capex.interim.filter(({ periodEnd }) => periodEnd > "2023-06-30")).toEqual([]);
    expect(capex.ttm).toBeUndefined();
    expect(metrics.find(({ id }) => id === "freeCashFlowMargin")?.status).toBe("missing");
    const valuation = valuationPeriodInputs(statements);
    expect(valuation.ttm?.freeCashFlow).toBeUndefined();
    expect(
      valuation.periods.filter(
        ({ periodEnd, freeCashFlow }) => periodEnd > "2023-06-30" && freeCashFlow !== undefined,
      ),
    ).toEqual([]);
    const notes = statements.omissionNotes.filter(
      ({ code, seriesKey }) =>
        code === "incomplete-composite-series" && seriesKey === "capitalExpenditure",
    );
    expect(notes.map(({ periodKey }) => periodKey)).toEqual([
      "duration:12|2026-06-30",
      "duration:12|2025-06-30",
      "duration:12|2024-06-30",
    ]);
    expect(notes[0]?.message).toContain(
      "iren:PaymentsRelatedToComputerHardware 1335081000 iso4217:USD beside the standard PP&E line (2998006000 USD)",
    );
    expect(notes[0]?.message).toContain("extended-sec-edgar-iren-");
    expect(notes.some(({ message }) => /RightOfUse|Prepayments/u.test(message))).toBe(false);
    const gaps = financialStatementsHistoryGaps(statements).filter(({ message }) =>
      message.startsWith("SEC capital expenditure"),
    );
    expect(gaps).toHaveLength(3);
    expect(gaps.map((gap) => classifyGap(gap, "IREN"))).toEqual([
      "material",
      "material",
      "material",
    ]);
  });

  test("IREN prepayment, deposit and right-of-use extension payments alone leave capex published", () => {
    const html = irenHtml()
      .split("\n")
      .filter((line) => !line.includes("iren:PaymentsRelatedToComputerHardware"))
      .join("\n");
    expect(html).toContain("iren:PaymentsToAcquireRightOfUseAssets");
    expect(html).toContain("iren:PaymentsForOtherPrepaymentsAndDepositsInvestingActivities");
    expect(secExtensionCapexFactMetrics(html, "2026-06-30")).toEqual({
      extensionCapexChecked: "true",
    });
    const { statements, series } = load("iren", [iren10K(html)]);
    expect(
      series.capitalExpenditure?.annual.find(({ periodEnd }) => periodEnd === "2026-06-30")?.value,
    ).toBe(2_998_006_000);
    expect(
      statements.omissionNotes.filter(({ seriesKey }) => seriesKey === "capitalExpenditure"),
    ).toEqual([]);
  });

  test("extension capex detection keeps hardware acquisitions and skips business acquisitions", () => {
    const html = irenHtml()
      .replaceAll(
        "iren:PaymentsRelatedToComputerHardware",
        "iren:PaymentsForAcquisitionOfComputerHardware",
      )
      .replaceAll(
        "iren:PaymentsToAcquireRightOfUseAssets",
        "iren:PaymentsToAcquireBusinessesAndEquipmentNetOfCash",
      );
    expect(Object.keys(secExtensionCapexFactMetrics(html, "2026-06-30")).slice(1)).toEqual([
      "extensionCapex|iren:PaymentsForAcquisitionOfComputerHardware|2025-07-01|2026-06-30|iso4217:USD",
      "extensionCapex|iren:PaymentsForAcquisitionOfComputerHardware|2024-07-01|2025-06-30|iso4217:USD",
      "extensionCapex|iren:PaymentsForAcquisitionOfComputerHardware|2023-07-01|2024-06-30|iso4217:USD",
    ]);
  });

  test("an extension line on no capex period withholds nothing", () => {
    const html = irenHtml()
      .replaceAll("2025-07-01", "1989-07-01")
      .replaceAll("2026-06-30", "1990-06-30");
    const { series } = load("iren", [iren10K(html)]);
    expect(
      series.capitalExpenditure?.annual.find(({ periodEnd }) => periodEnd === "2026-06-30")?.value,
    ).toBe(2_998_006_000);
  });

  test("withholding a TTM component withholds the TTM", () => {
    expect(load("aapl").series.capitalExpenditure?.ttm).toBeDefined();
    const item = {
      ...filingItem(
        "hlit-10k-0001193125-26-067506.xbrl.html",
        "10-K",
        "2025-10-31",
        "2025-09-27",
        "0000320193-25-000079",
      ),
      metrics: {
        form: "10-K",
        extensionCapexChecked: "true",
        "extensionCapex|aapl:PaymentsForServers|2024-09-29|2025-09-27|iso4217:USD": 1,
      },
    };
    const { series } = load("aapl", [item]);
    expect(
      series.capitalExpenditure?.annual.some(({ periodEnd }) => periodEnd === "2025-09-27"),
    ).toBe(false);
    expect(series.capitalExpenditure?.ttm).toBeUndefined();
  });

  test("a metadata-only filing item still leaves capex unchecked", () => {
    const item = {
      ...iren10K(irenHtml()),
      metrics: { form: "10-K", accessionNumber: "0001878848-26-000052" },
    };
    expect(
      load("iren", [item]).statements.omissionNotes.filter(
        ({ code }) => code === "unchecked-extension-capex",
      ),
    ).toHaveLength(1);
  });

  describe("brief collection checks the latest 10-K for extension capex", () => {
    const irenFixture = JSON.parse(readFileSync(join(FIXTURES, "iren.json"), "utf8"));
    const tenK =
      "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000052/iren-20260630.htm";
    const tenQ =
      "https://www.sec.gov/Archives/edgar/data/1878848/000187884826000099/iren-20260331.htm";
    const textUrls: string[] = [];
    const briefCtx = (
      text: (url: string) => string | undefined,
      options: { secUserAgent?: string; tenKReportDate?: string; withTenQ?: boolean } = {},
    ): CollectContext => {
      const json: Readonly<Record<string, unknown>> = {
        "sec-tickers": { "0": { cik_str: 1_878_848, ticker: "IREN", title: "IREN Ltd" } },
        "sec-companyfacts": irenFixture.companyFacts,
        "sec-submissions": {
          ...irenFixture.submissions,
          filings: {
            recent: recent(options.tenKReportDate ?? "2026-06-30", options.withTenQ ?? false),
          },
        },
      };
      return {
        command: { jobType: "equity", assetClass: "equity", symbol: "IREN", depth: "brief" },
        fetchedAt: irenFixture.analysisAsOf,
        newsLimit: 0,
        cryptoMoverLimit: 0,
        ...(options.secUserAgent !== undefined ? { secUserAgent: options.secUserAgent } : {}),
        request: {
          json: async ({ adapter }) => {
            const payload = json[adapter];
            return {
              rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt: "", payload },
              payload,
            };
          },
          text: async ({ url, adapter }) => {
            textUrls.push(url);
            const body = text(url);
            return body === undefined
              ? {
                  source: "sec-edgar",
                  message: `fetch failed ${url}`,
                  cause: "fetch-failed" as const,
                }
              : {
                  rawSnapshot: { id: `raw-${url.slice(-17)}`, adapter, fetchedAt: "", payload: "" },
                  payload: `ITEM 7. MANAGEMENT'S DISCUSSION ${"Revenue grew on stronger demand while margins held steady. ".repeat(8)} ${body}`,
                };
          },
        },
      };
    };
    const agent = { secUserAgent: "test-agent" };

    test("IREN FY2026 capex is withheld and the filing stays an auditable source without prose", async () => {
      textUrls.length = 0;
      const result = await collect(briefCtx(() => irenHtml(), agent));
      expect(textUrls).toEqual([tenK]);
      expect(result.fy2026).toBeUndefined();
      expect(result.codes).not.toContain("unchecked-extension-capex");
      expect(result.codes).toContain("incomplete-composite-series");
      const [source] = result.periodicFilings?.sources ?? [];
      expect(source).toMatchObject({
        provider: "sec-edgar",
        url: tenK,
        rawRef: "raw-iren-20260630.htm",
      });
      expect(source?.snippet).toBeUndefined();
      expect(result.periodicFilings?.rawSnapshots.map(({ id }) => id)).toEqual([
        "raw-iren-20260630.htm",
      ]);
    });

    test("an issuer filing no extension keeps capex and drops the unchecked note", async () => {
      const html = irenHtml().replaceAll(
        "iren:PaymentsRelatedToComputerHardware",
        "iren:OtherCash",
      );
      const result = await collect(briefCtx(() => html, agent));
      expect(result.periodicFilings?.gaps).toEqual([]);
      expect([result.fy2026, result.codes]).toEqual([2_998_006_000, []]);
    });

    test("a parsed 10-K with a failed newer 10-Q leaves later capex unchecked and gaps the fetch", async () => {
      const result = await collect(
        briefCtx((url) => (url === tenQ ? undefined : "<html></html>"), {
          ...agent,
          tenKReportDate: "2025-06-30",
          withTenQ: true,
        }),
      );
      expect(result.fy2026).toBe(2_998_006_000);
      expect(result.codes).toEqual(["unchecked-extension-capex"]);
      expect(result.periodicFilings?.gaps.map(({ message }) => message)).toContain(
        `fetch failed ${tenQ}`,
      );
    });

    test("a failed 10-K fetch or no SEC user agent keeps capex with the unchecked note", async () => {
      const failed = await collect(briefCtx(() => undefined, agent));
      expect([failed.fy2026, failed.codes]).toEqual([2_998_006_000, ["unchecked-extension-capex"]]);
      expect(failed.periodicFilings?.gaps).toHaveLength(1);
      textUrls.length = 0;
      const noAgent = await collect(briefCtx(() => irenHtml()));
      expect([noAgent.codes, noAgent.periodicFilings, textUrls]).toEqual([
        ["unchecked-extension-capex"],
        undefined,
        [],
      ]);
    });
  });

  test("capex without a read 10-K or 10-Q carries the unchecked-extension note, not a gap", () => {
    const { statements } = load("aapl");
    expect(
      statements.omissionNotes.filter(({ code }) => code === "unchecked-extension-capex"),
    ).toHaveLength(1);
    expect(
      financialStatementsHistoryGaps(statements).some(({ message }) =>
        message.includes("not checked"),
      ),
    ).toBe(false);
  });

  test("CLFD FY2025 ROIC is withheld while debt sits in discontinued operations", () => {
    expect(load("clfd").metrics.find(({ id }) => id === "roic")?.status).toBe("missing");
  });
  test("HLIT FY2025 D&A is withheld with an omission note", () => {
    const { statements } = load("hlit");
    const notes = [...statements.validationNotes, ...statements.omissionNotes];
    expect(
      notes.some(
        ({ seriesKey, periodKey }) =>
          seriesKey === "depreciationAndAmortization" && periodKey === "duration:12|2025-12-31",
      ),
    ).toBe(true);
  });
  test("MARA FY2025 10-K 0001507605-26-000007 debt: notes 47,845K + 3,202,082K + LOC 350,000K", () => {
    expect(fact("mara", "debt", "2025-12-31")).toBe(3_599_927_000);
    const debt = load("mara").series.debt?.annual.find(
      ({ periodEnd }) => periodEnd === "2025-12-31",
    );
    expect(debt?.accessionNumber).toBe("0001507605-26-000007");
  });
});

function filingItem(
  file: string,
  form: "10-K" | "10-Q",
  filingDate: string,
  reportDate: string,
  accessionNumber: string,
): ExtendedEvidenceItem {
  return {
    category: "sec-edgar",
    title: `SEC ${form}`,
    summary: `${form} filed ${filingDate} for period ${reportDate}.`,
    sourceIds: [accessionNumber],
    observedAt: "2026-10-26T00:00:00.000Z",
    metrics: {
      form,
      filingDate,
      reportDate,
      accessionNumber,
      ...secGeographyFactMetrics(readFileSync(join(FIXTURES, file), "utf8"), reportDate),
      ...secExtensionCapexFactMetrics(readFileSync(join(FIXTURES, file), "utf8"), reportDate),
    },
  };
}

function shares(items: readonly ExtendedEvidenceItem[], period: string) {
  const metrics = geographicRevenueSection("ref", items)?.section?.metrics ?? [];
  return Object.fromEntries(
    metrics
      .filter(({ id, status }) => id.endsWith(`${period}-share`) && status === "value")
      .map((metric) => [
        metric.id.replace(`-${period}-share`, ""),
        metric.status === "value" ? Math.round(Number(metric.value) * 10_000) / 100 : undefined,
      ]),
  );
}

describe("SEC reference set geography (hand-checked against filed revenue by region)", () => {
  const hlit10K = filingItem(
    "hlit-10k-0001193125-26-067506.xbrl.html",
    "10-K",
    "2026-02-24",
    "2025-12-31",
    "0001193125-26-067506",
  );
  const hlit10Q = filingItem(
    "hlit-10q-0001193125-26-353891.xbrl.html",
    "10-Q",
    "2026-08-17",
    "2026-07-03",
    "0001193125-26-353891",
  );

  test("HLIT FY2025 regions from 10-K 0001193125-26-067506 (320,570 / 33,894 / 6,059 of 360,523)", () => {
    expect(shares([hlit10Q, hlit10K], "2025-01-01-2025-12-31")).toMatchObject({
      srt_AmericasMember: 88.92,
      "us-gaap_EMEAMember": 9.4,
      srt_AsiaPacificMember: 1.68,
    });
  });

  test("HLIT H1 2026 regions from 10-Q 0001193125-26-353891 (227,033 / 18,880 / 9,244 of 255,157)", () => {
    expect(shares([hlit10Q, hlit10K], "2026-01-01-2026-07-03")).toMatchObject({
      srt_AmericasMember: 88.98,
      "us-gaap_EMEAMember": 7.4,
      srt_AsiaPacificMember: 3.62,
    });
  });

  test("AMD FY2025 countries from 10-K 0000002488-26-000018 R54 (of 34,639M)", () => {
    const amd10K = filingItem(
      "amd-10k-0000002488-26-000018.xbrl.html",
      "10-K",
      "2026-02-04",
      "2025-12-27",
      "0000002488-26-000018",
    );
    expect(shares([amd10K], "2024-12-29-2025-12-27")).toEqual({
      country_US: 32.8,
      country_CN: 22.38,
      country_TW: 14.97,
      country_SG: 12.37,
      amd_OtherCountriesMember: 17.48,
    });
  });
});
