import {
  DEBT_CONCEPTS,
  type DebtTaxonomyConcepts,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  SEC_COMPANYFACTS_UNIT_SCALE,
  type FinancialStatementFact,
  type FinancialStatementName,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementTtm,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
  type InterimCadence,
} from "./financial-statements-contract";

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.4368;
const ALIGNMENT_MIN_DAYS = 350;
const ALIGNMENT_MAX_DAYS = 380;
const FY_BOUNDARY_TOLERANCE_DAYS = 10;
// Two facts in one duration bucket can differ by at most twice this; 7 covers 52/53-week years.
const PERIOD_DRIFT_TOLERANCE_DAYS = 7;
// Each limit applies per shape (duration and instant): up to 20 annual and 24 interim keys.
const MAX_ANNUAL_PERIODS_PER_SHAPE = 10;
const MAX_INTERIM_PERIODS_PER_SHAPE = 12;

function daysBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? (endMs - startMs) / DAY_MS
    : undefined;
}

export function financialStatementPeriodMonths(
  fact: Pick<FinancialStatementFact, "periodStart" | "periodEnd">,
): number | undefined {
  if (fact.periodStart === undefined) {
    return undefined;
  }
  const days = daysBetween(fact.periodStart, fact.periodEnd);
  return days !== undefined && days > 0 ? Math.round(days / DAYS_PER_MONTH) : undefined;
}

// Same-end periods share one identity only when their spans differ by filing drift
// (one-day boundaries, 52/53-week years), never when the spans are genuinely different.
// Ponytail: off-canonical spans (a ~350-day stub) never bucket, so one-day drift there
// Still yields two periods. Needs pairwise clustering to fix, and false merges across
// Concepts are worse than a missed dedup; revisit if real filings show the stub case.
export function financialStatementPeriodKey(
  fact: Pick<FinancialStatementFact, "periodStart" | "periodEnd">,
): string {
  if (fact.periodStart === undefined) {
    return `instant|${fact.periodEnd}`;
  }
  const months = financialStatementPeriodMonths(fact);
  const days = daysBetween(fact.periodStart, fact.periodEnd);
  return months === undefined ||
    days === undefined ||
    Math.abs(days - months * DAYS_PER_MONTH) > PERIOD_DRIFT_TOLERANCE_DAYS
    ? `${fact.periodStart}|${fact.periodEnd}`
    : `duration:${String(months)}|${fact.periodEnd}`;
}

function financialStatementDurationDays(fact: FinancialStatementSelectionFact): number {
  return fact.periodStart === undefined ? 0 : (daysBetween(fact.periodStart, fact.periodEnd) ?? 0);
}

export type FinancialStatementSelectionFact = Pick<
  FinancialStatementFact,
  "periodStart" | "periodEnd" | "filedAt" | "amendment" | "accessionNumber"
>;

export function financialStatementSeries(
  artifact: FinancialStatementsArtifact,
): readonly FinancialStatementSeries[] {
  return [
    ...Object.values(artifact.statements.incomeStatement),
    ...Object.values(artifact.statements.balanceSheet),
    ...Object.values(artifact.statements.cashFlowStatement),
    ...Object.values(artifact.statements.perShare),
  ];
}

export function financialStatementSeriesByKey(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
): FinancialStatementSeries | undefined {
  return financialStatementSeries(artifact).find((series) => series.key === key);
}

export function compareFinancialStatementFacts(
  left: FinancialStatementSelectionFact,
  right: FinancialStatementSelectionFact,
): number {
  const leftDurationBucket = financialStatementPeriodMonths(left);
  const rightDurationBucket = financialStatementPeriodMonths(right);
  const durationOrder =
    financialStatementDurationDays(right) - financialStatementDurationDays(left);
  // Bucket-equivalent duration drift is filing noise until filing recency is also tied.
  const bucketDurationOrder =
    leftDurationBucket !== undefined && leftDurationBucket === rightDurationBucket
      ? 0
      : durationOrder;
  return (
    right.periodEnd.localeCompare(left.periodEnd) ||
    bucketDurationOrder ||
    right.filedAt.localeCompare(left.filedAt) ||
    durationOrder ||
    Number(right.amendment) - Number(left.amendment) ||
    (right.accessionNumber ?? "").localeCompare(left.accessionNumber ?? "")
  );
}

