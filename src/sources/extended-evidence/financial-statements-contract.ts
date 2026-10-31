import { isRecord, readString } from "../../guards";
import type { SecFilingForm } from "../evidence-request-tools";
import {
  type ArtifactObservationDrop,
  readArtifactObservations,
  readArtifactReadDiagnostics,
  type ReadArtifact,
  withArtifactReadDiagnostics,
} from "./utils";

export const ALIGNMENT_MIN_DAYS = 350;
export const ALIGNMENT_MAX_DAYS = 380;

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

export function isDomesticPeriodicCanonicalForm(form: CanonicalSecForm): form is "10-K" | "10-Q" {
  return form === "10-K" || form === "10-Q";
}

export function canonicalizeSecForm(value: string):
  | {
      readonly form: SupportedSecForm;
      readonly canonicalForm: CanonicalSecForm;
      readonly amendment: boolean;
    }
  | undefined {
  const amendment = value.endsWith("/A");
  const canonical = amendment ? value.slice(0, -2) : value;
  const canonicalForm = CANONICAL_SEC_FORMS.find((form) => form === canonical);
  if (canonicalForm === undefined) {
    return undefined;
  }
  return { form: value as SupportedSecForm, canonicalForm, amendment };
}

export function readSecFactPeriodMetadata(
  value: Record<string, unknown>,
): { readonly filed: string; readonly end: string; readonly fp: string } | undefined {
  const filed = readString(value, "filed");
  const end = readString(value, "end");
  const fp = readString(value, "fp");
  if (filed === undefined || end === undefined || fp === undefined) {
    return undefined;
  }
  return { filed, end, fp };
}

type FinancialStatementExtractionMethod = "sec-companyfacts" | "derived-sec-companyfacts";

export const COMPOSITE_STATEMENT_FACT_FORMULA = "sum";

export const GROSS_PRINCIPAL_DEBT_CONCEPT = "DebtInstrumentCarryingAmount";

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
  | "consolidatedNetIncome"
  | "consolidatedContinuingIncome"
  | "continuingIncome"
  | "interestExpense"
  | "incomeTaxExpense"
  | "pretaxIncome"
  | "cash"
  | "currentAssets"
  | "currentLiabilities"
  | "totalAssets"
  | "totalLiabilities"
  | "stockholdersEquity"
  | "debt"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "depreciationAndAmortization"
  | "dividendsPaid"
  | "shareRepurchases"
  | "dilutedEps"
  | "continuingDilutedEps"
  | "dilutedShares"
  | "dividendsPerShare";

export interface OriginalFiling {
  readonly value: number;
  readonly filedAt: string;
}

export interface FinancialStatementFact {
  readonly value: number;
  readonly periodKey: string;
  readonly periodType: "annual" | "interim";
  readonly form: SupportedSecForm;
  readonly canonicalForm: CanonicalSecForm;
  readonly amendment: boolean;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly firstPublicAt: string;
  readonly restatedFrom?: OriginalFiling;
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
  // Debt only: classified carrying lines, or a LongTermDebt total reconciled to them.
  readonly lineScope?: true;
  // Debt only: finance-lease tags a same-filing face presents beside the debt lines.
  readonly faceLeases?: readonly string[];
  readonly composite?: {
    readonly formula: typeof COMPOSITE_STATEMENT_FACT_FORMULA;
    readonly components: readonly {
      readonly concept: string;
      readonly value: number;
      readonly accessionNumber: string | null;
      readonly filedAt: string;
      readonly periodEnd: string;
      readonly sourceIds: readonly string[];
    }[];
  };
}

export function derivedFactDisclosure(
  key: FinancialStatementSeriesKey,
  fact: Pick<FinancialStatementFact, "composite" | "concept">,
): string | undefined {
  if (fact.composite === undefined) {
    return undefined;
  }
  if (key === "grossProfit") {
    return `gross profit derived as ${fact.concept.replace("-", " − ")}; tagged cost of revenue may exclude amortization or D&A`;
  }
  if (key === "netIncome") {
    return `net income uses consolidated ${fact.concept} where NetIncomeLoss is untagged and tagged noncontrolling-interest income is zero or absent`;
  }
  return undefined;
}

