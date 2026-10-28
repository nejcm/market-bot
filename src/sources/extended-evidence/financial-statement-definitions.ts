import {
  GROSS_PRINCIPAL_DEBT_CONCEPT,
  type FinancialStatementName,
  type FinancialStatementSeriesKey,
  type FinancialStatementTaxonomy,
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

export const DEPRECIATION_AND_AMORTIZATION_COMPONENTS: readonly (readonly string[])[] = [
  ["Depreciation", "DepreciationNonproduction"],
  ["AmortizationOfIntangibleAssets"],
];

// AdjustmentForAmortization can be contract-cost amortization (DDOG): it publishes only within tolerance of same-filing intangible amortization.
export const CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES = [
  "OtherDepreciationAndAmortization",
  "AdjustmentForAmortization",
] as const;

export const DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE = 0.01;
export const MIN_ANNUAL_DURATION_MONTHS = 10;
export const MAX_ANNUAL_DURATION_MONTHS = 14;

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
  // Checked against tagged legs, never used alone: one convertible tag is not total borrowings.
  readonly legsOnlyUmbrellas?: readonly string[];
  // A total's balance-sheet legs; a total that differs from them is another basis, e.g. principal (VSAT).
  readonly totalLegs?: Readonly<Record<string, readonly [string, string]>>;
  // Note-level details a used noncurrent line or total holds; never summed.
  readonly constituents?: readonly string[];
  readonly ambiguousLongTermDebt?: {
    readonly concept: string;
    readonly combinedTotal: string;
    readonly current: string;
    readonly currentTotal: string;
    // Pre-ASC 842 lease line a DebtCurrent above maturities may hold; no finance-lease leg deducts it (LRCX FY2018).
    readonly capitalLeaseCurrent: string;
    readonly shortTerm: readonly string[];
    readonly commercialPaper: string;
    // Same-filing noncurrent liabilities that, beside LongTermDebt, foot to the balance sheet (ADBE, NOW).
    readonly noncurrentIdentity: {
      readonly noncurrentTotal: string;
      readonly total: string;
      readonly currentTotal: string;
      readonly others: readonly string[];
      readonly currentOthers: readonly string[];
    };
  };
}