export function latestFinancialStatementFact(
  facts: readonly FinancialStatementFact[],
): FinancialStatementFact | undefined {
  return facts.toSorted(compareFinancialStatementFacts).at(0);
}

export function financialStatementFacts(
  series: FinancialStatementSeries,
): readonly FinancialStatementFact[] {
  return [...series.annual, ...series.interim];
}

export interface CompositeStatementContributor {
  readonly value: number;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
}

export function compositeStatementIdentity(
  contributors: readonly CompositeStatementContributor[],
): {
  readonly value: number;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
} {
  const [anchor] = contributors;
  if (anchor === undefined) {
    throw new Error("compositeStatementIdentity requires at least one contributor");
  }
  const accessions = new Set(contributors.map((fact) => fact.accessionNumber));
  const latestFiled = contributors.toSorted((left, right) =>
    right.filedAt.localeCompare(left.filedAt),
  )[0]!;
  return {
    value: contributors.reduce((sum, fact) => sum + fact.value, 0),
    accessionNumber: accessions.size === 1 ? anchor.accessionNumber : null,
    filedAt: latestFiled.filedAt,
  };
}

export interface DebtResolution<T> {
  readonly basis: "total" | "components";
  readonly contributors: readonly { readonly concept: string; readonly fact: T }[];
  readonly incompleteReason?: string;
}

export function recognizedDebtConcepts(taxonomy: FinancialStatementTaxonomy): ReadonlySet<string> {
  const concepts = DEBT_CONCEPTS[taxonomy];
  return new Set([
    ...concepts.totals,
    ...[concepts.current, concepts.noncurrent].flatMap((side) => [
      ...side.generic,
      ...side.instruments.flat(),
    ]),
    ...(concepts.financeLeases === undefined
      ? []
      : [concepts.financeLeases.total, ...concepts.financeLeases.split]),
  ]);
}

export function debtCandidateConcepts(
  taxonomy: FinancialStatementTaxonomy,
  root: Readonly<Record<string, unknown>>,
): readonly string[] {
  const concepts = DEBT_CONCEPTS[taxonomy];
  const pattern = concepts.unrecognizedBorrowing;
  return [
    ...new Set([
      ...recognizedDebtConcepts(taxonomy),
      ...(pattern === undefined
        ? []
        : Object.keys(root).filter((concept) => pattern.test(concept))),
    ]),
  ];
}

export interface DebtHistoryFact {
  readonly concept: string;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly value: number;
}

export interface DebtInstant {
  readonly periodEnd: string;
  readonly filedAt: string;
}

interface DebtSide {
  readonly generic: string | undefined;
  readonly concepts: readonly string[];
  readonly instruments: readonly (readonly string[])[];
}

const DEBT_CONTINUITY_DAYS = 400;

function financeLeaseConcepts(
  concepts: DebtTaxonomyConcepts,
  sides: readonly DebtSide[],
  tagged: ReadonlyMap<string, unknown>,
): { readonly concepts: readonly string[]; readonly incompleteReason?: string } {
  const leases = concepts.financeLeases;
  if (leases === undefined) {
    return { concepts: [] };
  }
  const inclusive = (index: number) =>
    concepts.leaseInclusive?.includes(sides[index]?.generic ?? "") === true;
  const missingLegs = leases.split.filter((leg, index) => !inclusive(index) && !tagged.has(leg));
  const neededLegs = leases.split.filter((_, index) => !inclusive(index));
  if (neededLegs.length === leases.split.length && tagged.has(leases.total)) {
    return { concepts: [leases.total] };
  }
  const taggedLegs = neededLegs.filter((leg) => tagged.has(leg));
  if (taggedLegs.length === 0 && !tagged.has(leases.total)) {
    return { concepts: [] };
  }
  return missingLegs.length === 0
    ? { concepts: taggedLegs }
    : {
        concepts: taggedLegs,
        incompleteReason: `finance leases lack ${missingLegs.join(", ")}`,
      };
}

