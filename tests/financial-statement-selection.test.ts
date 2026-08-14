import { describe, expect, test } from "bun:test";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
  SupportedSecForm,
} from "../src/sources/extended-evidence/financial-statements-contract";
import {
  capFinancialStatementPeriods,
  financialStatementFactForPeriod,
  financialStatementFactsAreCompatible,
  financialStatementSeries,
  financialStatementSeriesByKey,
  financialStatementTtmsAreCompatible,
  financialStatementTtmsSharePeriod,
  latestCommonFinancialStatementFacts,
  latestCommonFinancialStatementPeriodEndFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "../src/sources/extended-evidence/financial-statement-definitions";
import { SEC_METRIC_DEFINITIONS } from "../src/sources/extended-evidence/sec-edgar";

interface FactOverrides {
  readonly value?: number;
  readonly periodKey?: string;
  readonly periodType?: "annual" | "interim";
  readonly periodStart?: string | null;
  readonly periodEnd?: string;
  readonly filedAt?: string;
  readonly amendment?: boolean;
  readonly accessionNumber?: string | null;
  readonly currency?: string | null;
  readonly unit?: string;
  readonly unitScale?: number;
}

function fact(overrides: FactOverrides = {}): FinancialStatementFact {
  const periodType = overrides.periodType ?? "annual";
  const amendment = overrides.amendment ?? false;
  const canonicalForm = periodType === "annual" ? "10-K" : "10-Q";
  let form: SupportedSecForm = canonicalForm;
  if (amendment) {
    form = canonicalForm === "10-K" ? "10-K/A" : "10-Q/A";
  }
  return {
    value: overrides.value ?? 1,
    periodKey: overrides.periodKey ?? "2024-01-01|2024-12-31",
    periodType,
    form,
    canonicalForm,
    amendment,
    accessionNumber: overrides.accessionNumber ?? "accession-a",
    filedAt: overrides.filedAt ?? "2025-02-01",
    ...(overrides.periodStart === null
      ? {}
      : { periodStart: overrides.periodStart ?? "2024-01-01" }),
    periodEnd: overrides.periodEnd ?? "2024-12-31",
    fiscalYear: 2024,
    fiscalPeriod: periodType === "annual" ? "FY" : "Q4",
    taxonomy: "us-gaap",
    concept: "TestConcept",
    currency: overrides.currency === undefined ? "USD" : overrides.currency,
    unit: overrides.unit ?? "USD",
    unitScale: overrides.unitScale ?? 1,
    extractionMethod: "sec-companyfacts",
    sourceIds: ["sec-test"],
  };
}

function ttm(overrides: Partial<FinancialStatementTtm> = {}): FinancialStatementTtm {
  const fiscalYear = fact();
  const latestYearToDate = fact({
    periodKey: "2025-01-01|2025-03-31",
    periodType: "interim",
    periodStart: "2025-01-01",
    periodEnd: "2025-03-31",
  });
  const priorYearToDate = fact({
    periodKey: "2024-01-01|2024-03-31",
    periodType: "interim",
    periodStart: "2024-01-01",
    periodEnd: "2024-03-31",
  });
  return {
    value: 1,
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    currency: "USD",
    unit: "USD",
    unitScale: 1,
    extractionMethod: "derived-sec-companyfacts",
    formula: "FY + latest-YTD - prior-YTD",
    sourceIds: ["sec-test"],
    components: { fiscalYear, latestYearToDate, priorYearToDate },
    ...overrides,
  };
}

function series(
  key: FinancialStatementSeriesKey,
  facts: readonly FinancialStatementFact[],
): FinancialStatementSeries {
  return {
    key,
    label: key,
    statement: "incomeStatement",
    annual: facts.filter((item) => item.periodType === "annual"),
    interim: facts.filter((item) => item.periodType === "interim"),
  };
}

describe("financial statement selection", () => {
  test("pins complete legacy and canonical financial-statement definitions", () => {
    // Concept order encodes measure scope (total -> net -> ASC606 for revenue); reordering can swap a total measure for a component.
    expect(SEC_METRIC_DEFINITIONS).toEqual([
      {
        key: "revenue",
        label: "revenue",
        concepts: [
          "Revenues",
          "SalesRevenueNet",
          "RevenueFromContractWithCustomerExcludingAssessedTax",
          "RevenueFromContractWithCustomerIncludingAssessedTax",
        ],
        unitKeys: ["USD"],
      },
      {
        key: "grossProfit",
        label: "gross profit",
        concepts: ["GrossProfit"],
        unitKeys: ["USD"],
      },
      {
        key: "operatingIncome",
        label: "operating income",
        concepts: ["OperatingIncomeLoss"],
        unitKeys: ["USD"],
      },
      {
        key: "netIncome",
        label: "net income attributable to parent",
        concepts: ["NetIncomeLoss"],
        unitKeys: ["USD"],
      },
      {
        key: "consolidatedNetIncome",
        label: "net income consolidated including NCI",
        concepts: ["ProfitLoss"],
        unitKeys: ["USD"],
        optional: true,
      },
      {
        key: "dilutedEps",
        label: "diluted EPS",
        concepts: ["EarningsPerShareDiluted"],
        unitKeys: ["USD/shares"],
      },
      {
        key: "cash",
        label: "cash",
        concepts: [
          "CashAndCashEquivalentsAtCarryingValue",
          "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
        ],
        unitKeys: ["USD"],
      },
      {
        key: "operatingCashFlow",
        label: "operating cash flow",
        concepts: ["NetCashProvidedByUsedInOperatingActivities"],
        unitKeys: ["USD"],
      },
      {
        key: "capex",
        label: "capex",
        concepts: ["PaymentsToAcquirePropertyPlantAndEquipment"],
        unitKeys: ["USD"],
      },
      {
        key: "dilutedShares",
        label: "diluted shares",
        concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
        unitKeys: ["shares"],
      },
      {
        key: "currentAssets",
        label: "current assets",
        concepts: ["AssetsCurrent"],
        unitKeys: ["USD"],
      },
      {
        key: "currentLiabilities",
        label: "current liabilities",
        concepts: ["LiabilitiesCurrent"],
        unitKeys: ["USD"],
      },
      {
        key: "stockholdersEquity",
        label: "stockholders' equity",
        concepts: [
          "StockholdersEquity",
          "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        ],
        unitKeys: ["USD"],
        optional: true,
      },
      {
        key: "assets",
        label: "total assets",
        concepts: ["Assets"],
        unitKeys: ["USD"],
        optional: true,
      },
      {
        key: "dividendsPaid",
        label: "dividends paid",
        concepts: ["PaymentsForDividends", "DividendsPaid"],
        unitKeys: ["USD"],
        optional: true,
      },
      {
        key: "shareRepurchases",
        label: "share repurchases",
        concepts: [
          "PaymentsForRepurchaseOfCommonStock",
          "PaymentsForRepurchaseOfEquity",
          "PaymentsForRepurchaseOfCommonStockAndPreferredStock",
        ],
        unitKeys: ["USD"],
        optional: true,
      },
    ]);
    expect(FINANCIAL_STATEMENT_SERIES_DEFINITIONS).toEqual([
      {
        key: "revenue",
        label: "Revenue",
        statement: "incomeStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": [
            "Revenues",
            "SalesRevenueNet",
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "RevenueFromContractWithCustomerIncludingAssessedTax",
          ],
          "ifrs-full": ["Revenue"],
        },
      },
      {
        key: "grossProfit",
        label: "Gross profit",
        statement: "incomeStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: { "us-gaap": ["GrossProfit"], "ifrs-full": ["GrossProfit"] },
      },
      {
        key: "operatingIncome",
        label: "Operating income",
        statement: "incomeStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["OperatingIncomeLoss"],
          "ifrs-full": ["ProfitLossFromOperatingActivities"],
        },
      },
      {
        key: "netIncome",
        label: "Net income",
        statement: "incomeStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: { "us-gaap": ["NetIncomeLoss"], "ifrs-full": ["ProfitLoss"] },
      },
      {
        key: "cash",
        label: "Cash and cash equivalents",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: {
          "us-gaap": [
            "CashAndCashEquivalentsAtCarryingValue",
            "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
          ],
          "ifrs-full": ["CashAndCashEquivalents"],
        },
      },
      {
        key: "currentAssets",
        label: "Current assets",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: { "us-gaap": ["AssetsCurrent"], "ifrs-full": ["CurrentAssets"] },
      },
      {
        key: "currentLiabilities",
        label: "Current liabilities",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: {
          "us-gaap": ["LiabilitiesCurrent"],
          "ifrs-full": ["CurrentLiabilities"],
        },
      },
      {
        key: "totalAssets",
        label: "Total assets",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: { "us-gaap": ["Assets"], "ifrs-full": ["Assets"] },
      },
      {
        key: "totalLiabilities",
        label: "Total liabilities",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: { "us-gaap": ["Liabilities"], "ifrs-full": ["Liabilities"] },
      },
      {
        key: "stockholdersEquity",
        label: "Stockholders' equity",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: {
          "us-gaap": [
            "StockholdersEquity",
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
          ],
          "ifrs-full": ["Equity"],
        },
      },
      {
        key: "debt",
        label: "Debt",
        statement: "balanceSheet",
        kind: "instant",
        unitKind: "monetary",
        deriveTtm: false,
        concepts: { "us-gaap": ["LongTermDebt"], "ifrs-full": ["Borrowings"] },
      },
      {
        key: "operatingCashFlow",
        label: "Operating cash flow",
        statement: "cashFlowStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["NetCashProvidedByUsedInOperatingActivities"],
          "ifrs-full": ["CashFlowsFromUsedInOperatingActivities"],
        },
      },
      {
        key: "capitalExpenditure",
        label: "Capital expenditure",
        statement: "cashFlowStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["PaymentsToAcquirePropertyPlantAndEquipment"],
          "ifrs-full": ["PurchaseOfPropertyPlantAndEquipment"],
        },
      },
      {
        key: "dividendsPaid",
        label: "Dividends paid",
        statement: "cashFlowStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["PaymentsForDividends", "DividendsPaid"],
          "ifrs-full": ["DividendsPaidClassifiedAsFinancingActivities"],
        },
      },
      {
        key: "shareRepurchases",
        label: "Share repurchases",
        statement: "cashFlowStatement",
        kind: "duration",
        unitKind: "monetary",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"],
          "ifrs-full": ["PaymentsToAcquireOrRedeemEntitysShares"],
        },
      },
      {
        key: "dilutedEps",
        label: "Diluted EPS",
        statement: "perShare",
        kind: "duration",
        unitKind: "per-share",
        deriveTtm: true,
        concepts: {
          "us-gaap": ["EarningsPerShareDiluted"],
          "ifrs-full": ["DilutedEarningsLossPerShare"],
        },
      },
      {
        key: "dilutedShares",
        label: "Diluted weighted-average shares",
        statement: "perShare",
        kind: "duration",
        unitKind: "shares",
        deriveTtm: false,
        concepts: {
          "us-gaap": ["WeightedAverageNumberOfDilutedSharesOutstanding"],
          "ifrs-full": ["AdjustedWeightedAverageShares"],
        },
      },
    ]);
  });

  test("pins roster-covered non-revenue series to one concept per taxonomy", () => {
    const legacyKeys = new Set([
      "grossProfit",
      "operatingIncome",
      "netIncome",
      "dilutedEps",
      "operatingCashFlow",
      "capex",
    ]);
    const canonicalKeys = new Set(
      [...legacyKeys].map((key) => (key === "capex" ? "capitalExpenditure" : key)),
    );
    expect(
      SEC_METRIC_DEFINITIONS.filter((definition) => legacyKeys.has(definition.key)).every(
        (definition) => definition.concepts.length === 1,
      ),
    ).toBe(true);
    expect(
      FINANCIAL_STATEMENT_SERIES_DEFINITIONS.filter((definition) =>
        canonicalKeys.has(definition.key),
      ).every((definition) =>
        Object.values(definition.concepts).every((concepts) => concepts.length === 1),
      ),
    ).toBe(true);
  });

  test("uses filing, amendment, then accession tie breakers after period and duration", () => {
    const selected = latestFinancialStatementFact([
      fact({ filedAt: "2025-03-01", accessionNumber: "accession-z" }),
      fact({ filedAt: "2025-03-01", amendment: true, accessionNumber: "accession-a" }),
      fact({ filedAt: "2025-03-01", amendment: true, accessionNumber: "accession-b", value: 2 }),
      fact({ filedAt: "2025-02-01", amendment: true, accessionNumber: "accession-z" }),
      fact({ periodEnd: "2023-12-31", periodKey: "2023-01-01|2023-12-31" }),
    ]);

    expect(selected?.value).toBe(2);
  });

  test("treats bucket-equivalent durations as ties before filing precedence", () => {
    const selected = latestFinancialStatementFact([
      fact({ value: 1, filedAt: "2025-02-01", periodStart: "2024-01-01" }),
      fact({ value: 2, filedAt: "2025-03-01", periodStart: "2024-01-02" }),
    ]);

    expect(selected?.value).toBe(2);
  });

  test("prefers the fuller bucket-equivalent period within the same filing", () => {
    const fuller = fact({
      value: 1000,
      periodStart: "2024-01-01",
      filedAt: "2025-02-01",
      accessionNumber: "same-filing",
    });
    const shorter = fact({
      value: 940,
      periodStart: "2024-01-15",
      filedAt: "2025-02-01",
      accessionNumber: "same-filing",
    });

    expect(latestFinancialStatementFact([fuller, shorter])).toBe(fuller);
  });

  test("prefers the fuller bucket-equivalent period regardless of input order", () => {
    const fuller = fact({
      value: 1000,
      periodStart: "2024-01-01",
      filedAt: "2025-02-01",
      accessionNumber: "same-filing",
    });
    const shorter = fact({
      value: 940,
      periodStart: "2024-01-15",
      filedAt: "2025-02-01",
      accessionNumber: "same-filing",
    });

    expect(latestFinancialStatementFact([shorter, fuller])).toBe(fuller);
  });

  test("prefers the longer annual duration when annual and interim facts share an end", () => {
    const annual = fact({ value: 12 });
    const interim = fact({
      value: 3,
      periodKey: "2024-10-01|2024-12-31",
      periodType: "interim",
      periodStart: "2024-10-01",
      filedAt: "2025-03-01",
    });

    expect(latestFinancialStatementFact([interim, annual])).toBe(annual);
  });

  test("treats instant facts as zero-duration in the total ordering", () => {
    const duration = fact({ value: 12, filedAt: "2025-02-01" });
    const instant = fact({
      value: 2,
      periodKey: "instant|2024-12-31",
      periodStart: null,
      filedAt: "2025-05-01",
    });

    expect(latestFinancialStatementFact([instant, duration])).toBe(duration);
  });

  test("requires matching unit scale for compatible facts", () => {
    expect(financialStatementFactsAreCompatible([fact(), fact({ unitScale: 1000 })])).toBe(false);
  });

  test("checks TTM period alignment separately from full compatibility", () => {
    const base = ttm();
    const differentUnit = ttm({ unit: "EUR" });
    const differentPeriod = ttm({ periodStart: "2024-07-01" });

    expect(financialStatementTtmsSharePeriod([base, differentUnit])).toBe(true);
    expect(financialStatementTtmsAreCompatible([base, differentUnit])).toBe(false);
    expect(financialStatementTtmsSharePeriod([base, differentPeriod])).toBe(false);
    expect(financialStatementTtmsAreCompatible([base, differentPeriod])).toBe(false);
  });

  test("looks up only the exact period key and applies amendment precedence within it", () => {
    const target = "2024-01-01|2024-12-31";
    const values = series("revenue", [
      fact({ periodKey: "2024-04-01|2024-12-31", value: 9 }),
      fact({ periodKey: target, value: 10 }),
      fact({ periodKey: target, value: 11, amendment: true }),
    ]);

    expect(
      financialStatementFactForPeriod([...values.annual, ...values.interim], target, "annual")
        ?.value,
    ).toBe(11);
  });

  test("ignores an interim fact that shares a period key with the annual candidate", () => {
    const target = "duration:12|2024-12-31";
    const values = series("revenue", [
      fact({ periodKey: target, value: 10 }),
      fact({ periodKey: target, value: 99, periodType: "interim", filedAt: "2025-06-01" }),
    ]);

    expect(
      financialStatementFactForPeriod([...values.annual, ...values.interim], target, "annual")
        ?.value,
    ).toBe(10);
  });

  test("selects the latest exact common period with compatible units and currency", () => {
    const priorKey = "2023-01-01|2023-12-31";
    const latestKey = "2024-01-01|2024-12-31";
    const revenue = series("revenue", [
      fact({ periodKey: priorKey, periodEnd: "2023-12-31", periodStart: "2023-01-01", value: 8 }),
      fact({ periodKey: latestKey, value: 10 }),
    ]);
    const netIncome = series("netIncome", [
      fact({ periodKey: priorKey, periodEnd: "2023-12-31", periodStart: "2023-01-01", value: 2 }),
      fact({
        periodKey: "2024-04-01|2024-12-31",
        periodType: "interim",
        periodStart: "2024-04-01",
        value: 3,
      }),
      fact({ periodKey: latestKey, currency: "EUR", value: 4 }),
    ]);

    expect(
      latestCommonFinancialStatementFacts([revenue, netIncome])?.map((item) => item.value),
    ).toEqual([8, 2]);
  });

  test("handles empty and single-series common-period inputs", () => {
    const empty = series("revenue", []);
    const populated = series("netIncome", [
      fact({ periodKey: "2023-01-01|2023-12-31", periodEnd: "2023-12-31", value: 1 }),
      fact({ value: 2 }),
    ]);

    expect(latestCommonFinancialStatementFacts([])).toBeUndefined();
    expect(latestCommonFinancialStatementFacts([empty, populated])).toBeUndefined();
    expect(latestCommonFinancialStatementFacts([populated])?.map((item) => item.value)).toEqual([
      2,
    ]);
  });

  test("selects the latest compatible common period end for flow-to-balance ratios", () => {
    const netIncome = series("netIncome", [
      fact({ periodEnd: "2024-12-31", periodKey: "2024-01-01|2024-12-31", value: 2 }),
      fact({ periodEnd: "2025-12-31", periodKey: "2025-01-01|2025-12-31", value: 3 }),
    ]);
    const assets = series("totalAssets", [
      fact({
        periodStart: null,
        periodEnd: "2025-12-31",
        periodKey: "instant|2025-12-31",
        value: 10,
      }),
      fact({
        periodStart: null,
        periodEnd: "2026-03-31",
        periodKey: "instant|2026-03-31",
        periodType: "interim",
        value: 12,
      }),
    ]);

    expect(
      latestCommonFinancialStatementPeriodEndFacts([netIncome, assets])?.map((item) => item.value),
    ).toEqual([3, 10]);
  });

  test("caps duration and instant periods independently", () => {
    const years = Array.from({ length: 10 }, (_, index) => 2017 + index);
    const durations = series(
      "revenue",
      years.map((year) =>
        fact({
          periodKey: `${String(year - 1)}-07-01|${String(year)}-06-30`,
          periodStart: `${String(year - 1)}-07-01`,
          periodEnd: `${String(year)}-06-30`,
        }),
      ),
    );
    const instants = series(
      "totalAssets",
      years.map((year) =>
        fact({
          periodKey: `instant|${String(year)}-06-30`,
          periodStart: null,
          periodEnd: `${String(year)}-06-30`,
        }),
      ),
    );

    const capped = capFinancialStatementPeriods([durations, instants]);

    expect(capped.series[0]?.annual).toHaveLength(10);
    expect(capped.series[1]?.annual).toHaveLength(10);
    expect(capped.notes).toEqual([]);
  });

  test("evicts the oldest duration without consuming the instant-period budget", () => {
    const durationYears = Array.from({ length: 11 }, (_, index) => 2016 + index);
    const instantYears = Array.from({ length: 5 }, (_, index) => 2022 + index);
    const durations = series(
      "revenue",
      durationYears.map((year) =>
        fact({
          periodKey: `${String(year - 1)}-07-01|${String(year)}-06-30`,
          periodStart: `${String(year - 1)}-07-01`,
          periodEnd: `${String(year)}-06-30`,
        }),
      ),
    );
    const instants = series(
      "totalAssets",
      instantYears.map((year) =>
        fact({
          periodKey: `instant|${String(year)}-06-30`,
          periodStart: null,
          periodEnd: `${String(year)}-06-30`,
        }),
      ),
    );

    const capped = capFinancialStatementPeriods([durations, instants]);

    expect(capped.series[0]?.annual.map((item) => item.periodKey)).toEqual(
      durationYears.slice(1).map((year) => `${String(year - 1)}-07-01|${String(year)}-06-30`),
    );
    expect(capped.series[1]?.annual.map((item) => item.periodKey)).toEqual(
      instantYears.map((year) => `instant|${String(year)}-06-30`),
    );
    expect(capped.notes).toEqual([
      {
        code: "history-cap",
        periodKey: "annual|2015-07-01|2016-06-30",
        message:
          "Older annual duration canonical period 2015-07-01|2016-06-30 omitted by the 10-period annual duration cap",
      },
    ]);
  });

  test("flattens and looks up artifact series through the shared authority", () => {
    const revenue = series("revenue", [fact()]);
    const artifact = {
      statements: {
        incomeStatement: { revenue },
        balanceSheet: {},
        cashFlowStatement: {},
        perShare: {},
      },
    } as unknown as FinancialStatementsArtifact;

    expect(financialStatementSeries(artifact)).toEqual([revenue]);
    expect(financialStatementSeriesByKey(artifact, "revenue")).toBe(revenue);
    expect(financialStatementSeriesByKey(artifact, "cash")).toBeUndefined();
  });
});