interface FinancialStatementTtmBase {
  readonly value: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly unit: string;
  readonly unitScale: number;
  readonly extractionMethod: "derived-sec-companyfacts";
  readonly sourceIds: readonly string[];
}

// "FY": no interim ends after the latest fiscal year, so the trailing twelve months are that year.
export type FinancialStatementTtm = FinancialStatementTtmBase &
  (
    | {
        readonly formula: "FY + latest-YTD - prior-YTD";
        readonly components: {
          readonly fiscalYear: FinancialStatementFact;
          readonly latestYearToDate: FinancialStatementFact;
          readonly priorYearToDate: FinancialStatementFact;
        };
      }
    | {
        readonly formula: "FY";
        readonly components: { readonly fiscalYear: FinancialStatementFact };
      }
  );

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

export interface FinancialStatementEnterpriseValueBridge {
  readonly shortTermInvestments: readonly FinancialStatementFact[];
  readonly cashAndShortTermInvestments: readonly FinancialStatementFact[];
  readonly currentEquitySecurities: readonly FinancialStatementFact[];
  readonly noncontrollingInterest: readonly FinancialStatementFact[];
  readonly preferredStock: readonly FinancialStatementFact[];
  readonly temporaryEquity: readonly FinancialStatementFact[];
  readonly assets: readonly FinancialStatementFact[];
  readonly liabilities: readonly FinancialStatementFact[];
  readonly stockholdersEquity: readonly FinancialStatementFact[];
  readonly stockholdersEquityIncludingNoncontrollingInterest: readonly FinancialStatementFact[];
  readonly assetsCurrent: readonly FinancialStatementFact[];
  readonly receivablesCurrent: readonly FinancialStatementFact[];
  readonly inventory: readonly FinancialStatementFact[];
  readonly otherAssetsCurrent: readonly FinancialStatementFact[];
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
    | "unreconciled-ttm"
    | "untagged-balance-sheet-series"
    | "incomplete-composite-series"
    | "unchecked-extension-capex"
    | "unreconciled-component"
    | "unchecked-component-sum"
    | "stale-instant-series"
    | "stale-concept-history"
    | "withheld-derivation"
    | "mixed-share-basis"
    | "earlier-share-basis"
    | "declaration-span"
    | "debt-held-for-sale";
  readonly message: string;
  readonly seriesKey?: FinancialStatementSeriesKey;
  readonly periodKey?: string;
  readonly publicAt?: string;
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
  readonly extractionMethod: "sec-companyfacts";
  readonly equityStack?: FinancialStatementEquityStack;
  // Instant facts per balance-sheet date for the EV bridge; us-gaap only.
  readonly enterpriseValueBridge?: FinancialStatementEnterpriseValueBridge;
  // Filer-tagged annual EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate (pure); us-gaap only.
  readonly statutoryTaxRate?: readonly FinancialStatementFact[];
  readonly statements: {
    readonly incomeStatement: Readonly<
      Record<
        | "revenue"
        | "grossProfit"
        | "operatingIncome"
        | "netIncome"
        | "consolidatedNetIncome"
        | "consolidatedContinuingIncome"
        | "continuingIncome"
        | "interestExpense"
        | "incomeTaxExpense"
        | "pretaxIncome",
        FinancialStatementSeries
      >
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
        | "operatingCashFlow"
        | "capitalExpenditure"
        | "depreciationAndAmortization"
        | "dividendsPaid"
        | "shareRepurchases",
        FinancialStatementSeries
      >
    >;
    readonly perShare: Readonly<
      Record<
        "dilutedEps" | "continuingDilutedEps" | "dilutedShares" | "dividendsPerShare",
        FinancialStatementSeries
      >
    >;
  };
  // Any positive filed dividend per share or non-zero dividends paid; absent on pre-flag artifacts.
  readonly dividendPaymentFiled?: boolean;
  // Series with no observable raw fact under any alias in any taxonomy; absent on pre-flag artifacts.
  readonly unfiledSeries?: readonly FinancialStatementSeriesKey[];
  readonly validationNotes: readonly FinancialStatementNote[];
  readonly omissionNotes: readonly FinancialStatementNote[];
  readonly structuredFinancialGaps: readonly StructuredFinancialGap[];
}

