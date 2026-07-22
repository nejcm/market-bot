export type FinancialStatementTaxonomy = "us-gaap" | "ifrs-full";

export type CanonicalSecForm = "10-K" | "10-Q" | "20-F" | "6-K";

export type SupportedSecForm = CanonicalSecForm | `${CanonicalSecForm}/A`;

export type FinancialStatementExtractionMethod = "sec-companyfacts";

// SEC companyfacts `val` values are already expressed in the base unit named by the units map.
export const SEC_COMPANYFACTS_UNIT_SCALE = 1;

export type InterimCadence = "quarterly" | "semiannual" | "irregular" | "annual-only" | "unknown";

export type FinancialStatementName =
  | "incomeStatement"
  | "balanceSheet"
  | "cashFlowStatement"
  | "perShare";

export type FinancialStatementSeriesKey =
  | "revenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "cash"
  | "currentAssets"
  | "currentLiabilities"
  | "totalAssets"
  | "totalLiabilities"
  | "stockholdersEquity"
  | "debt"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "dividendsPaid"
  | "shareRepurchases"
  | "dilutedEps"
  | "dilutedShares";

export interface FinancialStatementFact {
  readonly value: number;
  readonly periodKey: string;
  readonly periodType: "annual" | "interim";
  readonly form: SupportedSecForm;
  readonly canonicalForm: CanonicalSecForm;
  readonly amendment: boolean;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly fiscalYear: number;
  readonly fiscalPeriod: string;
  readonly taxonomy: FinancialStatementTaxonomy;
  readonly concept: string;
  readonly currency: string | null;
  readonly unit: string;
  readonly unitScale: number;
  readonly extractionMethod: FinancialStatementExtractionMethod;
  readonly sourceIds: readonly string[];
}

export interface FinancialStatementTtm {
  readonly value: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly unit: string;
  readonly unitScale: number;
  readonly extractionMethod: "derived-sec-companyfacts";
  readonly formula: "FY + latest-YTD - prior-YTD";
  readonly sourceIds: readonly string[];
  readonly components: {
    readonly fiscalYear: FinancialStatementFact;
    readonly latestYearToDate: FinancialStatementFact;
    readonly priorYearToDate: FinancialStatementFact;
  };
}

export interface FinancialStatementSeries {
  readonly key: FinancialStatementSeriesKey;
  readonly label: string;
  readonly statement: FinancialStatementName;
  readonly annual: readonly FinancialStatementFact[];
  readonly interim: readonly FinancialStatementFact[];
  readonly ttm?: FinancialStatementTtm;
}

export interface FinancialStatementNote {
  readonly code:
    | "cutoff-exclusion"
    | "duplicate-superseded"
    | "mixed-periods"
    | "mixed-currencies"
    | "mixed-taxonomies"
    | "incomplete-metadata"
    | "history-cap"
    | "incomplete-statement"
    | "unreconciled-ttm";
  readonly message: string;
  readonly seriesKey?: FinancialStatementSeriesKey;
  readonly periodKey?: string;
}

export interface StructuredFinancialGap {
  readonly code: "no-standard-taxonomy" | "no-reporting-currency" | "untagged-6-k";
  readonly message: string;
  readonly forms: readonly SupportedSecForm[];
  readonly sourceIds: readonly string[];
}

export type ShadowParityConsumer = "fundamental-history" | "financial-lens";

export interface FinancialStatementParityComparison {
  readonly consumer: ShadowParityConsumer;
  readonly field: string;
  readonly status: "matched" | "explained" | "unexplained";
  readonly artifactValue?: number | string;
  readonly legacyValue?: number | string;
  readonly periodEnd?: string;
  readonly reasonCode?:
    | "legacy-form-unsupported"
    | "canonical-reporting-currency-isolation"
    | "canonical-restatement-precedence"
    | "canonical-history-cap"
    | "canonical-period-selection";
  readonly explanation?: string;
}

export interface FinancialStatementShadowParity {
  readonly version: 1;
  readonly status: "matched" | "explained" | "not-applicable" | "unexplained";
  readonly matchedCount: number;
  readonly explainedCount: number;
  readonly unexplainedCount: number;
  readonly comparisons: readonly FinancialStatementParityComparison[];
}

export interface FinancialStatementsArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly analysisAsOf: string;
  readonly symbol: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
  readonly taxonomy?: FinancialStatementTaxonomy;
  readonly reportingCurrency?: string;
  readonly interimCadence: InterimCadence;
  readonly extractionMethod: FinancialStatementExtractionMethod;
  readonly statements: {
    readonly incomeStatement: Readonly<
      Record<"revenue" | "grossProfit" | "operatingIncome" | "netIncome", FinancialStatementSeries>
    >;
    readonly balanceSheet: Readonly<
      Record<
        | "cash"
        | "currentAssets"
        | "currentLiabilities"
        | "totalAssets"
        | "totalLiabilities"
        | "stockholdersEquity"
        | "debt",
        FinancialStatementSeries
      >
    >;
    readonly cashFlowStatement: Readonly<
      Record<
        "operatingCashFlow" | "capitalExpenditure" | "dividendsPaid" | "shareRepurchases",
        FinancialStatementSeries
      >
    >;
    readonly perShare: Readonly<Record<"dilutedEps" | "dilutedShares", FinancialStatementSeries>>;
  };
  readonly validationNotes: readonly FinancialStatementNote[];
  readonly omissionNotes: readonly FinancialStatementNote[];
  readonly structuredFinancialGaps: readonly StructuredFinancialGap[];
  readonly shadowParity: FinancialStatementShadowParity;
}
