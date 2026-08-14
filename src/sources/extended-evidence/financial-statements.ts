import { isRecord, readNumber, readString } from "../../guards";
import type { CollectContext } from "../types";
import { fetchSecCompanyFactsForSymbol, type SecCompanyFactsResult } from "./sec-edgar";
import {
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  isRevenueConceptInRecencyBucket,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  capFinancialStatementPeriods,
  compareFinancialStatementFacts,
  deriveFinancialStatementTtm,
  detectFinancialStatementCadence,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  incompleteFinancialStatementNotes,
} from "./financial-statement-selection";
import {
  CANONICAL_SEC_FORMS,
  SEC_COMPANYFACTS_UNIT_SCALE,
  isAnnualReportForm,
  type CanonicalSecForm,
  type FinancialStatementFact,
  type FinancialStatementEquityStack,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
  type StructuredFinancialGap,
  type SupportedSecForm,
} from "./financial-statements-contract";

interface ParsedFact {
  readonly value: number;
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
  readonly unit: string;
}

interface SelectedSeries {
  readonly series: FinancialStatementSeries;
  readonly validationNotes: readonly FinancialStatementNote[];
  readonly omissionNotes: readonly FinancialStatementNote[];
}

interface SubmissionFiling {
  readonly form: "6-K" | "6-K/A";
  readonly filedAt: string;
  readonly accessionNumber?: string;
  readonly reportDate?: string;
}

export interface FinancialStatementsDeriveInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly analysisAsOf: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
  readonly submissionsPayload?: unknown;
  readonly submissionsSourceId?: string;
}

const TAXONOMIES: readonly FinancialStatementTaxonomy[] = ["us-gaap", "ifrs-full"];
const MIN_ANNUAL_DURATION_MONTHS = 10;
const MAX_ANNUAL_DURATION_MONTHS = 14;
const EQUITY_INCLUDING_NONCONTROLLING_CONCEPT =
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
const MINORITY_INTEREST_CONCEPT = "MinorityInterest";
const TEMPORARY_EQUITY_CONCEPT_PRIORITY = [
  "TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests",
  "TemporaryEquityCarryingAmount",
  "RedeemableNoncontrollingInterestEquityCarryingAmount",
] as const;
type EquityStackComponentKey =
  | "minorityInterest"
  | "stockholdersEquityIncludingNoncontrollingInterest"
  | "temporaryEquity";

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

function parseFact(
  value: unknown,
  taxonomy: FinancialStatementTaxonomy,
  concept: string,
  unit: string,
): ParsedFact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const numericValue = readNumber(value, "val");
  const formValue = readString(value, "form");
  const form = formValue === undefined ? undefined : canonicalizeSecForm(formValue);
  const accessionNumber = readString(value, "accn");
  const filedAt = readString(value, "filed");
  const periodEnd = readString(value, "end");
  const fiscalPeriod = readString(value, "fp");
  if (
    numericValue === undefined ||
    form === undefined ||
    filedAt === undefined ||
    periodEnd === undefined ||
    fiscalPeriod === undefined
  ) {
    return undefined;
  }
  // NOTE — ponytail: Calendar-year labels fit calendar filers and BNS-style Oct-31 years.
  // Jan-31 retailers may call 2018-01-31 FY2017 while this yields 2018; this still beats the arbitrary filing frame.
  const fiscalYear = Number.parseInt(periodEnd.slice(0, 4), 10);
  if (!Number.isFinite(fiscalYear)) {
    return undefined;
  }
  const periodStart = readString(value, "start");
  return {
    value: numericValue,
    ...form,
    accessionNumber: accessionNumber ?? null,
    filedAt,
    ...(periodStart !== undefined ? { periodStart } : {}),
    periodEnd,
    fiscalYear,
    fiscalPeriod,
    taxonomy,
    concept,
    unit,
  };
}

function factsRoot(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) && isRecord(payload.facts) ? payload.facts : undefined;
}

