import { isRecord } from "../../guards";
import type { SecFilingForm } from "../evidence-request-tools";

export type FinancialStatementTaxonomy = "us-gaap" | "ifrs-full";

export const CANONICAL_SEC_FORMS = [
  "10-K",
  "10-Q",
  "20-F",
  "40-F",
  "6-K",
] as const satisfies readonly SecFilingForm[];

export type CanonicalSecForm = (typeof CANONICAL_SEC_FORMS)[number];

const SUPPORTED_SEC_FORMS = [
  ...CANONICAL_SEC_FORMS,
  ...CANONICAL_SEC_FORMS.map((form) => `${form}/A` as const),
] as const;

export type SupportedSecForm = (typeof SUPPORTED_SEC_FORMS)[number];

// SEC forms that represent annual reports.
const ANNUAL_REPORT_FORMS = ["10-K", "20-F", "40-F"] as const;

export type AnnualReportForm = (typeof ANNUAL_REPORT_FORMS)[number];

export const FUNDAMENTAL_HISTORY_POINT_FORMS = [...ANNUAL_REPORT_FORMS, "TTM"] as const;

export const ANNUAL_REPORT_FORMS_WITH_AMENDMENTS: readonly (
  | AnnualReportForm
  | `${AnnualReportForm}/A`
)[] = ANNUAL_REPORT_FORMS.flatMap((form) => [form, `${form}/A` as const]);

export function isAnnualReportForm(form: CanonicalSecForm): form is AnnualReportForm {
  return ANNUAL_REPORT_FORMS.some((annualForm) => annualForm === form);
}

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

export interface FinancialStatementEquityStack {
  readonly totalAssets: readonly FinancialStatementFact[];
  readonly totalLiabilities: readonly FinancialStatementFact[];
  readonly stockholdersEquity: readonly FinancialStatementFact[];
  readonly minorityInterest: readonly FinancialStatementFact[];
  readonly stockholdersEquityIncludingNoncontrollingInterest: readonly FinancialStatementFact[];
  readonly temporaryEquity: readonly FinancialStatementFact[];
}

export interface FinancialStatementNote {
  readonly code:
    | "cutoff-exclusion"
    | "duplicate-superseded"
    | "mixed-periods"
    | "mixed-currencies"
    | "mixed-accessions"
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
  readonly equityStack?: FinancialStatementEquityStack;
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
}

const FINANCIAL_STATEMENT_SERIES_KEYS: readonly FinancialStatementSeriesKey[] = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "cash",
  "currentAssets",
  "currentLiabilities",
  "totalAssets",
  "totalLiabilities",
  "stockholdersEquity",
  "debt",
  "operatingCashFlow",
  "capitalExpenditure",
  "dividendsPaid",
  "shareRepurchases",
  "dilutedEps",
  "dilutedShares",
];

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

function stringArrayField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const field = value[key];
  return Array.isArray(field) && field.every((item) => typeof item === "string")
    ? field
    : undefined;
}

function hasFinancialStatementFactShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    numberField(value, "value") !== undefined &&
    stringField(value, "periodKey") !== undefined &&
    (value.periodType === "annual" || value.periodType === "interim") &&
    // `.some` accepts the unknown left operand that `.includes` rejects in strict TypeScript.
    SUPPORTED_SEC_FORMS.some((form) => value.form === form) &&
    CANONICAL_SEC_FORMS.some((form) => value.canonicalForm === form) &&
    typeof value.amendment === "boolean" &&
    (value.accessionNumber === null || typeof value.accessionNumber === "string") &&
    stringField(value, "filedAt") !== undefined &&
    (value.periodStart === undefined || typeof value.periodStart === "string") &&
    stringField(value, "periodEnd") !== undefined &&
    numberField(value, "fiscalYear") !== undefined &&
    stringField(value, "fiscalPeriod") !== undefined &&
    (value.taxonomy === "us-gaap" || value.taxonomy === "ifrs-full") &&
    stringField(value, "concept") !== undefined &&
    (value.currency === null || typeof value.currency === "string") &&
    stringField(value, "unit") !== undefined &&
    numberField(value, "unitScale") !== undefined &&
    value.extractionMethod === "sec-companyfacts" &&
    stringArrayField(value, "sourceIds") !== undefined
  );
}

function hasFinancialStatementTtmShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    numberField(value, "value") !== undefined &&
    stringField(value, "periodStart") !== undefined &&
    stringField(value, "periodEnd") !== undefined &&
    stringField(value, "currency") !== undefined &&
    stringField(value, "unit") !== undefined &&
    numberField(value, "unitScale") !== undefined &&
    value.extractionMethod === "derived-sec-companyfacts" &&
    value.formula === "FY + latest-YTD - prior-YTD" &&
    stringArrayField(value, "sourceIds") !== undefined &&
    isRecord(value.components) &&
    hasFinancialStatementFactShape(value.components.fiscalYear) &&
    hasFinancialStatementFactShape(value.components.latestYearToDate) &&
    hasFinancialStatementFactShape(value.components.priorYearToDate)
  );
}

function hasFinancialStatementSeriesShape(
  value: unknown,
  key: FinancialStatementSeriesKey,
): boolean {
  return (
    isRecord(value) &&
    value.key === key &&
    stringField(value, "label") !== undefined &&
    (value.statement === "incomeStatement" ||
      value.statement === "balanceSheet" ||
      value.statement === "cashFlowStatement" ||
      value.statement === "perShare") &&
    Array.isArray(value.annual) &&
    value.annual.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.interim) &&
    value.interim.every(hasFinancialStatementFactShape) &&
    (value.ttm === undefined || hasFinancialStatementTtmShape(value.ttm))
  );
}

function hasFinancialStatementEquityStackShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.totalAssets) &&
    value.totalAssets.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.totalLiabilities) &&
    value.totalLiabilities.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.stockholdersEquity) &&
    value.stockholdersEquity.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.minorityInterest) &&
    value.minorityInterest.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.stockholdersEquityIncludingNoncontrollingInterest) &&
    value.stockholdersEquityIncludingNoncontrollingInterest.every(hasFinancialStatementFactShape) &&
    Array.isArray(value.temporaryEquity) &&
    value.temporaryEquity.every(hasFinancialStatementFactShape)
  );
}

function financialStatementSeriesRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const series of Object.values(value)) {
    if (!isRecord(series) || typeof series.key !== "string") {
      return undefined;
    }
    record[series.key] = series;
  }
  return record;
}

export function readFinancialStatementsArtifact(
  value: unknown,
): FinancialStatementsArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    stringField(value, "generatedAt") === undefined ||
    stringField(value, "analysisAsOf") === undefined ||
    stringField(value, "symbol") === undefined ||
    stringField(value, "sourceId") === undefined ||
    (value.sourceUrl !== undefined && typeof value.sourceUrl !== "string") ||
    (value.taxonomy !== undefined &&
      value.taxonomy !== "us-gaap" &&
      value.taxonomy !== "ifrs-full") ||
    (value.reportingCurrency !== undefined && typeof value.reportingCurrency !== "string") ||
    (value.interimCadence !== "quarterly" &&
      value.interimCadence !== "semiannual" &&
      value.interimCadence !== "irregular" &&
      value.interimCadence !== "annual-only" &&
      value.interimCadence !== "unknown") ||
    value.extractionMethod !== "sec-companyfacts" ||
    (value.equityStack !== undefined &&
      !hasFinancialStatementEquityStackShape(value.equityStack)) ||
    !isRecord(value.statements) ||
    !Array.isArray(value.validationNotes) ||
    !Array.isArray(value.omissionNotes) ||
    !Array.isArray(value.structuredFinancialGaps)
  ) {
    return undefined;
  }

  const income = financialStatementSeriesRecord(value.statements.incomeStatement);
  const balance = financialStatementSeriesRecord(value.statements.balanceSheet);
  const cashFlow = financialStatementSeriesRecord(value.statements.cashFlowStatement);
  const perShare = financialStatementSeriesRecord(value.statements.perShare);
  if (
    income === undefined ||
    balance === undefined ||
    cashFlow === undefined ||
    perShare === undefined
  ) {
    return undefined;
  }
  const allSeries = { ...income, ...balance, ...cashFlow, ...perShare };
  if (
    !FINANCIAL_STATEMENT_SERIES_KEYS.every((key) =>
      hasFinancialStatementSeriesShape(allSeries[key], key),
    )
  ) {
    return undefined;
  }
  return value as unknown as FinancialStatementsArtifact;
}