// Inner arrays are alternatives for one line item; separate entries are disjoint and add.
export const DEBT_CONCEPTS: Readonly<Record<FinancialStatementTaxonomy, DebtTaxonomyConcepts>> = {
  "us-gaap": {
    totals: [
      "DebtLongtermAndShorttermCombinedAmount",
      "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities",
      "DebtAndCapitalLeaseObligations",
      "LongTermDebt",
    ],
    current: {
      generic: [
        "DebtCurrent",
        "LongTermDebtCurrent",
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
      generic: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebt"],
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
    umbrellas: {
      LineOfCredit: ["LongTermLineOfCredit", "LinesOfCreditCurrent"],
      ConvertibleNotesPayable: [
        "ConvertibleLongTermNotesPayable",
        "ConvertibleNotesPayableCurrent",
      ],
    },
    legsOnlyUmbrellas: ["ConvertibleNotesPayable"],
    totalLegs: {
      LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [
        "LongTermDebtAndCapitalLeaseObligationsCurrent",
        "LongTermDebtAndCapitalLeaseObligations",
      ],
    },
    constituents: ["OtherLongTermDebt"],
    // Filers tag LongTermDebt as either all long-term debt or only its noncurrent balance-sheet line.
    ambiguousLongTermDebt: {
      concept: "LongTermDebt",
      combinedTotal: "DebtLongtermAndShorttermCombinedAmount",
      current: "LongTermDebtCurrent",
      currentTotal: "DebtCurrent",
      capitalLeaseCurrent: "CapitalLeaseObligationsCurrent",
      shortTerm: ["ShortTermBorrowings", "ShortTermDebt", "CommercialPaper"],
      commercialPaper: "CommercialPaper",
      noncurrentIdentity: {
        noncurrentTotal: "LiabilitiesNoncurrent",
        total: "Liabilities",
        currentTotal: "LiabilitiesCurrent",
        others: [
          "AccruedIncomeTaxesNoncurrent",
          "ContractWithCustomerLiabilityNoncurrent",
          "DeferredRevenueNoncurrent",
          "DeferredIncomeTaxLiabilitiesNet",
          "DeferredTaxLiabilitiesNoncurrent",
          "OperatingLeaseLiabilityNoncurrent",
          "FinanceLeaseLiabilityNoncurrent",
          "OtherLiabilitiesNoncurrent",
          "OtherSundryLiabilitiesNoncurrent",
          "PensionAndOtherPostretirementDefinedBenefitPlansLiabilitiesNoncurrent",
        ],
        // Face-statement lines only: footnote details of accrued liabilities would double count.
        currentOthers: [
          "AccountsPayableCurrent",
          "AccruedLiabilitiesCurrent",
          "DerivativeLiabilitiesCurrent",
          "OperatingLeaseLiabilityCurrent",
          "FinanceLeaseLiabilityCurrent",
          "OtherLiabilitiesCurrent",
        ],
      },
    },
    // Cash-flow and residual-liability concepts also end in "Debt" but are never a borrowing balance.
    unrecognizedBorrowing:
      /^(?!ProceedsFrom|RepaymentsOf|PaymentsOf|PaymentsFor|LiabilitiesOtherThan).*(?:Debt|Borrowings|Notes|NotesPayable|LoansPayable|LinesOfCredit|LineOfCredit|CommercialPaper|Debt\w*LeaseObligations)(?:Current|Noncurrent)?$/u,
  },
  "ifrs-full": {
    totals: ["Borrowings"],
    current: { generic: ["CurrentBorrowings"], instruments: [] },
    noncurrent: { generic: ["NoncurrentBorrowings"], instruments: [] },
  },
};

export const US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT =
  "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths";

export const US_GAAP_DEBT_DUE_WITHIN_YEAR_CONCEPTS: readonly string[] = [
  ...DEBT_CONCEPTS["us-gaap"].current.generic,
  ...DEBT_CONCEPTS["us-gaap"].current.instruments.flat(),
  US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT,
];

// Ratio inputs follow the core statements: they never displace a capped period or sway taxonomy and currency.
export const CAP_FOLLOWER_SERIES: ReadonlySet<FinancialStatementSeriesKey> = new Set([
  "interestExpense",
  "incomeTaxExpense",
  "pretaxIncome",
  "depreciationAndAmortization",
]);

// Filed debt evidence includes concepts that are ineligible for value selection.
export function isDebtPresenceConcept(
  taxonomy: FinancialStatementTaxonomy,
  concept: string,
): boolean {
  const debt = DEBT_CONCEPTS[taxonomy];
  return (
    concept === GROSS_PRINCIPAL_DEBT_CONCEPT ||
    (taxonomy === "ifrs-full" &&
      /(?:Borrowings|BondsIssued|NotesIssued|DebtSecuritiesIssued|NotesPayable|LoansPayable|BankOverdrafts|Debentures|FinanceLeaseLiabilities)(?:Current|Noncurrent)?$/u.test(
        concept,
      )) ||
    debt.unrecognizedBorrowing?.test(concept) === true ||
    [
      ...debt.totals,
      ...debt.current.generic,
      ...debt.current.instruments.flat(),
      ...debt.noncurrent.generic,
      ...debt.noncurrent.instruments.flat(),
      ...(debt.financeLeases === undefined
        ? []
        : [debt.financeLeases.total, ...debt.financeLeases.split]),
      ...Object.entries(debt.umbrellas ?? {}).flat(2),
    ].includes(concept)
  );
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

const CONTINUING_OPERATIONS_SCOPE = "continuing operations";

export const TOTAL_OPERATIONS_SCOPE = "total operations";

// A nonzero value marks a period whose total-operations flows include discontinued operations.
export const DISCONTINUED_OPERATIONS_CONCEPTS = [
  "CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations",
  "IncomeLossFromDiscontinuedOperationsNetOfTax",
  "IncomeLossFromDiscontinuedOperationsNetOfTaxAttributableToReportingEntity",
  "IncomeLossFromDiscontinuedOperationsNetOfTaxIncludingPortionAttributableToNoncontrollingInterest",
] as const;

export const TOTAL_NONCONTROLLING_INCOME_CONCEPTS: ReadonlySet<string> = new Set([
  "NetIncomeLossAttributableToNoncontrollingInterest",
]);
export const NONCONTROLLING_INCOME_CONCEPTS = [
  ...TOTAL_NONCONTROLLING_INCOME_CONCEPTS,
  "NetIncomeLossAttributableToNonredeemableNoncontrollingInterest",
  "NetIncomeLossAttributableToRedeemableNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsAttributableToNoncontrollingEntity",
  "MinorityInterestInNetIncomeLossLimitedPartnerships",
  "ComprehensiveIncomeNetOfTaxAttributableToNoncontrollingInterest",
];

// Revenue is continuing and consolidated (ASC 205-20, ASC 810); parent-attributed income partners it only without NCI.
export function netMarginNumerator<T>(period: {
  readonly consolidatedContinuing: T | undefined;
  readonly continuing: T | undefined;
  readonly consolidated: T | undefined;
  readonly total: T;
  readonly discontinued: boolean;
  readonly noncontrolling: boolean;
}): T | undefined {
  if (period.consolidatedContinuing !== undefined) {
    return period.consolidatedContinuing;
  }
  if (period.continuing !== undefined) {
    return period.noncontrolling ? undefined : period.continuing;
  }
  if (period.discontinued) {
    return undefined;
  }
  return period.consolidated ?? (period.noncontrolling ? undefined : period.total);
}

export const CAPEX_SCOPE_CAVEAT =
  "capital expenditure carries no operations-scope tag and is used as reported";

// SEC payments-for-PP&E concepts are positive outflows; a negative filing is withheld, not sign-flipped.
export const NEGATIVE_CAPEX_REASON =
  "capital expenditure filed as a negative amount; outflow sign is ambiguous";

// A derived capex total is withheld when it or any filed component is negative.
export function hasNegativeCapex(values: readonly (number | string)[]): boolean {
  return values.some((value) => typeof value === "number" && value < 0);
}

const CONCEPT_SCOPES: Readonly<Record<string, string>> = {
  "NetCashProvidedByUsedInOperatingActivities-CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations":
    CONTINUING_OPERATIONS_SCOPE,
  IncomeLossFromContinuingOperations: "continuing operations, attributable to parent",
  IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest:
    "continuing operations, including NCI",
  ProfitLossFromContinuingOperationsAttributableToOwnersOfParent:
    "continuing operations, attributable to parent",
  ProfitLossFromContinuingOperations: "continuing operations, including NCI",
  IncomeLossFromContinuingOperationsPerDilutedShare: CONTINUING_OPERATIONS_SCOPE,
  DilutedEarningsLossPerShareFromContinuingOperations: CONTINUING_OPERATIONS_SCOPE,
  IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments:
    "continuing operations, before equity-method income",
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
      key: "consolidatedNetIncome",
      label: "Net income including noncontrolling interest",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: true,
      concepts: { "us-gaap": ["ProfitLoss"], "ifrs-full": [] },
    },
    {
      key: "consolidatedContinuingIncome",
      label: "Income from continuing operations including noncontrolling interest",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: true,
      concepts: {
        "us-gaap": [
          "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest",
        ],
        "ifrs-full": ["ProfitLossFromContinuingOperations"],
      },
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
      key: "interestExpense",
      label: "Interest expense",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: false,
      concepts: {
        "us-gaap": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
        "ifrs-full": ["InterestExpense"],
      },
    },
    {
      key: "incomeTaxExpense",
      label: "Income tax expense",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: false,
      concepts: {
        "us-gaap": ["IncomeTaxExpenseBenefit"],
        "ifrs-full": ["IncomeTaxExpenseContinuingOperations"],
      },
    },
    {
      key: "pretaxIncome",
      label: "Pretax income from continuing operations",
      statement: "incomeStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: false,
      concepts: {
        "us-gaap": [
          "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
          "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
        ],
        "ifrs-full": ["ProfitLossBeforeTax"],
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
      key: "depreciationAndAmortization",
      label: "Depreciation and amortization",
      statement: "cashFlowStatement",
      kind: "duration",
      unitKind: "monetary",
      deriveTtm: false,
      concepts: {
        "us-gaap": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization"],
        "ifrs-full": ["DepreciationAndAmortisationExpense"],
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
        "us-gaap": [
          "PaymentsOfDividends",
          "PaymentsOfDividendsCommonStock",
          "PaymentsOfOrdinaryDividends",
          "PaymentsForDividends",
          "DividendsPaid",
        ],
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
        "us-gaap": ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
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
    {
      key: "dividendsPerShare",
      label: "Dividends per share",
      statement: "perShare",
      kind: "duration",
      unitKind: "per-share",
      deriveTtm: false,
      concepts: {
        "us-gaap": ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"],
        "ifrs-full": ["DividendsRecognisedAsDistributionsToOwnersPerShare"],
      },
    },
  ];