function taxonomyRoot(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
): Record<string, unknown> | undefined {
  const root = factsRoot(payload);
  return root !== undefined && isRecord(root[taxonomy]) ? root[taxonomy] : undefined;
}

function unitFacts(
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  concept: string,
): readonly ParsedFact[] {
  const fact = isRecord(root[concept]) ? root[concept] : undefined;
  const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
  if (units === undefined) {
    return [];
  }
  return Object.entries(units).flatMap(([unit, values]) =>
    (Array.isArray(values) ? values : []).flatMap((value) => {
      const parsed = parseFact(value, taxonomy, concept, unit);
      return parsed === undefined ? [] : [parsed];
    }),
  );
}

function factsForDefinition(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean = () => true,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return [];
  }
  const concepts = definition.concepts[taxonomy];
  if (definition.key !== "revenue") {
    for (const concept of concepts) {
      const facts = unitFacts(taxonomy, root, concept);
      if (facts.some((fact) => eligible(fact))) {
        return facts;
      }
    }
    return [];
  }
  const ranked = concepts
    .map((concept, priority) => {
      const facts = unitFacts(taxonomy, root, concept);
      const [latest] = facts
        .filter((fact) => eligible(fact))
        .toSorted(compareFinancialStatementFacts);
      return { facts, latest, priority };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly facts: readonly ParsedFact[];
        readonly latest: ParsedFact;
        readonly priority: number;
      } => candidate.latest !== undefined,
    );
  const latestPeriodEnd = ranked
    .map((candidate) => candidate.latest.periodEnd)
    .toSorted()
    .at(-1);
  if (latestPeriodEnd === undefined) {
    return [];
  }
  return (
    ranked
      .filter((candidate) =>
        isRevenueConceptInRecencyBucket(candidate.latest.periodEnd, latestPeriodEnd),
      )
      .toSorted(
        (left, right) =>
          left.priority - right.priority ||
          left.latest.concept.localeCompare(right.latest.concept) ||
          left.latest.unit.localeCompare(right.latest.unit),
      )[0]?.facts ?? []
  );
}

function allFactsForDefinition(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  return root === undefined
    ? []
    : definition.concepts[taxonomy].flatMap((concept) => unitFacts(taxonomy, root, concept));
}

function isObservable(fact: ParsedFact, analysisAsOf: string): boolean {
  const cutoff = analysisAsOf.slice(0, 10);
  return fact.periodEnd <= cutoff && fact.filedAt <= cutoff;
}

function taxonomyScore(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): readonly [number, string, number, number] {
  const seriesFacts = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map((definition) =>
    allFactsForDefinition(payload, taxonomy, definition).filter((fact) =>
      isObservable(fact, analysisAsOf),
    ),
  );
  const revenueIndex = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.findIndex(
    (definition) => definition.key === "revenue",
  );
  if (revenueIndex === -1) {
    throw new Error("Financial statement definitions must include revenue");
  }
  const revenueAnnual = seriesFacts[revenueIndex]?.filter((fact) =>
    isAnnualReportForm(fact.canonicalForm),
  );
  const latestAnnual =
    revenueAnnual
      ?.map((fact) => fact.periodEnd)
      .toSorted()
      .at(-1) ?? "";
  return [
    Number((revenueAnnual?.length ?? 0) > 0),
    latestAnnual,
    seriesFacts.filter((facts) => facts.length > 0).length,
    seriesFacts.flat().length,
  ];
}

function compareTaxonomyScores(
  left: readonly [number, string, number, number],
  right: readonly [number, string, number, number],
): number {
  return (
    left[0] - right[0] ||
    left[1].localeCompare(right[1]) ||
    left[2] - right[2] ||
    left[3] - right[3]
  );
}