function coveredDebtConcepts(
  concepts: DebtTaxonomyConcepts,
  sides: readonly DebtSide[],
  leaseConcepts: readonly string[],
): ReadonlySet<string> {
  const leases = concepts.financeLeases;
  const coveredLegs = (leases?.split ?? []).filter(
    (leg, index) =>
      concepts.leaseInclusive?.includes(sides[index]?.generic ?? "") === true ||
      leaseConcepts.includes(leg) ||
      (leases !== undefined && leaseConcepts.includes(leases.total)),
  );
  return new Set([
    ...sides.flatMap((side, index) =>
      side.generic === undefined
        ? side.instruments.filter((group) => group.some((c) => side.concepts.includes(c))).flat()
        : [
            ...(index === 0 ? concepts.current : concepts.noncurrent).generic,
            ...side.instruments.flat(),
          ],
    ),
    ...(sides.every((side) => side.generic !== undefined) ? concepts.totals : []),
    ...coveredLegs,
    ...(leases !== undefined && coveredLegs.length === leases.split.length ? [leases.total] : []),
  ]);
}

// Every debt concept last reported nonzero within the prior year, or earlier for this instant, must be covered.
function omittedDebtConcepts(
  instant: DebtInstant,
  covered: (concept: string) => boolean,
  history: readonly DebtHistoryFact[],
): readonly string[] {
  const earliest = Date.parse(instant.periodEnd) - DEBT_CONTINUITY_DAYS * DAY_MS;
  const latestPrior = new Map<string, DebtHistoryFact>();
  for (const fact of history) {
    const existing = latestPrior.get(fact.concept);
    const prior =
      fact.periodEnd < instant.periodEnd ||
      (fact.periodEnd === instant.periodEnd && fact.filedAt < instant.filedAt);
    if (
      prior &&
      (existing === undefined ||
        fact.periodEnd > existing.periodEnd ||
        (fact.periodEnd === existing.periodEnd && fact.filedAt > existing.filedAt))
    ) {
      latestPrior.set(fact.concept, fact);
    }
  }
  return [...latestPrior.values()]
    .filter(
      (fact) =>
        fact.value !== 0 && Date.parse(fact.periodEnd) >= earliest && !covered(fact.concept),
    )
    .map((fact) => fact.concept)
    .toSorted();
}

function incompleteDebtReason(
  taxonomy: FinancialStatementTaxonomy,
  instant: DebtInstant,
  sides: readonly DebtSide[],
  leases: { readonly concepts: readonly string[]; readonly incompleteReason?: string },
  tagged: ReadonlyMap<string, unknown>,
  history: readonly DebtHistoryFact[],
): string | undefined {
  const recognized = recognizedDebtConcepts(taxonomy);
  const unrecognized = [...tagged.keys()].filter((concept) => !recognized.has(concept));
  if (unrecognized.length > 0) {
    return `unrecognized borrowing concepts are tagged: ${unrecognized.join(", ")}`;
  }
  const borrowings = sides.flatMap((side) => side.concepts);
  if (borrowings.length === 0) {
    return "no borrowing line item is tagged";
  }
  if (leases.incompleteReason !== undefined) {
    return leases.incompleteReason;
  }
  const covered = coveredDebtConcepts(DEBT_CONCEPTS[taxonomy], sides, leases.concepts);
  const leaseConcepts = new Set(Object.values(DEBT_CONCEPTS[taxonomy].financeLeases ?? {}).flat());
  // Two generic side lines are the classified debt totals, so prior footnote borrowings are constituents.
  const bothGeneric = sides.every((side) => side.generic !== undefined);
  const omitted = omittedDebtConcepts(
    instant,
    (concept) => covered.has(concept) || (bothGeneric && !leaseConcepts.has(concept)),
    history,
  );
  return omitted.length > 0
    ? `omits ${omitted.join(", ")}, reported nonzero within the prior year or earlier for this instant`
    : undefined;
}

