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
}

interface DebtSideConcepts {
  readonly generic: readonly string[];
  readonly instruments: readonly (readonly string[])[];
}

export interface DebtTaxonomyConcepts {
  readonly totals: readonly string[];
  readonly current: DebtSideConcepts;
  readonly noncurrent: DebtSideConcepts;
  readonly financeLeases?: { readonly total: string; readonly split: readonly string[] };
  readonly leaseInclusive?: Readonly<Record<string, "current" | "noncurrent" | "total">>;
  readonly unrecognizedBorrowing?: RegExp;
  readonly umbrellas?: Readonly<Record<string, readonly string[]>>;
}

// Inner arrays are alternatives for one line item; separate entries are disjoint and add.
export const DEBT_CONCEPTS: Readonly<Record<FinancialStatementTaxonomy, DebtTaxonomyConcepts>> = {
  "us-gaap": {
    totals: [
      "LongTermDebt",
      "DebtLongtermAndShorttermCombinedAmount",
      "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
      "DebtAndCapitalLeaseObligations",
    ],
    current: {
      generic: [
        "LongTermDebtCurrent",
        "DebtCurrent",
        "LongTermDebtAndCapitalLeaseObligationsCurrent",
      ],
      instruments: [
        ["ShortTermBorrowings", "ShortTermDebt", "CommercialPaper"],
        ["NotesPayableCurrent"],
        ["LoansPayableCurrent"],
        ["LinesOfCreditCurrent"],
        ["ConvertibleDebtCurrent", "ConvertibleNotesPayableCurrent"],
        ["SecuredDebtCurrent"],
      ],
    },
    noncurrent: {
      generic: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
      instruments: [
        ["LongTermNotesPayable"],
        ["LongTermLoansPayable"],
        ["LongTermLineOfCredit"],
        ["ConvertibleDebtNoncurrent", "ConvertibleLongTermNotesPayable"],
        ["SecuredLongTermDebt"],
      ],
    },
    financeLeases: {
      total: "FinanceLeaseLiability",
      split: ["FinanceLeaseLiabilityCurrent", "FinanceLeaseLiabilityNoncurrent"],
    },
    leaseInclusive: {
      DebtCurrent: "current",
      LongTermDebtAndCapitalLeaseObligationsCurrent: "current",
      LongTermDebtAndCapitalLeaseObligations: "noncurrent",
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: "total",
      DebtAndCapitalLeaseObligations: "total",
    },
    // An umbrella spans both sides: used only when no leg and no generic side line is tagged.
    umbrellas: { LineOfCredit: ["LongTermLineOfCredit", "LinesOfCreditCurrent"] },
    unrecognizedBorrowing:
      /(?:Debt|Borrowings|Notes|NotesPayable|LoansPayable|LinesOfCredit|LineOfCredit|CommercialPaper|Debt\w*LeaseObligations)(?:Current|Noncurrent)?$/u,
  },
  "ifrs-full": {
    totals: ["Borrowings"],
    current: { generic: ["CurrentBorrowings"], instruments: [] },
    noncurrent: { generic: ["NoncurrentBorrowings"], instruments: [] },
  },
};

const DAY_MS = 86_400_000;
const REVENUE_CONCEPT_RECENCY_BUCKET_DAYS = 100;

export function isRevenueConceptInRecencyBucket(
  periodEnd: string,
  latestPeriodEnd: string,
): boolean {
  const ageDays = (Date.parse(latestPeriodEnd) - Date.parse(periodEnd)) / DAY_MS;
  return Number.isFinite(ageDays) && ageDays >= 0 && ageDays <= REVENUE_CONCEPT_RECENCY_BUCKET_DAYS;
}

const CONTINUING_OPERATIONS_SCOPE = "continuing operations";

export const TOTAL_OPERATIONS_SCOPE = "total operations";

const CONCEPT_SCOPES: Readonly<Record<string, string>> = {
  IncomeLossFromContinuingOperations: "continuing operations, attributable to parent",
  IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest:
    "continuing operations, including NCI",
  ProfitLossFromContinuingOperationsAttributableToOwnersOfParent:
    "continuing operations, attributable to parent",
  ProfitLossFromContinuingOperations: "continuing operations, including NCI",
  IncomeLossFromContinuingOperationsPerDilutedShare: CONTINUING_OPERATIONS_SCOPE,
  DilutedEarningsLossPerShareFromContinuingOperations: CONTINUING_OPERATIONS_SCOPE,
};

export function conceptScope(concept: string | undefined): string | undefined {
  if (concept === undefined) {
    return undefined;
  }
  return (
    CONCEPT_SCOPES[concept] ??
    (concept.endsWith("ContinuingOperations") ? CONTINUING_OPERATIONS_SCOPE : undefined)
  );
}

export function isContinuingScope(scope: string | undefined): boolean {
  return scope?.startsWith(CONTINUING_OPERATIONS_SCOPE) === true;
}

export function scopedLabel(label: string, scope: string | undefined): string {
  return scope === undefined ? label : `${label} (${scope})`;
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
      key: "continuingIncome",
      label: "Income from continuing operations",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: true,
      concepts: {
        "us-gaap": [
          "IncomeLossFromContinuingOperations",
          "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest",
        ],
        "ifrs-full": [
          "ProfitLossFromContinuingOperationsAttributableToOwnersOfParent",
          "ProfitLossFromContinuingOperations",
        ],
      },
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
        "us-gaap": ["LongTermDebt", "DebtLongtermAndShorttermCombinedAmount"],
        "ifrs-full": ["Borrowings"],
      },
    },
    {
      key: "operatingCashFlow",
      label: "Operating cash flow",
      statement: "cashFlowStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: true,
      concepts: {
        "us-gaap": [
          "NetCashProvidedByUsedInOperatingActivities",
          "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        ],
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
        "us-gaap": [
          "PaymentsToAcquirePropertyPlantAndEquipment",
          "PaymentsToAcquireProductiveAssets",
        ],
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
      key: "continuingDilutedEps",
      label: "Diluted EPS from continuing operations",
      statement: "perShare",
      kind: "duration",
      unitKind: "per-share",
      deriveTtm: true,
      concepts: {
        "us-gaap": ["IncomeLossFromContinuingOperationsPerDilutedShare"],
        "ifrs-full": ["DilutedEarningsLossPerShareFromContinuingOperations"],
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