function selectTaxonomy(
  payload: unknown,
  analysisAsOf: string,
): FinancialStatementTaxonomy | undefined {
  return TAXONOMIES.map((taxonomy) => ({
    taxonomy,
    score: taxonomyScore(payload, taxonomy, analysisAsOf),
  }))
    .filter(({ score }) => score[3] > 0)
    .toSorted(
      (left, right) =>
        compareTaxonomyScores(right.score, left.score) ||
        TAXONOMIES.indexOf(left.taxonomy) - TAXONOMIES.indexOf(right.taxonomy),
    )[0]?.taxonomy;
}

function currencyForUnit(unit: string): string | undefined {
  const currency = unit.endsWith("/shares") ? unit.slice(0, -7) : unit;
  return /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

function selectReportingCurrency(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  analysisAsOf: string,
): string | undefined {
  const revenue = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (definition) => definition.key === "revenue",
  );
  if (revenue === undefined) {
    throw new Error("Financial statement definitions must include revenue");
  }
  const revenueFacts = allFactsForDefinition(payload, taxonomy, revenue).filter(
    (fact) => isObservable(fact, analysisAsOf) && isAnnualReportForm(fact.canonicalForm),
  );
  const pool =
    revenueFacts.length > 0
      ? revenueFacts
      : FINANCIAL_STATEMENT_SERIES_DEFINITIONS.filter(
          (definition) => definition.unitKind === "monetary",
        )
          .flatMap((definition) => allFactsForDefinition(payload, taxonomy, definition))
          .filter((fact) => isObservable(fact, analysisAsOf));
  const byCurrency = new Map<string, ParsedFact[]>();
  for (const fact of pool) {
    const currency = currencyForUnit(fact.unit);
    if (currency !== undefined) {
      byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), fact]);
    }
  }
  return [...byCurrency.entries()]
    .map(([currency, facts]) => ({
      currency,
      latestEnd:
        facts
          .map((fact) => fact.periodEnd)
          .toSorted()
          .at(-1) ?? "",
      latestFiled:
        facts
          .map((fact) => fact.filedAt)
          .toSorted()
          .at(-1) ?? "",
      count: facts.length,
    }))
    .toSorted(
      (left, right) =>
        right.latestEnd.localeCompare(left.latestEnd) ||
        right.latestFiled.localeCompare(left.latestFiled) ||
        right.count - left.count ||
        left.currency.localeCompare(right.currency),
    )[0]?.currency;
}