// Shared by legacy SEC metrics and canonical statements; `tagged` holds one fact per concept at one instant.
export function resolveDebtAtInstant<T>(
  taxonomy: FinancialStatementTaxonomy,
  instant: DebtInstant,
  tagged: ReadonlyMap<string, T>,
  history: readonly DebtHistoryFact[],
): DebtResolution<T> {
  const concepts = DEBT_CONCEPTS[taxonomy];
  const first = (aliases: readonly string[]) => aliases.find((alias) => tagged.has(alias));
  const contributor = (concept: string) => ({ concept, fact: tagged.get(concept) as T });
  const total = first(concepts.totals);
  if (total !== undefined) {
    return { basis: "total", contributors: [contributor(total)] };
  }
  const sides = [concepts.current, concepts.noncurrent].map((side) => {
    const generic = first(side.generic);
    return {
      generic,
      instruments: side.instruments,
      concepts:
        generic === undefined
          ? side.instruments.flatMap((aliases) => first(aliases) ?? [])
          : [generic],
    };
  });
  const leases = financeLeaseConcepts(concepts, sides, tagged);
  const incompleteReason = incompleteDebtReason(taxonomy, instant, sides, leases, tagged, history);
  return {
    basis: "components",
    contributors: [...sides.flatMap((side) => side.concepts), ...leases.concepts].map((concept) =>
      contributor(concept),
    ),
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
  };
}

// A later filing's incomplete resolution of an instant supersedes earlier complete ones (partial amendments).
export function unsupersededDebtResolutions<
  R extends { readonly periodEnd: string; readonly filedAt: string; readonly incomplete: boolean },
>(resolved: readonly R[]): readonly R[] {
  return resolved.filter(
    (entry) =>
      !resolved.some(
        (other) =>
          other.incomplete && other.periodEnd === entry.periodEnd && other.filedAt > entry.filedAt,
      ),
  );
}

export function incompleteDebtNote(periodEnd: string, reason: string): FinancialStatementNote {
  return {
    code: "incomplete-composite-series",
    seriesKey: "debt",
    message: `Debt composite for ${periodEnd} is incomplete: ${reason}.`,
  };
}

export function financialStatementFactForPeriod(
  facts: readonly FinancialStatementFact[],
  periodKey: string,
  periodType: FinancialStatementFact["periodType"],
): FinancialStatementFact | undefined {
  return latestFinancialStatementFact(
    facts.filter((fact) => fact.periodKey === periodKey && fact.periodType === periodType),
  );
}

export function financialStatementFactsAreCompatible(
  facts: readonly FinancialStatementFact[],
): boolean {
  const [first] = facts;
  return (
    first !== undefined &&
    facts.every(
      (fact) =>
        fact.currency === first.currency &&
        fact.unit === first.unit &&
        fact.unitScale === first.unitScale,
    )
  );
}

export function financialStatementTtmsSharePeriod(
  values: readonly FinancialStatementTtm[],
): boolean {
  const [first] = values;
  return (
    first !== undefined &&
    values.every(
      (value) => value.periodStart === first.periodStart && value.periodEnd === first.periodEnd,
    )
  );
}

export function financialStatementTtmsAreCompatible(
  values: readonly FinancialStatementTtm[],
): boolean {
  const [first] = values;
  return (
    first !== undefined &&
    financialStatementTtmsSharePeriod(values) &&
    values.every(
      (value) =>
        value.currency === first.currency &&
        value.unit === first.unit &&
        value.unitScale === first.unitScale,
    )
  );
}

