import type { InstrumentIdentity, Source, SourceGap } from "../../domain/types";
import { isInstrumentCommand } from "../../cli/args";
import { DAY_MS, SEC_FRESHNESS_DAYS } from "../../config/shared";
import { sourceGap } from "../../domain/source-gaps";
import { isRecord, readNumber, readString } from "../../guards";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import { isUsListing } from "../instrument-capability";
import { evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import {
  conceptScope,
  DEBT_CONCEPTS,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  compositeStatementIdentity,
  debtCandidateConcepts,
  isYearAligned,
  recognizedDebtConcepts,
  resolveDebtAtInstant,
  unsupersededDebtResolutions,
  type DebtHistoryFact,
  type DebtResolution,
} from "./financial-statement-selection";
import {
  grossPrincipalDebtFallbackApplies,
  statementFiscalPeriodKey,
  type StatementFiscalPeriod,
} from "./financial-statement-period-identity";
import {
  canonicalizeSecForm,
  GROSS_PRINCIPAL_DEBT_CONCEPT,
  isDomesticPeriodicCanonicalForm,
  type DebtBasis,
  readSecFactPeriodMetadata,
} from "./financial-statements-contract";
import { readArray } from "./utils";

type SecForm = "10-K" | "10-Q" | "10-K/A" | "10-Q/A";

export interface SecFactValue {
  readonly val: number;
  readonly form: SecForm;
  readonly canonicalForm: "10-K" | "10-Q";
  readonly amendment: boolean;
  readonly accessionNumber?: string;
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly start?: string;
  readonly end?: string;
}

const DAYS_PER_MONTH = 30.4368;

export interface SecMetricDefinition {
  readonly key: string;
  readonly label: string;
  readonly concepts: readonly string[];
  readonly unitKeys: readonly string[];
  // Optional metrics are emitted when present but their absence is not a data
  // Gap (e.g. dividendsPaid is absent for non-dividend-paying issuers). Required
  // Metrics add to missingFacts/missingDeltas and cap evidence quality when absent.
  readonly optional?: boolean;
}

interface SecMetricSelection {
  readonly latest: SecFactValue;
  readonly prior?: SecFactValue;
  readonly concept?: string;
}

export interface SecDebtComposite {
  readonly selectedConcepts: readonly string[];
  readonly periodEnd?: string;
  readonly incompleteReason?: string;
}

export interface SecFundamentalsSummary {
  readonly summary: string;
  readonly metrics: Record<string, number | string>;
  readonly revenuePeriodEnd?: string;
  readonly debtComposite?: SecDebtComposite;
  readonly gaps: readonly SourceGap[];
}

export interface SecSicClassification {
  readonly sic: string;
  readonly sicDescription?: string;
}

export interface SecCompanyFactsResult {
  readonly symbol: string;
  readonly cik?: string;
  readonly identity?: InstrumentIdentity;
  readonly sourceId?: string;
  readonly sourceUrl?: string;
  readonly fetchedAt?: string;
  readonly factsPayload?: unknown;
  readonly metrics?: Record<string, number | string>;
  readonly summary?: string;
  readonly revenuePeriodEnd?: string;
  readonly debtComposite?: SecDebtComposite;
  readonly sicClassification?: SecSicClassification;
  readonly filingsSummary?: string;
  readonly submissionsUrl?: string;
  readonly submissionsPayload?: unknown;
  readonly submissionsSourceId?: string;
  readonly submissionsFetchedAt?: string;
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

export interface SecProviderResult extends ProviderResult {
  readonly sicClassification?: SecSicClassification;
}

export const SEC_METRIC_DEFINITIONS = [
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
    key: "continuingIncome",
    label: "income",
    concepts: [
      "IncomeLossFromContinuingOperations",
      "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest",
    ],
    unitKeys: ["USD"],
    optional: true,
  },
  {
    key: "continuingDilutedEps",
    label: "diluted EPS",
    concepts: ["IncomeLossFromContinuingOperationsPerDilutedShare"],
    unitKeys: ["USD/shares"],
    optional: true,
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
    concepts: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    unitKeys: ["USD"],
  },
  {
    key: "capex",
    label: "capex",
    concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
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
    // PaymentsForDividends is the cash-flow-statement outflow (negative in XBRL);
    // DividendsPaid is an alternative some issuers use. The lens handles sign via abs().
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
] as const satisfies readonly SecMetricDefinition[];

export type SecMetricDefinitionKey = (typeof SEC_METRIC_DEFINITIONS)[number]["key"];

const DEBT_METRIC = {
  key: "debt",
  label: "debt",
  concepts: DEBT_CONCEPTS["us-gaap"].totals,
  unitKeys: ["USD"],
} as const satisfies SecMetricDefinition;

const FLOW_METRIC_KEYS = new Set([
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "consolidatedNetIncome",
  "dilutedEps",
  "continuingIncome",
  "continuingDilutedEps",
  "operatingCashFlow",
  "capex",
  "dilutedShares",
  "dividendsPaid",
  "shareRepurchases",
]);

export function secRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined
    ? undefined
    : { headers: { accept: "application/json", "user-agent": userAgent } };
}

export function findSecTicker(
  payload: unknown,
  symbol: string,
): { cik: string; ticker: string; name?: string } | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const normalizedSymbol = symbol.toUpperCase();
  const entries = Object.values(payload).filter((value) => isRecord(value));
  const match = entries.find(
    (entry) => readString(entry, "ticker")?.toUpperCase() === normalizedSymbol,
  );
  if (match === undefined) {
    return undefined;
  }
  const ticker = readString(match, "ticker")?.trim().toUpperCase();
  const cikNumber = readNumber(match, "cik_str");
  if (ticker === undefined || cikNumber === undefined) {
    return undefined;
  }
  const name = readString(match, "title");
  return {
    cik: String(cikNumber).padStart(10, "0"),
    ticker,
    ...(name !== undefined ? { name } : {}),
  };
}