function expectedUnit(definition: FinancialStatementSeriesDefinition, currency: string): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${currency}/shares` : currency;
}

function periodType(
  fact: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
): "annual" | "interim" {
  if (!isAnnualReportForm(fact.canonicalForm)) {
    return "interim";
  }
  if (definition.kind === "instant") {
    return "annual";
  }
  const months = financialStatementPeriodMonths(fact);
  return months !== undefined &&
    months >= MIN_ANNUAL_DURATION_MONTHS &&
    months <= MAX_ANNUAL_DURATION_MONTHS
    ? "annual"
    : "interim";
}

function periodKey(fact: ParsedFact): string {
  return financialStatementPeriodKey(fact);
}

function toSelectedFact(
  fact: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
  currency: string,
  sourceId: string,
): FinancialStatementFact {
  return {
    value: fact.value,
    periodKey: periodKey(fact),
    periodType: periodType(fact, definition),
    form: fact.form,
    canonicalForm: fact.canonicalForm,
    amendment: fact.amendment,
    accessionNumber: fact.accessionNumber,
    filedAt: fact.filedAt,
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    fiscalYear: fact.fiscalYear,
    fiscalPeriod: fact.fiscalPeriod,
    taxonomy: fact.taxonomy,
    concept: fact.concept,
    currency: fact.unit === "shares" ? null : currency,
    unit: fact.unit,
    unitScale: SEC_COMPANYFACTS_UNIT_SCALE,
    extractionMethod: "sec-companyfacts",
    sourceIds: [sourceId],
  };
}

function equityStackConcepts(
  root: Record<string, unknown>,
  component: EquityStackComponentKey,
): readonly string[] {
  if (component === "minorityInterest") {
    return [MINORITY_INTEREST_CONCEPT];
  }
  if (component === "stockholdersEquityIncludingNoncontrollingInterest") {
    return [EQUITY_INCLUDING_NONCONTROLLING_CONCEPT];
  }
  const discovered = Object.keys(root).filter(
    (concept) =>
      concept.startsWith("TemporaryEquity") ||
      concept.startsWith("RedeemableNoncontrollingInterest"),
  );
  return [
    ...TEMPORARY_EQUITY_CONCEPT_PRIORITY,
    ...discovered
      .filter(
        (concept) => !TEMPORARY_EQUITY_CONCEPT_PRIORITY.some((candidate) => candidate === concept),
      )
      .toSorted(),
  ];
}

function selectEquityStackComponent(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  component: EquityStackComponentKey,
  preferredAccessions: ReadonlyMap<string, string>,
  input: FinancialStatementsDeriveInput,
): readonly FinancialStatementFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return [];
  }
  const priority = new Map(
    equityStackConcepts(root, component).map((concept, index) => [concept, index]),
  );
  const candidates = [...priority.keys()].flatMap((concept) =>
    unitFacts(taxonomy, root, concept).filter(
      (fact) =>
        fact.periodStart === undefined &&
        fact.unit === reportingCurrency &&
        isObservable(fact, input.analysisAsOf),
    ),
  );
  const byPeriodEnd = new Map<string, ParsedFact[]>();
  for (const fact of candidates) {
    byPeriodEnd.set(fact.periodEnd, [...(byPeriodEnd.get(fact.periodEnd) ?? []), fact]);
  }
  const instantDefinition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (definition) => definition.key === "stockholdersEquity",
  );
  if (instantDefinition === undefined) {
    throw new Error("Financial statement definitions must include stockholdersEquity");
  }
  return [...byPeriodEnd.values()]
    .map(
      (facts) =>
        facts.toSorted(
          (left, right) =>
            Number(right.accessionNumber === preferredAccessions.get(right.periodEnd)) -
              Number(left.accessionNumber === preferredAccessions.get(left.periodEnd)) ||
            (priority.get(left.concept) ?? Number.MAX_SAFE_INTEGER) -
              (priority.get(right.concept) ?? Number.MAX_SAFE_INTEGER) ||
            compareFinancialStatementFacts(left, right),
        )[0]!,
    )
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, instantDefinition, reportingCurrency, input.sourceId));
}

function selectEquityStack(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  selected: readonly SelectedSeries[],
  input: FinancialStatementsDeriveInput,
): {
  readonly equityStack?: FinancialStatementEquityStack;
  readonly validationNotes: readonly FinancialStatementNote[];
} {
  const identityFacts = (key: FinancialStatementSeriesKey): readonly FinancialStatementFact[] => {
    const series = selected.find((item) => item.series.key === key)?.series;
    return series === undefined ? [] : [...series.annual, ...series.interim];
  };
  const totalAssets = identityFacts("totalAssets");
  const totalLiabilities = identityFacts("totalLiabilities");
  const stockholdersEquity = identityFacts("stockholdersEquity");
  const preferredAccessions = new Map<string, string>();
  for (const asset of totalAssets) {
    const liability = totalLiabilities.find((fact) => fact.periodEnd === asset.periodEnd);
    if (asset.accessionNumber !== null && liability?.accessionNumber === asset.accessionNumber) {
      preferredAccessions.set(asset.periodEnd, asset.accessionNumber);
    }
  }
  const equityStack: FinancialStatementEquityStack = {
    totalAssets,
    totalLiabilities,
    stockholdersEquity,
    minorityInterest: selectEquityStackComponent(
      payload,
      taxonomy,
      reportingCurrency,
      "minorityInterest",
      preferredAccessions,
      input,
    ),
    stockholdersEquityIncludingNoncontrollingInterest: selectEquityStackComponent(
      payload,
      taxonomy,
      reportingCurrency,
      "stockholdersEquityIncludingNoncontrollingInterest",
      preferredAccessions,
      input,
    ),
    temporaryEquity: selectEquityStackComponent(
      payload,
      taxonomy,
      reportingCurrency,
      "temporaryEquity",
      preferredAccessions,
      input,
    ),
  };
  const hasComponents =
    equityStack.minorityInterest.length > 0 ||
    equityStack.stockholdersEquityIncludingNoncontrollingInterest.length > 0 ||
    equityStack.temporaryEquity.length > 0;
  if (!hasComponents) {
    return { validationNotes: [] };
  }
  const componentPeriods = new Set(
    [
      ...equityStack.minorityInterest,
      ...equityStack.stockholdersEquityIncludingNoncontrollingInterest,
      ...equityStack.temporaryEquity,
    ].map((fact) => fact.periodEnd),
  );
  const validationNotes: FinancialStatementNote[] = [];
  for (const asset of totalAssets) {
    const liability = totalLiabilities.find((fact) => fact.periodEnd === asset.periodEnd);
    if (
      liability !== undefined &&
      componentPeriods.has(asset.periodEnd) &&
      (asset.accessionNumber === null ||
        liability.accessionNumber === null ||
        asset.accessionNumber !== liability.accessionNumber)
    ) {
      validationNotes.push({
        code: "mixed-accessions",
        message: `Total assets and total liabilities for ${asset.periodEnd} do not share an SEC accession; equity-stack component selection uses standard precedence`,
        periodKey: asset.periodKey,
      });
    }
  }
  return { equityStack, validationNotes };
}

function selectRestatements(
  facts: readonly ParsedFact[],
  seriesKey: FinancialStatementSeriesKey,
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const groups = new Map<string, ParsedFact[]>();
  for (const fact of facts) {
    const key = periodKey(fact);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  const notes: FinancialStatementNote[] = [];
  const selected = [...groups.entries()].map(([key, matches]) => {
    const ordered = matches.toSorted(compareFinancialStatementFacts);
    const winner = ordered[0]!;
    if (ordered.length > 1) {
      notes.push({
        code: "duplicate-superseded",
        seriesKey,
        periodKey: key,
        message: `${String(ordered.length - 1)} duplicate/restated fact(s) superseded by ${winner.accessionNumber ?? "unknown accession"} filed ${winner.filedAt}`,
      });
    }
    return winner;
  });
  return { facts: selected, notes };
}

function chronological(left: ParsedFact, right: ParsedFact): number {
  return (
    left.periodEnd.localeCompare(right.periodEnd) ||
    (left.periodStart ?? "").localeCompare(right.periodStart ?? "") ||
    left.filedAt.localeCompare(right.filedAt) ||
    (left.accessionNumber ?? "").localeCompare(right.accessionNumber ?? "")
  );
}

function selectSeries(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  definition: FinancialStatementSeriesDefinition,
  input: FinancialStatementsDeriveInput,
): SelectedSeries {
  const unit = expectedUnit(definition, reportingCurrency);
  const raw = factsForDefinition(
    payload,
    taxonomy,
    definition,
    (fact) => isObservable(fact, input.analysisAsOf) && fact.unit === unit,
  );
  const observable = raw.filter((fact) => isObservable(fact, input.analysisAsOf));
  const compatible = observable.filter((fact) => fact.unit === unit);
  const validationNotes: FinancialStatementNote[] = [];
  const omissionNotes: FinancialStatementNote[] = [];
  const cutoffCount = raw.length - observable.length;
  if (cutoffCount > 0) {
    omissionNotes.push({
      code: "cutoff-exclusion",
      seriesKey: definition.key,
      message: `${String(cutoffCount)} fact(s) were excluded before dedupe at the analysis cutoff`,
    });
  }
  const missingAccessions = compatible.filter((fact) => fact.accessionNumber === null).length;
  if (missingAccessions > 0) {
    omissionNotes.push({
      code: "incomplete-metadata",
      seriesKey: definition.key,
      message: `${String(missingAccessions)} selected-candidate fact(s) lack an SEC accession number; persisted as null`,
    });
  }
  const otherCurrencies = [
    ...new Set(
      observable
        .map((fact) => currencyForUnit(fact.unit))
        .filter(
          (currency): currency is string =>
            currency !== undefined && currency !== reportingCurrency,
        ),
    ),
  ];
  if (otherCurrencies.length > 0) {
    omissionNotes.push({
      code: "mixed-currencies",
      seriesKey: definition.key,
      message: `Excluded incompatible reporting currenc${otherCurrencies.length === 1 ? "y" : "ies"}: ${otherCurrencies.join(", ")}`,
    });
  }
  const annualSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "annual"),
    definition.key,
  );
  const interimSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "interim"),
    definition.key,
  );
  validationNotes.push(...annualSelection.notes, ...interimSelection.notes);

  const mixedEnds = new Map<string, Set<string>>();
  for (const fact of interimSelection.facts) {
    const starts = mixedEnds.get(fact.periodEnd) ?? new Set<string>();
    starts.add(fact.periodStart ?? "instant");
    mixedEnds.set(fact.periodEnd, starts);
  }
  for (const [end, starts] of mixedEnds) {
    if (starts.size > 1) {
      validationNotes.push({
        code: "mixed-periods",
        seriesKey: definition.key,
        message: `${String(starts.size)} distinct interim spans end on ${end}; each remains a separate period key`,
      });
    }
  }

  const orderedAnnual = annualSelection.facts.toSorted(chronological);
  const orderedInterim = interimSelection.facts.toSorted(chronological);
  const annual = orderedAnnual.map((fact) =>
    toSelectedFact(fact, definition, reportingCurrency, input.sourceId),
  );
  const interim = orderedInterim.map((fact) =>
    toSelectedFact(fact, definition, reportingCurrency, input.sourceId),
  );
  const ttmResult = deriveFinancialStatementTtm(definition, annual, interim, reportingCurrency);
  if (ttmResult.note !== undefined) {
    validationNotes.push(ttmResult.note);
  }
  return {
    series: {
      key: definition.key,
      label: definition.label,
      statement: definition.statement,
      annual,
      interim,
      ...(ttmResult.ttm !== undefined ? { ttm: ttmResult.ttm } : {}),
    },
    validationNotes,
    omissionNotes,
  };
}

function recentSubmissionSixKFilings(
  payload: unknown,
  analysisAsOf: string,
): readonly SubmissionFiling[] {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return [];
  }
  const forms = Array.isArray(payload.filings.recent.form) ? payload.filings.recent.form : [];
  const filingDates = Array.isArray(payload.filings.recent.filingDate)
    ? payload.filings.recent.filingDate
    : [];
  const accessionNumbers = Array.isArray(payload.filings.recent.accessionNumber)
    ? payload.filings.recent.accessionNumber
    : [];
  const reportDates = Array.isArray(payload.filings.recent.reportDate)
    ? payload.filings.recent.reportDate
    : [];
  const cutoff = analysisAsOf.slice(0, 10);
  return forms.flatMap((value, index) => {
    const parsed = typeof value === "string" ? canonicalizeSecForm(value) : undefined;
    const filedAt = filingDates[index];
    if (
      parsed === undefined ||
      parsed.canonicalForm !== "6-K" ||
      typeof filedAt !== "string" ||
      filedAt > cutoff
    ) {
      return [];
    }
    const accessionNumber = accessionNumbers[index];
    const reportDate = reportDates[index];
    return [
      {
        form: parsed.form as "6-K" | "6-K/A",
        filedAt,
        ...(typeof accessionNumber === "string" ? { accessionNumber } : {}),
        ...(typeof reportDate === "string" && reportDate !== "" ? { reportDate } : {}),
      },
    ];
  });
}

function filingHasStructuredFact(filing: SubmissionFiling, facts: readonly ParsedFact[]): boolean {
  return facts.some((fact) => {
    if (fact.canonicalForm !== "6-K") {
      return false;
    }
    if (filing.accessionNumber !== undefined && fact.accessionNumber !== null) {
      return filing.accessionNumber === fact.accessionNumber;
    }
    return (
      filing.filedAt === fact.filedAt &&
      (filing.reportDate === undefined || filing.reportDate === fact.periodEnd)
    );
  });
}

function supportedSixKFacts(payload: unknown, analysisAsOf: string): readonly ParsedFact[] {
  return TAXONOMIES.flatMap((taxonomy) =>
    FINANCIAL_STATEMENT_SERIES_DEFINITIONS.flatMap((definition) =>
      allFactsForDefinition(payload, taxonomy, definition),
    ),
  ).filter((fact) => fact.canonicalForm === "6-K" && isObservable(fact, analysisAsOf));
}

function structuredFinancialGaps(
  taxonomy: FinancialStatementTaxonomy | undefined,
  reportingCurrency: string | undefined,
  taggedSixKFacts: readonly ParsedFact[],
  input: FinancialStatementsDeriveInput,
): readonly StructuredFinancialGap[] {
  const gaps: StructuredFinancialGap[] = [];
  if (taxonomy === undefined) {
    gaps.push({
      code: "no-standard-taxonomy",
      message: "No supported us-gaap or ifrs-full standard concepts were available",
      forms: [],
      sourceIds: [input.sourceId],
    });
  }
  if (taxonomy !== undefined && reportingCurrency === undefined) {
    gaps.push({
      code: "no-reporting-currency",
      message: "No reporting currency could be selected for standard monetary statement series",
      forms: [],
      sourceIds: [input.sourceId],
    });
  }
  const untaggedSixK = recentSubmissionSixKFilings(
    input.submissionsPayload,
    input.analysisAsOf,
  ).filter((filing) => !filingHasStructuredFact(filing, taggedSixKFacts));
  if (untaggedSixK.length > 0) {
    gaps.push({
      code: "untagged-6-k",
      message:
        "SEC submissions include 6-K filing evidence without supported structured companyfacts; table extraction is deferred",
      forms: [...new Set(untaggedSixK.map((filing) => filing.form))],
      sourceIds:
        input.submissionsSourceId === undefined ? [input.sourceId] : [input.submissionsSourceId],
    });
  }
  return gaps;
}

function emptySeries(definition: FinancialStatementSeriesDefinition): FinancialStatementSeries {
  return {
    key: definition.key,
    label: definition.label,
    statement: definition.statement,
    annual: [],
    interim: [],
  };
}

function seriesRecord(
  series: readonly FinancialStatementSeries[],
): FinancialStatementsArtifact["statements"] {
  const byKey = Object.fromEntries(series.map((item) => [item.key, item])) as Readonly<
    Record<FinancialStatementSeriesKey, FinancialStatementSeries>
  >;
  const get = (key: FinancialStatementSeriesKey): FinancialStatementSeries =>
    byKey[key] ??
    emptySeries(
      FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find((definition) => definition.key === key)!,
    );
  return {
    incomeStatement: {
      revenue: get("revenue"),
      grossProfit: get("grossProfit"),
      operatingIncome: get("operatingIncome"),
      netIncome: get("netIncome"),
    },
    balanceSheet: {
      cash: get("cash"),
      currentAssets: get("currentAssets"),
      currentLiabilities: get("currentLiabilities"),
      totalAssets: get("totalAssets"),
      totalLiabilities: get("totalLiabilities"),
      stockholdersEquity: get("stockholdersEquity"),
      debt: get("debt"),
    },
    cashFlowStatement: {
      operatingCashFlow: get("operatingCashFlow"),
      capitalExpenditure: get("capitalExpenditure"),
      dividendsPaid: get("dividendsPaid"),
      shareRepurchases: get("shareRepurchases"),
    },
    perShare: { dilutedEps: get("dilutedEps"), dilutedShares: get("dilutedShares") },
  };
}

export function deriveFinancialStatements(
  payload: unknown,
  input: FinancialStatementsDeriveInput,
): FinancialStatementsArtifact {
  const taxonomy = selectTaxonomy(payload, input.analysisAsOf);
  const reportingCurrency =
    taxonomy === undefined
      ? undefined
      : selectReportingCurrency(payload, taxonomy, input.analysisAsOf);
  const selected =
    taxonomy === undefined || reportingCurrency === undefined
      ? FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map(
          (definition) =>
            ({
              series: emptySeries(definition),
              validationNotes: [],
              omissionNotes: [],
            }) satisfies SelectedSeries,
        )
      : FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map((definition) =>
          selectSeries(payload, taxonomy, reportingCurrency, definition, input),
        );
  const equityStackSelection =
    taxonomy === undefined || reportingCurrency === undefined
      ? { validationNotes: [] }
      : selectEquityStack(payload, taxonomy, reportingCurrency, selected, input);
  const { series, notes: capNotes } = capFinancialStatementPeriods(
    selected.map((item) => item.series),
  );
  const otherTaxonomies =
    taxonomy === undefined
      ? []
      : TAXONOMIES.filter(
          (candidate) =>
            candidate !== taxonomy && taxonomyScore(payload, candidate, input.analysisAsOf)[3] > 0,
        );
  const taxonomyNotes: FinancialStatementNote[] =
    otherTaxonomies.length === 0
      ? []
      : [
          {
            code: "mixed-taxonomies",
            message: `Selected ${taxonomy}; excluded standard facts from ${otherTaxonomies.join(", ")}`,
          },
        ];
  return {
    version: 1,
    generatedAt: input.generatedAt,
    analysisAsOf: input.analysisAsOf,
    symbol: input.symbol.toUpperCase(),
    sourceId: input.sourceId,
    ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
    ...(taxonomy !== undefined ? { taxonomy } : {}),
    ...(reportingCurrency !== undefined ? { reportingCurrency } : {}),
    interimCadence: detectFinancialStatementCadence(series),
    extractionMethod: "sec-companyfacts",
    ...(equityStackSelection.equityStack !== undefined
      ? { equityStack: equityStackSelection.equityStack }
      : {}),
    statements: seriesRecord(series),
    validationNotes: [
      ...taxonomyNotes,
      ...equityStackSelection.validationNotes,
      ...selected.flatMap((item) => item.validationNotes),
      ...incompleteFinancialStatementNotes(series),
    ],
    omissionNotes: [...selected.flatMap((item) => item.omissionNotes), ...capNotes],
    structuredFinancialGaps: structuredFinancialGaps(
      taxonomy,
      reportingCurrency,
      supportedSixKFacts(payload, input.analysisAsOf),
      input,
    ),
  };
}

export interface CollectedFinancialStatements {
  readonly statements: FinancialStatementsArtifact | undefined;
  readonly companyFacts: SecCompanyFactsResult;
}

export async function collectFinancialStatements(
  context: CollectContext,
  symbol: string,
): Promise<CollectedFinancialStatements> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  if (facts.factsPayload === undefined || facts.sourceId === undefined) {
    return { statements: undefined, companyFacts: facts };
  }
  const statements = deriveFinancialStatements(facts.factsPayload, {
    symbol,
    generatedAt: context.fetchedAt,
    analysisAsOf: context.fetchedAt,
    sourceId: facts.sourceId,
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts.submissionsPayload !== undefined
      ? { submissionsPayload: facts.submissionsPayload }
      : {}),
    ...(facts.submissionsSourceId !== undefined
      ? { submissionsSourceId: facts.submissionsSourceId }
      : {}),
  });
  return { statements, companyFacts: facts };
}