function latestCommonFinancialStatementFactsBy(
  series: readonly (FinancialStatementSeries | undefined)[],
  matches: (fact: FinancialStatementFact, candidate: FinancialStatementFact) => boolean,
): readonly FinancialStatementFact[] | undefined {
  if (series.length === 0 || series.some((item) => item === undefined)) {
    return undefined;
  }
  const available = series as readonly FinancialStatementSeries[];
  // Candidates come only from series[0]; argument order is semantically load-bearing.
  // The first series defines the periods the remaining series may match.
  const candidates = financialStatementFacts(available[0]!);
  const common = candidates.flatMap((candidate): readonly FinancialStatementFact[][] => {
    const facts = available.map((item) =>
      latestFinancialStatementFact(
        financialStatementFacts(item).filter((fact) => matches(fact, candidate)),
      ),
    );
    if (
      facts.some((fact) => fact === undefined) ||
      !financialStatementFactsAreCompatible(facts as readonly FinancialStatementFact[])
    ) {
      return [];
    }
    return [[...(facts as readonly FinancialStatementFact[])]];
  });
  return common.toSorted((left, right) => compareFinancialStatementFacts(left[0]!, right[0]!))[0];
}

export function latestCommonFinancialStatementFacts(
  series: readonly (FinancialStatementSeries | undefined)[],
): readonly FinancialStatementFact[] | undefined {
  // PeriodType is part of period identity: an interim 12-month fact can share a
  // Duration bucket and period end with the annual fact from the same filer.
  return latestCommonFinancialStatementFactsBy(
    series,
    (fact, candidate) =>
      fact.periodKey === candidate.periodKey && fact.periodType === candidate.periodType,
  );
}

export function latestCommonFinancialStatementPeriodEndFacts(
  series: readonly (FinancialStatementSeries | undefined)[],
): readonly FinancialStatementFact[] | undefined {
  return latestCommonFinancialStatementFactsBy(
    series,
    (fact, candidate) => fact.periodEnd === candidate.periodEnd,
  );
}

export function isYearAligned(prior: string, latest: string): boolean {
  const days = daysBetween(prior, latest);
  return days !== undefined && days >= ALIGNMENT_MIN_DAYS && days <= ALIGNMENT_MAX_DAYS;
}

export function financialStatementPeriodsYearAligned(
  prior: FinancialStatementFact,
  latest: FinancialStatementFact,
): boolean {
  if (prior.periodStart === undefined || latest.periodStart === undefined) {
    return false;
  }
  return (
    isYearAligned(prior.periodStart, latest.periodStart) &&
    isYearAligned(prior.periodEnd, latest.periodEnd)
  );
}

