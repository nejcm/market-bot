export type SyntheticAliasVariant = "alias" | "component" | "renamed-disjoint" | "newer-alias";

interface SyntheticAliasPayloads {
  readonly companyFacts: unknown;
  readonly submissions: unknown;
}

interface SyntheticAnnualFact {
  readonly val: number;
  readonly accn: string;
  readonly fy: number;
  readonly fp: "FY";
  readonly form: "10-K";
  readonly filed: string;
  readonly start: string;
  readonly end: string;
}

const CIK = 9_000_003;
const ENTITY_NAME = "Fixture Alias Issuer, Inc.";

function annualFact(year: number, value: number): SyntheticAnnualFact {
  const filedYear = year + 1;
  return {
    val: value,
    accn: `0009000003-${String(filedYear).slice(-2)}-000001`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${String(filedYear)}-02-15`,
    start: `${String(year)}-01-01`,
    end: `${String(year)}-12-31`,
  };
}

function annualFacts(
  years: readonly number[],
  scale = 1,
  valueOffsetYear = 2015,
): readonly SyntheticAnnualFact[] {
  return years.map((year) => annualFact(year, 10_000_000 * (year - valueOffsetYear) * scale));
}

export function buildSyntheticAliasPayloads(
  variant: SyntheticAliasVariant,
): SyntheticAliasPayloads {
  const revenueYears =
    variant === "newer-alias"
      ? ([2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022] as const)
      : ([2019, 2020, 2021, 2022, 2023, 2024, 2025] as const);
  const salesYearsByVariant = {
    alias: [2016, 2017, 2018, ...revenueYears],
    component: [2016, 2017, 2018, ...revenueYears],
    "renamed-disjoint": [2016, 2017, 2018],
    "newer-alias": [...revenueYears, 2023],
  } satisfies Readonly<Record<SyntheticAliasVariant, readonly number[]>>;
  const valueOffsetYear = variant === "newer-alias" ? 2012 : 2015;
  const revenueFacts = annualFacts(revenueYears, 1, valueOffsetYear);
  const revenueUnits =
    variant === "newer-alias"
      ? [
          ...revenueFacts,
          {
            ...annualFact(2023, 110_000_000),
            accn: "0009000003-23-000002",
            fp: "Q3",
            form: "10-Q",
            filed: "2023-11-01",
            end: "2023-09-30",
          },
        ]
      : revenueFacts;
  const salesFacts = annualFacts(
    salesYearsByVariant[variant],
    variant === "component" ? 7 : 1,
    valueOffsetYear,
  );

  return {
    companyFacts: {
      cik: CIK,
      entityName: ENTITY_NAME,
      facts: {
        "us-gaap": {
          Revenues: {
            label: "Revenues",
            description: "Synthetic selected revenue series.",
            units: { USD: revenueUnits },
          },
          SalesRevenueNet: {
            label: "Sales Revenue, Net",
            description: "Synthetic alternative revenue series.",
            units: { USD: salesFacts },
          },
        },
      },
    },
    submissions: {
      cik: "0009000003",
      name: ENTITY_NAME,
      tickers: ["ALIAS"],
      exchanges: ["Nasdaq"],
      filings: {
        recent: { accessionNumber: [], filingDate: [], reportDate: [], form: [] },
      },
    },
  };
}