function summarizeSecFilings(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return undefined;
  }
  const forms = Array.isArray(payload.filings.recent.form) ? payload.filings.recent.form : [];
  const dates = Array.isArray(payload.filings.recent.filingDate)
    ? payload.filings.recent.filingDate
    : [];
  const filings = forms
    .map((form, index) =>
      typeof form === "string" && typeof dates[index] === "string" ? `${form} ${dates[index]}` : "",
    )
    .filter(
      (value) => value.startsWith("10-K ") || value.startsWith("10-Q ") || value.startsWith("8-K "),
    );
  return filings.length > 0 ? `Recent SEC filings: ${filings.slice(0, 5).join(", ")}.` : undefined;
}

// Amendments are skipped: a partial 10-K/A or 10-Q/A legitimately carries no balance-sheet facts.
export function latestFilingWithoutDebtFacts(
  sec: Pick<SecCompanyFactsResult, "factsPayload" | "submissionsPayload">,
  debtPeriodEnd: string,
  asOf: string,
): "10-K" | "10-Q" | undefined {
  const recent =
    isRecord(sec.submissionsPayload) && isRecord(sec.submissionsPayload.filings)
      ? sec.submissionsPayload.filings.recent
      : undefined;
  const forms = readArray(recent, "form");
  const accessions = readArray(recent, "accessionNumber");
  const reportDates = readArray(recent, "reportDate");
  const filingDates = readArray(recent, "filingDate");
  const cutoff = asOf.slice(0, 10);
  const [latest] = forms
    .flatMap((form, index) => {
      const filingDate = filingDates[index];
      return (form === "10-K" || form === "10-Q") &&
        typeof filingDate === "string" &&
        filingDate <= cutoff
        ? [
            {
              form,
              filingDate,
              accession: accessions[index],
              reportDate: reportDates[index],
            } as const,
          ]
        : [];
    })
    .toSorted((left, right) => right.filingDate.localeCompare(left.filingDate));
  const gaap =
    isRecord(sec.factsPayload) && isRecord(sec.factsPayload.facts)
      ? sec.factsPayload.facts["us-gaap"]
      : undefined;
  if (
    latest === undefined ||
    typeof latest.accession !== "string" ||
    typeof latest.reportDate !== "string" ||
    latest.reportDate === "" ||
    latest.reportDate <= debtPeriodEnd ||
    !isRecord(gaap)
  ) {
    return undefined;
  }
  const contributed = debtCandidateConcepts("us-gaap", gaap).some((concept) => {
    const units = isRecord(gaap[concept]) ? gaap[concept].units : undefined;
    return (
      isRecord(units) &&
      Object.values(units).some(
        (rows) =>
          Array.isArray(rows) && rows.some((row) => isRecord(row) && row.accn === latest.accession),
      )
    );
  });
  return contributed ? undefined : latest.form;
}

// SIC arrives as a string in current SEC submissions payloads, but tolerate a
// Numeric encoding; provenance is always the submissions endpoint itself.
function extractSecSic(payload: unknown): SecSicClassification | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const sicText = readString(payload, "sic")?.trim();
  const sicNumber = readNumber(payload, "sic");
  const sic = sicText !== undefined && sicText !== "" ? sicText : sicNumber?.toString();
  if (sic === undefined || !/^\d{3,4}$/u.test(sic)) {
    return undefined;
  }
  const sicDescription = readString(payload, "sicDescription")?.trim();
  return {
    sic: sic.padStart(4, "0"),
    ...(sicDescription !== undefined && sicDescription !== "" ? { sicDescription } : {}),
  };
}