export function deriveFinancialStatementTtm(
  definition: FinancialStatementSeriesDefinition,
  annual: readonly FinancialStatementFact[],
  interim: readonly FinancialStatementFact[],
  currency: string,
): { readonly ttm?: FinancialStatementTtm; readonly note?: FinancialStatementNote } {
  if (!definition.deriveTtm || annual.length === 0) {
    return {};
  }
  const fiscalYear = latestFinancialStatementFact(annual)!;
  const latestYearToDate = latestFinancialStatementFact(
    interim.filter(
      (fact) => fact.periodStart !== undefined && fact.periodEnd > fiscalYear.periodEnd,
    ),
  );
  if (latestYearToDate === undefined || latestYearToDate.periodStart === undefined) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "No complete post-FY interim duration fact is available",
      },
    };
  }
  const latestMonths = financialStatementPeriodMonths(latestYearToDate);
  const priorYearToDate = latestFinancialStatementFact(
    interim.filter(
      (fact) =>
        fact.periodStart !== undefined &&
        fact.periodEnd < fiscalYear.periodEnd &&
        financialStatementPeriodMonths(fact) === latestMonths &&
        isYearAligned(fact.periodStart, latestYearToDate.periodStart!) &&
        isYearAligned(fact.periodEnd, latestYearToDate.periodEnd),
    ),
  );
  if (priorYearToDate === undefined || priorYearToDate.periodStart === undefined) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "No aligned prior-year interim duration fact is available",
      },
    };
  }
  const startAlignment = Math.abs(
    daysBetween(fiscalYear.periodStart ?? "", priorYearToDate.periodStart) ?? Infinity,
  );
  const boundaryAlignment = Math.abs(
    daysBetween(fiscalYear.periodEnd, latestYearToDate.periodStart) ?? Infinity,
  );
  if (
    fiscalYear.periodStart === undefined ||
    startAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    boundaryAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    priorYearToDate.periodEnd >= fiscalYear.periodEnd
  ) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "FY/latest-YTD/prior-YTD periods do not reconcile at the fiscal-year boundary",
      },
    };
  }
  if (
    !financialStatementFactsAreCompatible([fiscalYear, latestYearToDate, priorYearToDate]) ||
    fiscalYear.currency !== currency
  ) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "FY/latest-YTD/prior-YTD facts do not use compatible units and currency",
      },
    };
  }
  const sourceIds = [
    ...new Set([
      ...fiscalYear.sourceIds,
      ...latestYearToDate.sourceIds,
      ...priorYearToDate.sourceIds,
    ]),
  ];
  return {
    ttm: {
      value: fiscalYear.value + latestYearToDate.value - priorYearToDate.value,
      periodStart: new Date(Date.parse(priorYearToDate.periodEnd) + DAY_MS)
        .toISOString()
        .slice(0, 10),
      periodEnd: latestYearToDate.periodEnd,
      currency,
      unit: fiscalYear.unit,
      unitScale: SEC_COMPANYFACTS_UNIT_SCALE,
      extractionMethod: "derived-sec-companyfacts",
      formula: "FY + latest-YTD - prior-YTD",
      sourceIds,
      components: { fiscalYear, latestYearToDate, priorYearToDate },
    },
  };
}

export function detectFinancialStatementCadence(
  series: readonly FinancialStatementSeries[],
): InterimCadence {
  const annualCount = series.reduce((count, item) => count + item.annual.length, 0);
  const interim = series.flatMap((item) => item.interim);
  if (interim.length === 0) {
    return annualCount > 0 ? "annual-only" : "unknown";
  }
  if (interim.some((fact) => fact.canonicalForm === "10-Q")) {
    return "quarterly";
  }
  const fiscalPeriods = new Set(interim.map((fact) => fact.fiscalPeriod.toUpperCase()));
  if ([...fiscalPeriods].some((period) => /^Q[1-4]$/u.test(period))) {
    return "quarterly";
  }
  if ([...fiscalPeriods].some((period) => /^(?:H[12]|HY|S[12])$/u.test(period))) {
    return "semiannual";
  }
  const durationMonths = interim.flatMap((fact) => {
    const months = financialStatementPeriodMonths(fact);
    return months === undefined ? [] : [months];
  });
  if (durationMonths.length === 0) {
    return "irregular";
  }
  if (durationMonths.some((months) => months >= 2 && months <= 4)) {
    return "quarterly";
  }
  if (durationMonths.every((months) => months >= 5 && months <= 7)) {
    return "semiannual";
  }
  return "irregular";
}