const READABLE_FINANCIAL_STATEMENT_VERSIONS = new Set<unknown>([1]);

const FINANCIAL_STATEMENT_SERIES_KEYS: readonly FinancialStatementSeriesKey[] = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "consolidatedNetIncome",
  "consolidatedContinuingIncome",
  "continuingIncome",
  "interestExpense",
  "incomeTaxExpense",
  "pretaxIncome",
  "cash",
  "currentAssets",
  "currentLiabilities",
  "totalAssets",
  "totalLiabilities",
  "stockholdersEquity",
  "debt",
  "operatingCashFlow",
  "capitalExpenditure",
  "depreciationAndAmortization",
  "dividendsPaid",
  "shareRepurchases",
  "dilutedEps",
  "continuingDilutedEps",
  "dilutedShares",
  "dividendsPerShare",
];

// Artifacts written before a later series was added read it as empty, not as invalid.
const LATER_SERIES: Readonly<
  Partial<
    Record<FinancialStatementSeriesKey, Pick<FinancialStatementSeries, "label" | "statement">>
  >
> = {
  consolidatedNetIncome: {
    label: "Net income including noncontrolling interest",
    statement: "incomeStatement",
  },
  consolidatedContinuingIncome: {
    label: "Income from continuing operations including noncontrolling interest",
    statement: "incomeStatement",
  },
  continuingIncome: { label: "Income from continuing operations", statement: "incomeStatement" },
  continuingDilutedEps: {
    label: "Diluted EPS from continuing operations",
    statement: "perShare",
  },
  dividendsPerShare: { label: "Dividends per share", statement: "perShare" },
  interestExpense: { label: "Interest expense", statement: "incomeStatement" },
  incomeTaxExpense: { label: "Income tax expense", statement: "incomeStatement" },
  pretaxIncome: {
    label: "Pretax income from continuing operations",
    statement: "incomeStatement",
  },
  depreciationAndAmortization: {
    label: "Depreciation and amortization",
    statement: "cashFlowStatement",
  },
};

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

function hasCompositeComponentShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    stringField(value, "concept") !== undefined &&
    numberField(value, "value") !== undefined &&
    (value.accessionNumber === null || typeof value.accessionNumber === "string") &&
    stringField(value, "filedAt") !== undefined &&
    stringField(value, "periodEnd") !== undefined &&
    stringArrayField(value, "sourceIds") !== undefined
  );
}

function hasCompositeFactShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.formula === COMPOSITE_STATEMENT_FACT_FORMULA &&
    Array.isArray(value.components) &&
    value.components.length > 0 &&
    value.components.every((component) => hasCompositeComponentShape(component))
  );
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
    (value.firstPublicAt === undefined || typeof value.firstPublicAt === "string") &&
    (value.restatedFrom === undefined ||
      (isRecord(value.restatedFrom) &&
        numberField(value.restatedFrom, "value") !== undefined &&
        stringField(value.restatedFrom, "filedAt") !== undefined)) &&
    (value.periodStart === undefined || typeof value.periodStart === "string") &&
    stringField(value, "periodEnd") !== undefined &&
    numberField(value, "fiscalYear") !== undefined &&
    stringField(value, "fiscalPeriod") !== undefined &&
    (value.taxonomy === "us-gaap" || value.taxonomy === "ifrs-full") &&
    stringField(value, "concept") !== undefined &&
    (value.currency === null || typeof value.currency === "string") &&
    stringField(value, "unit") !== undefined &&
    numberField(value, "unitScale") !== undefined &&
    ((value.extractionMethod === "sec-companyfacts" && value.composite === undefined) ||
      (value.extractionMethod === "derived-sec-companyfacts" &&
        hasCompositeFactShape(value.composite))) &&
    (value.lineScope === undefined || value.lineScope === true) &&
    (value.faceLeases === undefined || stringArrayField(value, "faceLeases") !== undefined) &&
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
    stringArrayField(value, "sourceIds") !== undefined &&
    isRecord(value.components) &&
    hasFinancialStatementFactShape(value.components.fiscalYear) &&
    (value.formula === "FY"
      ? Object.keys(value.components).length === 1 &&
        matchesFiscalYear(value, value.components.fiscalYear as Record<string, unknown>)
      : value.formula === "FY + latest-YTD - prior-YTD" &&
        hasFinancialStatementFactShape(value.components.latestYearToDate) &&
        hasFinancialStatementFactShape(value.components.priorYearToDate))
  );
}