function readFiscalYear(value: Record<string, unknown>): number | undefined {
  const year = readNumber(value, "fy");
  if (year !== undefined) {
    return year;
  }
  const text = readString(value, "fy");
  if (text === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readSecFactValue(value: unknown): SecFactValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const val = readNumber(value, "val");
  const formValue = readString(value, "form");
  const parsed = formValue === undefined ? undefined : canonicalizeSecForm(formValue);
  const period = readSecFactPeriodMetadata(value);
  // Amendments share canonicalizeSecForm; 20-F/40-F/6-K stay canonical-only.
  if (
    val === undefined ||
    parsed === undefined ||
    !isDomesticPeriodicCanonicalForm(parsed.canonicalForm) ||
    period === undefined
  ) {
    return undefined;
  }
  const fy = readFiscalYear(value);
  const start = readString(value, "start");
  const accessionNumber = readString(value, "accn");
  return {
    val,
    form: parsed.form as SecForm,
    canonicalForm: parsed.canonicalForm,
    amendment: parsed.amendment,
    fp: period.fp,
    ...(fy !== undefined ? { fy } : {}),
    filed: period.filed,
    ...(start !== undefined ? { start } : {}),
    end: period.end,
    ...(accessionNumber !== undefined ? { accessionNumber } : {}),
  };
}

// Reporting period length in months for a duration (flow) fact, rounded to the
// Nearest whole month: ~3 for a single quarter, ~12 for a full fiscal year.
// Undefined when the fact lacks a start/end span (e.g. balance-sheet instants).
export function periodMonths(fact: SecFactValue): number | undefined {
  if (fact.start === undefined || fact.end === undefined) {
    return undefined;
  }
  const startMs = Date.parse(fact.start);
  const endMs = Date.parse(fact.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return undefined;
  }
  const months = Math.round((endMs - startMs) / 86_400_000 / DAYS_PER_MONTH);
  return months > 0 ? months : undefined;
}

export function isFactObservableAsOf(fact: SecFactValue, analysisAsOf?: string): boolean {
  if (analysisAsOf === undefined) {
    return true;
  }
  const cutoff = analysisAsOf.slice(0, 10);
  return (
    (fact.end === undefined || fact.end <= cutoff) &&
    (fact.filed === undefined || fact.filed <= cutoff)
  );
}

// Returns true when the revenue period end is older than SEC_FRESHNESS_DAYS.
// The gap does not suppress the metric, so downstream consumers can still use it.
function isStalePeriodEnd(periodEnd: string, analysisAsOf: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const cutoffMs = Date.parse(analysisAsOf);
  if (!Number.isFinite(periodMs) || !Number.isFinite(cutoffMs)) {
    return false;
  }
  return cutoffMs - periodMs > SEC_FRESHNESS_DAYS * DAY_MS;
}

function selectionFact(value: SecFactValue) {
  return {
    ...(value.start !== undefined ? { periodStart: value.start } : {}),
    periodEnd: value.end ?? "",
    filedAt: value.filed ?? "",
    amendment: value.amendment,
    accessionNumber: value.accessionNumber ?? null,
  };
}

function compareFactRecency(a: SecFactValue, b: SecFactValue): number {
  return compareFinancialStatementFacts(selectionFact(a), selectionFact(b));
}

function compareFactPeriod(a: SecFactValue, b: SecFactValue): number {
  return (
    (b.end ?? "").localeCompare(a.end ?? "") || (periodMonths(b) ?? 0) - (periodMonths(a) ?? 0)
  );
}

function latestFact(values: readonly SecFactValue[]): SecFactValue | undefined {
  return values.toSorted(compareFactRecency)[0];
}

function factValuesForConcept(
  gaap: Record<string, unknown>,
  concept: string,
  unitKeys: readonly string[],
): readonly SecFactValue[] {
  const fact = isRecord(gaap[concept]) ? gaap[concept] : undefined;
  const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
  if (units === undefined) {
    return [];
  }
  return unitKeys.flatMap((unitKey) =>
    readArray(units, unitKey).flatMap((value) => {
      const factValue = readSecFactValue(value);
      return factValue === undefined ? [] : [factValue];
    }),
  );
}

function isComparablePrior(latest: SecFactValue, candidate: SecFactValue): boolean {
  if (
    latest.end === undefined ||
    candidate.end === undefined ||
    candidate.canonicalForm !== latest.canonicalForm ||
    !isYearAligned(candidate.end, latest.end)
  ) {
    return false;
  }
  const startAligned =
    latest.start === undefined
      ? candidate.start === undefined
      : candidate.start !== undefined && isYearAligned(candidate.start, latest.start);
  return startAligned && (latest.canonicalForm === "10-Q" ? candidate.fp === latest.fp : true);
}

// Latest-filed wins, so a later filing's restated comparative beats the prior year's original.
function comparablePrior(
  latest: SecFactValue,
  values: readonly SecFactValue[],
): SecFactValue | undefined {
  return latestFact(values.filter((value) => isComparablePrior(latest, value)));
}

function selectMetric(
  gaap: Record<string, unknown>,
  metric: SecMetricDefinition,
  analysisAsOf?: string,
  flowPeriod?: SecFactValue,
): SecMetricSelection | undefined {
  const selections: (SecMetricSelection & { readonly priority: number })[] = [];
  for (const [priority, concept] of metric.concepts.entries()) {
    const observableValues = factValuesForConcept(gaap, concept, metric.unitKeys).filter((value) =>
      isFactObservableAsOf(value, analysisAsOf),
    );
    const values =
      flowPeriod === undefined
        ? observableValues
        : observableValues.filter(
            (value) => isCurrentFlowFact(flowPeriod, value) || isComparablePrior(flowPeriod, value),
          );
    const latest = latestFact(
      flowPeriod === undefined
        ? values
        : values.filter((value) => isCurrentFlowFact(flowPeriod, value)),
    );
    if (latest === undefined) {
      continue;
    }
    const prior = comparablePrior(latest, values);
    selections.push({ latest, ...(prior !== undefined ? { prior } : {}), concept, priority });
  }
  // On an equal period configured order wins, even over prior availability: it encodes measure scope.
  return selections.toSorted(
    (a, b) => compareFactPeriod(a.latest, b.latest) || a.priority - b.priority,
  )[0];
}

function sameFiscalPeriod(a: SecFactValue, b: SecFactValue): boolean {
  return (
    a.canonicalForm === b.canonicalForm &&
    a.fy === b.fy &&
    (a.canonicalForm === "10-K" || a.fp === b.fp)
  );
}

function isCurrentFlowFact(anchor: SecFactValue, candidate: SecFactValue): boolean {
  return (
    sameFiscalPeriod(anchor, candidate) &&
    candidate.end === anchor.end &&
    (anchor.start === undefined || candidate.start === anchor.start)
  );
}

function statementPeriod(value: SecFactValue): StatementFiscalPeriod | undefined {
  return value.end === undefined
    ? undefined
    : { periodEnd: value.end, form: value.form, fiscalPeriod: value.fp ?? "" };
}

function debtPeriodIdentity(value: SecFactValue): string {
  const period = statementPeriod(value);
  return period === undefined ? value.form : statementFiscalPeriodKey(period);
}

function resolvedDebtFact(resolution: DebtResolution<SecFactValue>): SecFactValue | undefined {
  const facts = resolution.contributors.map(({ fact, subtract }) =>
    subtract === true ? { ...fact, val: -fact.val } : fact,
  );
  const [anchor] = facts;
  if (anchor === undefined || resolution.basis === "total") {
    return anchor;
  }
  const identity = compositeStatementIdentity(
    facts.map((fact) => ({
      value: fact.val,
      accessionNumber: fact.accessionNumber ?? null,
      filedAt: fact.filed ?? "",
    })),
  );
  const { accessionNumber: _omitted, ...period } = anchor;
  return {
    ...period,
    val: identity.value,
    filed: identity.filedAt,
    ...(identity.accessionNumber !== null ? { accessionNumber: identity.accessionNumber } : {}),
  };
}

interface SecDebtSelection {
  readonly selection?: SecMetricSelection;
  readonly composite?: SecDebtComposite;
  readonly grossPrincipal?: { readonly periodEnd: string; readonly netPeriodEnd: string };
  readonly leaseInclusive?: { readonly periodEnd: string; readonly concepts: readonly string[] };
}

function selectDebtMetric(
  gaap: Record<string, unknown>,
  analysisAsOf?: string,
): SecDebtSelection | undefined {
  const net = selectNetDebtMetric(gaap, analysisAsOf);
  const netLatest = net?.selection?.latest;
  const gross = factValuesForConcept(
    gaap,
    GROSS_PRINCIPAL_DEBT_CONCEPT,
    DEBT_METRIC.unitKeys,
  ).filter((value) => value.start === undefined && isFactObservableAsOf(value, analysisAsOf));
  const latestGross = latestFact(gross);
  if (
    net === undefined ||
    netLatest?.end === undefined ||
    latestGross?.end === undefined ||
    !grossPrincipalDebtFallbackApplies(
      { periodEnd: netLatest.end, value: netLatest.val },
      latestGross.end,
      latestFact(gross.filter((value) => value.end === netLatest.end))?.val,
    )
  ) {
    return net;
  }
  const prior = comparablePrior(latestGross, gross);
  return {
    selection: { latest: latestGross, ...(prior !== undefined ? { prior } : {}) },
    grossPrincipal: { periodEnd: latestGross.end, netPeriodEnd: netLatest.end },
  };
}

function selectNetDebtMetric(
  gaap: Record<string, unknown>,
  analysisAsOf?: string,
): SecDebtSelection | undefined {
  const instants = new Map<string, Map<string, SecFactValue>>();
  const history: DebtHistoryFact[] = [];
  const recognized = recognizedDebtConcepts("us-gaap");
  for (const concept of debtCandidateConcepts("us-gaap", gaap)) {
    const values = factValuesForConcept(gaap, concept, DEBT_METRIC.unitKeys).filter(
      (value) =>
        isFactObservableAsOf(value, analysisAsOf) &&
        (value.start === undefined || recognized.has(concept)),
    );
    for (const value of values.toSorted(compareFactRecency)) {
      history.push({
        concept,
        periodEnd: value.end ?? "",
        filedAt: value.filed ?? "",
        value: value.val,
      });
      const tagged = instants.get(debtPeriodIdentity(value)) ?? new Map<string, SecFactValue>();
      if (!tagged.has(concept)) {
        tagged.set(concept, value);
      }
      instants.set(debtPeriodIdentity(value), tagged);
    }
  }
  const resolved = unsupersededDebtResolutions(
    [...instants.values()].map((tagged) => {
      const [anchor] = [...tagged.values()].toSorted(compareFactRecency);
      const instant = { periodEnd: anchor?.end ?? "", filedAt: anchor?.filed ?? "" };
      const resolution = resolveDebtAtInstant(
        "us-gaap",
        instant,
        tagged,
        history,
        (fact) => fact.val,
      );
      const fact =
        resolution.incompleteReason === undefined ? resolvedDebtFact(resolution) : undefined;
      return { ...instant, resolution, fact, anchor, incomplete: fact === undefined };
    }),
  ).toSorted((left, right) =>
    left.anchor === undefined || right.anchor === undefined
      ? 0
      : compareFactRecency(left.fact ?? left.anchor, right.fact ?? right.anchor),
  );
  const [newest] = resolved;
  const complete = resolved.flatMap((entry) =>
    entry.fact === undefined ? [] : [{ ...entry, fact: entry.fact }],
  );
  const [latest] = complete;
  const prior =
    latest === undefined
      ? undefined
      : comparablePrior(
          latest.fact,
          complete.flatMap((entry) =>
            entry.resolution.basis === latest.resolution.basis ? [entry.fact] : [],
          ),
        );
  const [primary] = latest?.resolution.contributors ?? [];
  const leaseInclusive = latest?.resolution.leaseInclusive;
  const composite =
    newest?.resolution.basis === "components"
      ? {
          selectedConcepts: newest.resolution.contributors.map(
            (contributor) => contributor.concept,
          ),
          periodEnd: newest.periodEnd,
          ...(newest.resolution.incompleteReason !== undefined
            ? { incompleteReason: newest.resolution.incompleteReason }
            : {}),
        }
      : undefined;
  if (latest === undefined && composite === undefined) {
    return undefined;
  }
  return {
    ...(latest !== undefined
      ? {
          selection: {
            latest: latest.fact,
            ...(prior !== undefined ? { prior } : {}),
            ...(latest.resolution.basis === "total" && primary !== undefined
              ? { concept: primary.concept }
              : {}),
          },
        }
      : {}),
    ...(composite !== undefined ? { composite } : {}),
    ...(latest?.fact.end !== undefined && leaseInclusive !== undefined
      ? { leaseInclusive: { periodEnd: latest.fact.end, concepts: leaseInclusive } }
      : {}),
  };
}

export const DEBT_MAY_INCLUDE_FINANCE_LEASES = "may-include-finance-leases";

export function leaseInclusiveDebtGap(periodEnd: string, concepts: readonly string[]): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC debt as of ${periodEnd} may include finance leases: ${concepts.join(", ")} is tagged without a matching finance-lease amount to remove`,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

export function grossPrincipalDebtGap(periodEnd: string, netPeriodEnd: string): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC debt uses gross principal (${GROSS_PRINCIPAL_DEBT_CONCEPT}) as of ${periodEnd}: net carrying debt is not tagged in companyfacts after ${netPeriodEnd}, where gross principal was within 5% of it`,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function deltaPercent(latest: number, prior: number): number | undefined {
  return prior === 0 ? undefined : ((latest - prior) / Math.abs(prior)) * 100;
}

function formatMetric(
  label: string,
  latest: number,
  prior: number | undefined,
  delta: number | undefined,
): string {
  if (delta === undefined) {
    return `${label} ${String(latest)}`;
  }
  if (prior !== undefined && latest < 0 && prior < 0) {
    const direction = latest < prior ? "widened" : "narrowed";
    return `${label} ${String(latest)} (loss ${direction} ${Math.abs(delta).toFixed(1)}% YoY)`;
  }
  return `${label} ${String(latest)} (${delta.toFixed(1)}% YoY)`;
}

const SUMMARY_METRIC_DEFINITIONS: readonly SecMetricDefinition[] = [
  ...SEC_METRIC_DEFINITIONS,
  DEBT_METRIC,
];

// `metricsFor` picks the metric source per key, so canonical inputs can override legacy ones.
export function formatSecFundamentalsSummary(
  metricsFor: (key: string) => Readonly<Record<string, number | string>> | undefined,
): string | undefined {
  const parts = SUMMARY_METRIC_DEFINITIONS.flatMap(({ key, label }) => {
    const metrics = metricsFor(key);
    const latest = metrics?.[key];
    if (typeof latest !== "number") {
      return [];
    }
    if (key === "consolidatedNetIncome" && metricsFor("netIncome")?.netIncome === latest) {
      return [];
    }
    const prior = metrics?.[`${key}Prior`];
    const delta = metrics?.[`${key}DeltaPercent`];
    const scope = metrics?.[`${key}Scope`];
    const basisLabel =
      metrics?.[`${key}Basis`] === "gross-principal" ? `${label} (gross principal)` : label;
    return [
      formatMetric(
        scopedLabel(basisLabel, typeof scope === "string" ? scope : undefined),
        latest,
        typeof prior === "number" ? prior : undefined,
        typeof delta === "number" ? delta : undefined,
      ),
    ];
  });
  return parts.length === 0 ? undefined : `SEC Fundamental Evidence: ${parts.join(", ")}.`;
}

export function summarizeSecFundamentals(
  payload: unknown,
  analysisAsOf?: string,
): SecFundamentalsSummary | undefined {
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    return undefined;
  }
  const gaap = payload.facts["us-gaap"];
  const metrics: Record<string, number | string> = {};
  const missingFacts: string[] = [];
  const missingDeltas: string[] = [];

  const [revenueDefinition] = SEC_METRIC_DEFINITIONS;
  const revenueSelection =
    revenueDefinition === undefined
      ? undefined
      : selectMetric(gaap, revenueDefinition, analysisAsOf);
  const flowPeriod = revenueSelection?.latest;
  const debtSelection = selectDebtMetric(gaap, analysisAsOf);
  const metricSelections: readonly {
    readonly definition: SecMetricDefinition;
    readonly selection: SecMetricSelection | undefined;
  }[] = [
    ...SEC_METRIC_DEFINITIONS.map((definition) => ({
      definition,
      selection:
        definition.key === "revenue"
          ? revenueSelection
          : selectMetric(
              gaap,
              definition,
              analysisAsOf,
              FLOW_METRIC_KEYS.has(definition.key) ? flowPeriod : undefined,
            ),
    })),
    { definition: DEBT_METRIC, selection: debtSelection?.selection },
  ];

  for (const { definition, selection } of metricSelections) {
    if (selection === undefined) {
      if (!definition.optional) {
        missingFacts.push(definition.key);
      }
      continue;
    }
    const { latest, prior } = selection;
    metrics[definition.key] = latest.val;
    if (latest.end !== undefined) {
      metrics[`${definition.key}PeriodEnd`] = latest.end;
    }
    // Expose each flow fact's own reporting-period length so downstream ratios
    // (ROE/ROA/PCF) annualize by the metric's own period, not revenue's. Instant
    // Facts (no start/end span) yield undefined and emit no key. Revenue keeps its
    // Dedicated revenuePeriodEnd sidecar for the valuation module.
    const months = periodMonths(latest);
    if (months !== undefined) {
      metrics[`${definition.key}PeriodMonths`] = months;
    }
    if (definition.key === "revenue" && latest.end !== undefined) {
      metrics.revenuePeriodEnd = latest.end;
    }
    const delta = prior === undefined ? undefined : deltaPercent(latest.val, prior.val);
    if (prior === undefined) {
      if (!definition.optional) {
        missingDeltas.push(definition.key);
      }
    } else {
      metrics[`${definition.key}Prior`] = prior.val;
      if (delta !== undefined) {
        metrics[`${definition.key}DeltaPercent`] = delta;
      }
    }
    const scope = conceptScope(selection.concept);
    if (scope !== undefined) {
      metrics[`${definition.key}Scope`] = scope;
    }
  }

  for (const [continuingKey, totalKey] of [
    ["continuingIncome", "netIncome"],
    ["continuingDilutedEps", "dilutedEps"],
  ] as const) {
    if (metrics[continuingKey] !== undefined && metrics[`${totalKey}Scope`] === undefined) {
      metrics[`${totalKey}Scope`] = TOTAL_OPERATIONS_SCOPE;
    }
  }
  if (debtSelection?.grossPrincipal !== undefined) {
    metrics.debtBasis = "gross-principal" satisfies DebtBasis;
  }
  if (debtSelection?.grossPrincipal === undefined && debtSelection?.leaseInclusive !== undefined) {
    metrics.debtLeaseScope = DEBT_MAY_INCLUDE_FINANCE_LEASES;
  }
  const incompleteDebt = debtSelection?.composite;
  if (
    debtSelection?.selection !== undefined &&
    incompleteDebt?.incompleteReason !== undefined &&
    incompleteDebt.periodEnd !== undefined
  ) {
    metrics.debtIncompletePeriodEnd = incompleteDebt.periodEnd;
    metrics.debtIncompleteReason = incompleteDebt.incompleteReason;
  }

  const summary = formatSecFundamentalsSummary(() => metrics);
  if (summary === undefined) {
    return undefined;
  }

  const staleRevenueGap =
    typeof metrics.revenuePeriodEnd === "string" &&
    analysisAsOf !== undefined &&
    isStalePeriodEnd(metrics.revenuePeriodEnd, analysisAsOf)
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Stale SEC revenue period: period end ${metrics.revenuePeriodEnd} exceeds ${SEC_FRESHNESS_DAYS} days`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];

  const grossPrincipalGap =
    debtSelection?.grossPrincipal === undefined
      ? []
      : [
          grossPrincipalDebtGap(
            debtSelection.grossPrincipal.periodEnd,
            debtSelection.grossPrincipal.netPeriodEnd,
          ),
        ];

  const gaps: SourceGap[] = [
    ...grossPrincipalGap,
    ...(debtSelection?.grossPrincipal === undefined && debtSelection?.leaseInclusive !== undefined
      ? [
          leaseInclusiveDebtGap(
            debtSelection.leaseInclusive.periodEnd,
            debtSelection.leaseInclusive.concepts,
          ),
        ]
      : []),
    ...(missingFacts.length > 0
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Missing SEC company facts: ${missingFacts.join(", ")}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : []),
    ...(missingDeltas.length > 0
      ? [
          sourceGap({
            source: "sec-edgar",
            message: `Missing comparable SEC company facts for YoY deltas: ${missingDeltas.join(
              ", ",
            )}`,
            provider: "sec-edgar",
            capability: "extended-evidence",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : []),
    ...staleRevenueGap,
  ];

  return {
    summary,
    metrics,
    ...(typeof metrics.revenuePeriodEnd === "string"
      ? { revenuePeriodEnd: metrics.revenuePeriodEnd }
      : {}),
    ...(debtSelection?.composite !== undefined ? { debtComposite: debtSelection.composite } : {}),
    gaps,
  };
}

function secFactRows(payload: unknown): readonly Record<string, unknown>[] {
  const facts = isRecord(payload) && isRecord(payload.facts) ? payload.facts : {};
  return Object.values(facts).flatMap((concepts) =>
    isRecord(concepts)
      ? Object.values(concepts).flatMap((concept) =>
          isRecord(concept) && isRecord(concept.units)
            ? Object.values(concept.units).flatMap((rows) =>
                Array.isArray(rows)
                  ? rows.filter(
                      (row) =>
                        isRecord(row) &&
                        readNumber(row, "val") !== undefined &&
                        readString(row, "form") !== undefined,
                    )
                  : [],
              )
            : [],
        )
      : [],
  );
}

// Why summarizeSecFundamentals returned undefined; absence is claimed only when no fact rows exist.
export function secFundamentalsUnavailableGap(
  payload: unknown,
  subject: string,
): Pick<SourceGap, "message" | "cause"> {
  const rows = secFactRows(payload);
  if (rows.length === 0) {
    return { message: `No SEC company facts found for ${subject}`, cause: "provider-data-missing" };
  }
  const hasDomesticPeriodicRow = rows.some((row) => {
    const form = readString(row, "form");
    const parsed = form === undefined ? undefined : canonicalizeSecForm(form);
    return parsed !== undefined && isDomesticPeriodicCanonicalForm(parsed.canonicalForm);
  });
  return hasDomesticPeriodicRow
    ? {
        message: `SEC company facts for ${subject} have no eligible rows for the tracked legacy summary metrics`,
        cause: "provider-data-missing",
      }
    : {
        message: `SEC company facts for ${subject} have no 10-K/10-Q rows (foreign-filer forms such as 20-F/40-F); legacy fundamentals summary unavailable`,
        cause: "unsupported-coverage",
      };
}

export async function fetchSecCompanyFactsForSymbol(
  ctx: CollectContext,
  symbol: string,
  tickerPayload?: unknown,
): Promise<SecCompanyFactsResult> {
  const secInit = secRequestInit(ctx.secUserAgent);
  const tickers =
    tickerPayload === undefined
      ? await ctx.request.json({
          url: "https://www.sec.gov/files/company_tickers.json",
          adapter: "sec-tickers",
          init: secInit,
        })
      : undefined;
  if (tickers !== undefined && !isFetchJsonResult(tickers)) {
    return { symbol: symbol.toUpperCase(), rawSnapshots: [], gaps: [tickers] };
  }
  const resolvedTickerPayload =
    tickerPayload ?? (tickers !== undefined && isFetchJsonResult(tickers) ? tickers.payload : {});
  const match = findSecTicker(resolvedTickerPayload, symbol);
  if (match === undefined) {
    return {
      symbol: symbol.toUpperCase(),
      rawSnapshots:
        tickers !== undefined && isFetchJsonResult(tickers) ? [tickers.rawSnapshot] : [],
      gaps: [
        sourceGap({
          source: "sec-edgar",
          message: `No SEC CIK match for ${symbol}`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`;
  const identity: InstrumentIdentity = {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
  const facts = await ctx.request.json({
    url: factsUrl,
    adapter: "sec-companyfacts",
    init: secInit,
  });
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const submissions = await ctx.request.json({
    url: submissionsUrl,
    adapter: "sec-submissions",
    init: secInit,
  });
  const sicClassification = isFetchJsonResult(submissions)
    ? extractSecSic(submissions.payload)
    : undefined;
  const filingsSummary = isFetchJsonResult(submissions)
    ? summarizeSecFilings(submissions.payload)
    : undefined;
  const submissionsFields = {
    submissionsUrl,
    ...(sicClassification !== undefined ? { sicClassification } : {}),
    ...(filingsSummary !== undefined ? { filingsSummary } : {}),
    ...(isFetchJsonResult(submissions)
      ? {
          submissionsPayload: submissions.payload,
          submissionsSourceId: `extended-sec-edgar-${symbol.toLowerCase()}-filings`,
          submissionsFetchedAt: submissions.rawSnapshot.fetchedAt,
        }
      : {}),
  };
  const submissionsGaps = isFetchJsonResult(submissions) ? [] : [submissions];

  const rawSnapshots = [
    ...(tickers !== undefined && isFetchJsonResult(tickers) ? [tickers.rawSnapshot] : []),
    ...(isFetchJsonResult(facts) ? [facts.rawSnapshot] : []),
    ...(isFetchJsonResult(submissions) ? [submissions.rawSnapshot] : []),
  ];
  if (!isFetchJsonResult(facts)) {
    return {
      symbol: match.ticker,
      cik: match.cik,
      identity,
      sourceUrl: factsUrl,
      ...submissionsFields,
      rawSnapshots,
      gaps: [facts, ...submissionsGaps],
    };
  }

  const fundamentals = summarizeSecFundamentals(facts.payload, ctx.fetchedAt);
  const emptyFactsGap =
    fundamentals === undefined
      ? [
          sourceGap({
            source: "sec-edgar",
            ...secFundamentalsUnavailableGap(facts.payload, symbol),
            provider: "sec-edgar",
            capability: "extended-evidence",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];

  return {
    symbol: match.ticker,
    cik: match.cik,
    identity,
    sourceId: `extended-sec-edgar-${symbol.toLowerCase()}-fundamentals`,
    sourceUrl: factsUrl,
    fetchedAt: facts.rawSnapshot.fetchedAt,
    factsPayload: facts.payload,
    ...(fundamentals !== undefined
      ? {
          metrics: fundamentals.metrics,
          summary: fundamentals.summary,
          ...(fundamentals.revenuePeriodEnd !== undefined
            ? { revenuePeriodEnd: fundamentals.revenuePeriodEnd }
            : {}),
          ...(fundamentals.debtComposite !== undefined
            ? { debtComposite: fundamentals.debtComposite }
            : {}),
        }
      : {}),
    ...submissionsFields,
    rawSnapshots,
    gaps: [...(fundamentals?.gaps ?? []), ...emptyFactsGap, ...submissionsGaps],
  };
}

export async function collectSec(ctx: CollectContext): Promise<SecProviderResult> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: tagSecTargetGaps(command.symbol, [
        sourceGap({
          source: "sec-edgar",
          message: `SEC EDGAR does not support ${command.symbol} (non-US listing)`,
          provider: "sec-edgar",
          capability: "extended-evidence",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ]),
    };
  }

  const factsResult = await fetchSecCompanyFactsForSymbol(ctx, command.symbol);
  return secProviderResultFromCompanyFacts(ctx, factsResult);
}

function tagSecTargetGaps(symbol: string, gaps: readonly SourceGap[]): readonly SourceGap[] {
  return gaps.map((gap) => ({ ...gap, symbol: symbol.toUpperCase() }));
}

export function secProviderResultFromCompanyFacts(
  ctx: CollectContext,
  factsResult: SecCompanyFactsResult,
): SecProviderResult {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return {
      rawSnapshots: factsResult.rawSnapshots,
      items: [],
      gaps: factsResult.gaps,
      ...(factsResult.sicClassification !== undefined
        ? { sicClassification: factsResult.sicClassification }
        : {}),
    };
  }
  const gaps = tagSecTargetGaps(command.symbol, factsResult.gaps);
  if (factsResult.cik === undefined || factsResult.identity === undefined) {
    return {
      rawSnapshots: factsResult.rawSnapshots,
      items: [],
      gaps,
      ...(factsResult.sicClassification !== undefined
        ? { sicClassification: factsResult.sicClassification }
        : {}),
    };
  }

  const { rawSnapshots, filingsSummary } = factsResult;
  const items: CollectedItem[] = [];

  // The submissions endpoint supplies the SIC classification as well as the
  // Filings summary, so its source must be attached whenever either datum is
  // Used — a company with no recent filings still needs SIC provenance.
  const filingsSource =
    (filingsSummary !== undefined || factsResult.sicClassification !== undefined) &&
    factsResult.submissionsSourceId !== undefined &&
    factsResult.submissionsFetchedAt !== undefined
      ? evidenceSource(
          factsResult.submissionsSourceId,
          `${command.symbol} SEC filings`,
          "sec-edgar",
          command,
          factsResult.submissionsFetchedAt,
          factsResult.submissionsUrl,
          factsResult.identity,
        )
      : undefined;

  const fundamentalsSource =
    factsResult.sourceId !== undefined &&
    factsResult.summary !== undefined &&
    factsResult.fetchedAt !== undefined
      ? evidenceSource(
          factsResult.sourceId,
          `${command.symbol} SEC fundamentals`,
          "sec-edgar",
          command,
          factsResult.fetchedAt,
          factsResult.sourceUrl,
          factsResult.identity,
        )
      : undefined;
  const sources = [filingsSource, fundamentalsSource].filter(
    (source): source is Source => source !== undefined,
  );
  const summaries = [filingsSummary, factsResult.summary].filter(
    (summary): summary is string => summary !== undefined,
  );
  if (sources.length > 0 && summaries.length > 0) {
    const primarySource = fundamentalsSource ?? filingsSource;
    if (primarySource !== undefined) {
      const metrics =
        factsResult.metrics !== undefined
          ? {
              ...factsResult.metrics,
              ...(factsResult.sicClassification !== undefined
                ? {
                    sic: factsResult.sicClassification.sic,
                    ...(factsResult.sicClassification.sicDescription !== undefined
                      ? { sicDescription: factsResult.sicClassification.sicDescription }
                      : {}),
                  }
                : {}),
            }
          : undefined;
      items.push({
        source: primarySource,
        sources,
        item: {
          category: "sec-edgar",
          title: `${command.symbol} SEC Fundamental Evidence`,
          summary: summaries.join(" "),
          sourceIds: sources.map((source) => source.id),
          observedAt: primarySource.fetchedAt,
          ...(metrics !== undefined ? { metrics } : {}),
          identity: factsResult.identity,
        },
      });
    }
  }

  return {
    rawSnapshots,
    items,
    gaps,
    ...(factsResult.sicClassification !== undefined
      ? { sicClassification: factsResult.sicClassification }
      : {}),
  };
}
