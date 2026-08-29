import type {
  FinancialStatementName,
  FinancialStatementSeriesKey,
  FinancialStatementTaxonomy,
} from "./financial-statements-contract";

type FinancialStatementConceptAliases = Readonly<
  Record<FinancialStatementTaxonomy, readonly string[]>
>;

export interface FinancialStatementSeriesDefinition {
  readonly key: FinancialStatementSeriesKey;
  readonly label: string;
  readonly statement: FinancialStatementName;
  readonly kind: "duration" | "instant";
  readonly unitKind: "monetary" | "per-share" | "shares";
  readonly deriveTtm: boolean;
  readonly concepts: FinancialStatementConceptAliases;
  readonly components?: readonly FinancialStatementConceptAliases[];
}

const DAY_MS = 86_400_000;
const REVENUE_CONCEPT_RECENCY_BUCKET_DAYS = 100;

export function isRevenueConceptInRecencyBucket(
  periodEnd: string,
  latestPeriodEnd: string,
): boolean {
  const ageDays = (Date.parse(latestPeriodEnd) - Date.parse(periodEnd)) / DAY_MS;
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= REVENUE_CONCEPT_RECENCY_BUCKET_DAYS;
}

export const FINANCIAL_STATEMENT_SERIES_DEFINITIONS: readonly FinancialStatementSeriesDefinition[] =
  [
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
      concepts: {
        "us-gaap": ["LongTermDebt"],
        "ifrs-full": ["Borrowings"],
      },
      components: [
        {
          "us-gaap": ["LongTermDebtCurrent", "ShortTermBorrowings", "ShortTermDebt"],
          "ifrs-full": ["CurrentBorrowings"],
        },
        {
          "us-gaap": ["LongTermDebtNoncurrent"],
          "ifrs-full": ["NoncurrentBorrowings"],
        },
      ],
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
  ];