export function incompleteFinancialStatementNotes(
  series: readonly FinancialStatementSeries[],
): readonly FinancialStatementNote[] {
  const required: Readonly<Record<FinancialStatementName, readonly FinancialStatementSeriesKey[]>> =
    {
      incomeStatement: ["revenue", "operatingIncome", "netIncome"],
      balanceSheet: ["cash", "totalAssets", "totalLiabilities", "stockholdersEquity"],
      cashFlowStatement: ["operatingCashFlow"],
      perShare: ["dilutedEps"],
    };
  const notes: FinancialStatementNote[] = [];
  for (const period of ["annual", "interim"] as const) {
    const periodFacts = new Map<string, FinancialStatementFact>();
    const checkedBalancePeriodEnds = new Set<string>();
    for (const fact of series.flatMap((item) => item[period])) {
      periodFacts.set(fact.periodKey, fact);
    }
    for (const [canonicalPeriodKey, anchor] of [...periodFacts.entries()].toSorted(
      (left, right) =>
        left[1].periodEnd.localeCompare(right[1].periodEnd) || left[0].localeCompare(right[0]),
    )) {
      const statements = (
        anchor.periodStart === undefined
          ? []
          : Object.entries(required).filter(([statement]) => statement !== "balanceSheet")
      ) as readonly [FinancialStatementName, readonly FinancialStatementSeriesKey[]][];
      for (const [statement, keys] of statements) {
        const missing = keys.filter((key) => {
          const facts = series.find((item) => item.key === key)?.[period] ?? [];
          return !facts.some((fact) => fact.periodKey === canonicalPeriodKey);
        });
        if (missing.length > 0) {
          notes.push({
            code: "incomplete-statement",
            periodKey: `${period}|${canonicalPeriodKey}`,
            message: `${statement} ${period} period ${canonicalPeriodKey} is missing ${missing.join(", ")}`,
          });
        }
      }
      if (checkedBalancePeriodEnds.has(anchor.periodEnd)) {
        continue;
      }
      checkedBalancePeriodEnds.add(anchor.periodEnd);
      const missingBalance = required.balanceSheet.filter((key) => {
        const facts = series.find((item) => item.key === key)?.[period] ?? [];
        return !facts.some((fact) => fact.periodEnd === anchor.periodEnd);
      });
      if (missingBalance.length > 0) {
        notes.push({
          code: "incomplete-statement",
          periodKey: `${period}|${canonicalPeriodKey}`,
          message: `balanceSheet ${period} period ${canonicalPeriodKey} is missing ${missingBalance.join(", ")}`,
        });
      }
    }
  }
  return notes;
}

export function capFinancialStatementPeriods(series: readonly FinancialStatementSeries[]): {
  readonly series: readonly FinancialStatementSeries[];
  readonly notes: readonly FinancialStatementNote[];
} {
  const limits = {
    annual: MAX_ANNUAL_PERIODS_PER_SHAPE,
    interim: MAX_INTERIM_PERIODS_PER_SHAPE,
  } as const;
  const allowed = new Map<
    "annual" | "interim",
    Readonly<Record<"duration" | "instant", ReadonlySet<string>>>
  >();
  const notes: FinancialStatementNote[] = [];
  for (const period of ["annual", "interim"] as const) {
    const allowedByShape = { duration: new Set<string>(), instant: new Set<string>() };
    for (const shape of ["duration", "instant"] as const) {
      const periodFacts = new Map<string, FinancialStatementFact>();
      for (const fact of series.flatMap((item) => item[period])) {
        if ((fact.periodStart === undefined ? "instant" : "duration") === shape) {
          periodFacts.set(fact.periodKey, fact);
        }
      }
      const periodKeys = [...periodFacts.entries()]
        .toSorted(
          (left, right) =>
            left[1].periodEnd.localeCompare(right[1].periodEnd) ||
            (left[1].periodStart ?? "").localeCompare(right[1].periodStart ?? "") ||
            left[0].localeCompare(right[0]),
        )
        .map(([key]) => key);
      const omitted = periodKeys.slice(0, -limits[period]);
      allowedByShape[shape] = new Set(periodKeys.slice(-limits[period]));
      for (const periodKey of omitted) {
        notes.push({
          code: "history-cap",
          periodKey: `${period}|${periodKey}`,
          message: `Older ${period} ${shape} canonical period ${periodKey} omitted by the ${String(limits[period])}-period ${period} ${shape} cap`,
        });
      }
    }
    allowed.set(period, allowedByShape);
  }
  const keep = (period: "annual" | "interim", fact: FinancialStatementFact): boolean => {
    const periods = allowed.get(period)!;
    const shape = fact.periodStart === undefined ? "instant" : "duration";
    return periods[shape].has(fact.periodKey);
  };
  return {
    series: series.map((item) => ({
      ...item,
      annual: item.annual.filter((fact) => keep("annual", fact)),
      interim: item.interim.filter((fact) => keep("interim", fact)),
    })),
    notes,
  };
}