function matchesFiscalYear(
  ttm: Record<string, unknown>,
  fiscalYear: Record<string, unknown>,
): boolean {
  const days =
    (Date.parse(String(fiscalYear.periodEnd)) - Date.parse(String(fiscalYear.periodStart))) /
    86_400_000;
  return (
    fiscalYear.periodType === "annual" &&
    days >= ALIGNMENT_MIN_DAYS &&
    days <= ALIGNMENT_MAX_DAYS &&
    (["value", "periodStart", "periodEnd", "currency", "unit"] as const).every(
      (field) => ttm[field] === fiscalYear[field],
    )
  );
}

// Facts written before firstPublicAt keep their selected-filing date; each backfill is reported.
function backfillFirstPublicAt(fact: FinancialStatementFact): FinancialStatementFact {
  return { ...fact, firstPublicAt: fact.firstPublicAt ?? fact.filedAt };
}

function readFinancialStatementFacts(
  values: readonly unknown[],
  reason: string,
): {
  readonly observations: readonly FinancialStatementFact[];
  readonly drops: readonly ArtifactObservationDrop[];
  readonly backfills: readonly ArtifactObservationDrop[];
} {
  const read = readArtifactObservations<FinancialStatementFact>(
    values,
    `${reason}.invalid`,
    (fact) => (hasFinancialStatementFactShape(fact) ? (fact as FinancialStatementFact) : undefined),
  );
  return {
    observations: read.observations.map(backfillFirstPublicAt),
    drops: read.drops,
    backfills: firstPublicAtBackfills(read.observations, reason),
  };
}

function firstPublicAtBackfills(
  facts: readonly FinancialStatementFact[],
  reason: string,
): readonly ArtifactObservationDrop[] {
  const count = facts.filter(
    (fact) => (fact.firstPublicAt as string | undefined) === undefined,
  ).length;
  return count === 0 ? [] : [{ reason: `${reason}.firstPublicAt-backfilled`, count }];
}

function readFinancialStatementSeries(
  value: unknown,
  key: FinancialStatementSeriesKey,
):
  | {
      readonly series: FinancialStatementSeries;
      readonly drops: readonly ArtifactObservationDrop[];
      readonly backfills: readonly ArtifactObservationDrop[];
    }
  | undefined {
  if (
    !isRecord(value) ||
    value.key !== key ||
    stringField(value, "label") === undefined ||
    (value.statement !== "incomeStatement" &&
      value.statement !== "balanceSheet" &&
      value.statement !== "cashFlowStatement" &&
      value.statement !== "perShare") ||
    !Array.isArray(value.annual) ||
    !Array.isArray(value.interim)
  ) {
    return undefined;
  }
  const annual = readFinancialStatementFacts(value.annual, `financialStatements.${key}.annual`);
  const interim = readFinancialStatementFacts(value.interim, `financialStatements.${key}.interim`);
  const ttm =
    value.ttm === undefined
      ? undefined
      : readArtifactObservations<FinancialStatementTtm>(
          [value.ttm],
          `financialStatements.${key}.ttm.invalid`,
          (candidate) =>
            hasFinancialStatementTtmShape(candidate)
              ? (candidate as FinancialStatementTtm)
              : undefined,
        );
  const [readTtm] = ttm?.observations ?? [];
  const { ttm: _ttm, ...rest } = value;
  return {
    series: {
      ...rest,
      key,
      label: value.label as string,
      statement: value.statement,
      annual: annual.observations,
      interim: interim.observations,
      ...(readTtm === undefined
        ? {}
        : {
            ttm: {
              ...readTtm,
              components: Object.fromEntries(
                Object.entries(readTtm.components).map(([name, fact]) => [
                  name,
                  backfillFirstPublicAt(fact),
                ]),
              ) as typeof readTtm.components,
            } as FinancialStatementTtm,
          }),
    },
    drops: [...annual.drops, ...interim.drops, ...(ttm?.drops ?? [])],
    backfills: [
      ...annual.backfills,
      ...interim.backfills,
      ...firstPublicAtBackfills(
        readTtm === undefined ? [] : Object.values(readTtm.components),
        `financialStatements.${key}.ttm`,
      ),
    ],
  };
}

function readFinancialStatementFactGroup<Key extends string>(
  value: unknown,
  keys: readonly Key[],
  path: string,
):
  | {
      readonly group: Readonly<Record<Key, readonly FinancialStatementFact[]>>;
      readonly drops: readonly ArtifactObservationDrop[];
      readonly backfills: readonly ArtifactObservationDrop[];
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const facts: Partial<Record<Key, readonly FinancialStatementFact[]>> = {};
  const drops: ArtifactObservationDrop[] = [];
  const backfills: ArtifactObservationDrop[] = [];
  for (const key of keys) {
    if (!Array.isArray(value[key])) {
      return undefined;
    }
    const read = readFinancialStatementFacts(value[key], `${path}.${key}`);
    facts[key] = read.observations;
    drops.push(...read.drops);
    backfills.push(...read.backfills);
  }
  return {
    group: { ...value, ...facts } as unknown as Readonly<
      Record<Key, readonly FinancialStatementFact[]>
    >,
    drops,
    backfills,
  };
}

const EQUITY_STACK_KEYS = [
  "totalAssets",
  "totalLiabilities",
  "stockholdersEquity",
  "minorityInterest",
  "stockholdersEquityIncludingNoncontrollingInterest",
  "temporaryEquity",
] as const satisfies readonly (keyof FinancialStatementEquityStack)[];

const LATER_BRIDGE_KEYS = [
  "currentEquitySecurities",
  "assetsCurrent",
  "receivablesCurrent",
  "inventory",
  "otherAssetsCurrent",
] as const;

export const ENTERPRISE_VALUE_BRIDGE_FACT_KEYS = [
  "shortTermInvestments",
  "cashAndShortTermInvestments",
  "currentEquitySecurities",
  "noncontrollingInterest",
  "preferredStock",
  "temporaryEquity",
  "assets",
  "liabilities",
  "stockholdersEquity",
  "stockholdersEquityIncludingNoncontrollingInterest",
  "assetsCurrent",
  "receivablesCurrent",
  "inventory",
  "otherAssetsCurrent",
] as const satisfies readonly (keyof FinancialStatementEnterpriseValueBridge)[];

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
): ReadArtifact<FinancialStatementsArtifact> | undefined {
  if (
    !isRecord(value) ||
    !READABLE_FINANCIAL_STATEMENT_VERSIONS.has(value.version) ||
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
    !isRecord(value.statements) ||
    !Array.isArray(value.validationNotes) ||
    !Array.isArray(value.omissionNotes) ||
    (value.dividendPaymentFiled !== undefined && typeof value.dividendPaymentFiled !== "boolean") ||
    (value.unfiledSeries !== undefined &&
      (!Array.isArray(value.unfiledSeries) ||
        !value.unfiledSeries.every((key) =>
          FINANCIAL_STATEMENT_SERIES_KEYS.includes(key as FinancialStatementSeriesKey),
        ))) ||
    !Array.isArray(value.structuredFinancialGaps)
  ) {
    return undefined;
  }

  const previous = readArtifactReadDiagnostics(value);
  const equityStack =
    value.equityStack === undefined
      ? undefined
      : readFinancialStatementFactGroup(
          value.equityStack,
          EQUITY_STACK_KEYS,
          "financialStatements.equityStack",
        );
  // A bridge written before the current-asset keys is omitted; saved EV keeps its own basis, only fresh computation withholds.
  const bridge = value.enterpriseValueBridge;
  const staleBridgeKeys = isRecord(bridge)
    ? LATER_BRIDGE_KEYS.filter((key) => !Array.isArray(bridge[key]))
    : [];
  const enterpriseValueBridge =
    value.enterpriseValueBridge === undefined || staleBridgeKeys.length > 0
      ? undefined
      : readFinancialStatementFactGroup(
          value.enterpriseValueBridge,
          ENTERPRISE_VALUE_BRIDGE_FACT_KEYS,
          "financialStatements.enterpriseValueBridge",
        );
  const statutoryTaxRate = Array.isArray(value.statutoryTaxRate)
    ? readFinancialStatementFacts(value.statutoryTaxRate, "financialStatements.statutoryTaxRate")
    : undefined;
  if (
    previous === undefined ||
    (value.statutoryTaxRate !== undefined && statutoryTaxRate === undefined) ||
    (value.equityStack !== undefined && equityStack === undefined) ||
    (value.enterpriseValueBridge !== undefined &&
      staleBridgeKeys.length === 0 &&
      enterpriseValueBridge === undefined)
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
  const byStatement = {
    incomeStatement: income,
    balanceSheet: balance,
    cashFlowStatement: cashFlow,
    perShare,
  };
  const series: Partial<Record<FinancialStatementSeriesKey, FinancialStatementSeries>> = {};
  const drops: ArtifactObservationDrop[] = [
    ...(equityStack?.drops ?? []),
    ...(enterpriseValueBridge?.drops ?? []),
    ...(statutoryTaxRate?.drops ?? []),
    ...(staleBridgeKeys.length === 0
      ? []
      : [
          {
            reason: `financialStatements.enterpriseValueBridge predates ${staleBridgeKeys.join(", ")}; bridge detail omitted, saved valuation keeps the basis it was published with`,
            count: 1,
          },
        ]),
  ];
  const backfills: ArtifactObservationDrop[] = [
    ...(equityStack?.backfills ?? []),
    ...(enterpriseValueBridge?.backfills ?? []),
    ...(statutoryTaxRate?.backfills ?? []),
  ];
  for (const key of FINANCIAL_STATEMENT_SERIES_KEYS) {
    const later = LATER_SERIES[key];
    if (allSeries[key] === undefined && later !== undefined) {
      series[key] = { key, ...later, annual: [], interim: [] };
      byStatement[later.statement][key] = series[key];
      continue;
    }
    const read = readFinancialStatementSeries(allSeries[key], key);
    if (read === undefined) {
      return undefined;
    }
    series[key] = read.series;
    drops.push(...read.drops);
    backfills.push(...read.backfills);
  }
  const statement = (record: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(record).map((key) => [
        key,
        series[key as FinancialStatementSeriesKey] ?? record[key],
      ]),
    );
  const read = withArtifactReadDiagnostics(
    {
      ...value,
      ...(equityStack === undefined ? {} : { equityStack: equityStack.group }),
      enterpriseValueBridge: enterpriseValueBridge?.group,
      ...(statutoryTaxRate === undefined
        ? {}
        : { statutoryTaxRate: statutoryTaxRate.observations }),
      statements: {
        ...value.statements,
        incomeStatement: statement(income),
        balanceSheet: statement(balance),
        cashFlowStatement: statement(cashFlow),
        perShare: statement(perShare),
      },
    } as unknown as FinancialStatementsArtifact,
    previous,
    drops,
  );
  return backfills.length === 0 || read.readDiagnostics === undefined
    ? read
    : { ...read, readDiagnostics: { ...read.readDiagnostics, backfills } };
}
