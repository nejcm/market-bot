import {
  CAP_FOLLOWER_SERIES,
  DEBT_CONCEPTS,
  type DebtTaxonomyConcepts,
  type FinancialStatementSeriesDefinition,
  US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT,
} from "./financial-statement-definitions";
import {
  SEC_COMPANYFACTS_UNIT_SCALE,
  type FinancialStatementFact,
  type FinancialStatementName,
  type FinancialStatementNote,
  type OriginalFiling,
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
  // A same-end, same-bucket fact is one period: its latest revision wins even when an amendment shifts the start.
  return (
    right.periodEnd.localeCompare(left.periodEnd) ||
    bucketDurationOrder ||
    compareFinancialStatementRevisions(left, right) ||
    durationOrder
  );
}

// Revisions of one period: latest filing, then amendment, then accession; never duration first.
export function compareFinancialStatementRevisions(
  left: FinancialStatementSelectionFact,
  right: FinancialStatementSelectionFact,
): number {
  return (
    right.filedAt.localeCompare(left.filedAt) ||
    Number(right.amendment) - Number(left.amendment) ||
    (right.accessionNumber ?? "").localeCompare(left.accessionNumber ?? "")
  );
}

// The original filing's value when a later filing (or same-day amendment) replaced it; same-day original filings tie.
export function restatedFromOriginalFiling(
  selectedValue: number,
  history: readonly (OriginalFiling & { readonly amendment?: boolean })[],
): OriginalFiling | undefined {
  const [earliest] = history.toSorted((left, right) => left.filedAt.localeCompare(right.filedAt));
  const sameDay = history.filter((fact) => fact.filedAt === earliest?.filedAt);
  const unamended = sameDay.filter((fact) => fact.amendment !== true);
  const originals = unamended.length === 0 ? sameDay : unamended;
  const [original] = originals;
  return original === undefined ||
    originals.length === history.length ||
    originals.some((fact) => fact.value === selectedValue)
    ? undefined
    : { value: original.value, filedAt: original.filedAt };
}

export function earlierShareBasisPeriods(
  notes: readonly FinancialStatementNote[],
  key: FinancialStatementSeriesKey,
): ReadonlySet<string> {
  return new Set(
    notes
      .filter((note) => note.code === "earlier-share-basis" && note.seriesKey === key)
      .map((note) => note.periodKey ?? ""),
  );
}

// Comparisons are allowed only among periods confirmed on the latest share basis.
export function touchesEarlierShareBasis(
  facts: readonly Pick<FinancialStatementFact, "periodKey">[],
  earlier: ReadonlySet<string>,
): boolean {
  return facts.some((fact) => earlier.has(fact.periodKey));
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
  readonly contributors: readonly {
    readonly concept: string;
    readonly fact: T;
    readonly subtract?: true;
  }[];
  readonly incompleteReason?: string;
  readonly leaseInclusive?: readonly string[];
  // Classified carrying lines, or a LongTermDebt total that reconciles to them, are one scope across bases (NVDA).
  readonly lineScope?: true;
}

export function debtIdentityConcepts(taxonomy: FinancialStatementTaxonomy): readonly string[] {
  const identity = DEBT_CONCEPTS[taxonomy].ambiguousLongTermDebt?.noncurrentIdentity;
  return identity === undefined
    ? []
    : [identity.noncurrentTotal, identity.total, identity.currentTotal, ...identity.others];
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
    ...Object.keys(concepts.umbrellas ?? {}),
    ...(concepts.constituents ?? []),
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
  readonly amendment?: boolean;
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

interface LeaseAdjustment {
  readonly subtracted: readonly string[];
  readonly unadjusted: readonly string[];
  readonly deductions: readonly {
    readonly aggregates: readonly string[];
    readonly leases: readonly string[];
  }[];
}

// Debt is borrowing-based: a lease-inclusive aggregate loses the matching finance lease tagged beside it.
function leaseAdjustment(
  concepts: DebtTaxonomyConcepts,
  used: readonly string[],
  isTagged: (concept: string) => boolean,
  legsTieToTotal = false,
): LeaseAdjustment {
  const leases = concepts.financeLeases;
  const inclusive = used.filter((concept) => concepts.leaseInclusive?.[concept] !== undefined);
  if (leases === undefined) {
    return { subtracted: [], unadjusted: inclusive, deductions: [] };
  }
  const splitLeases = leases.split.every((leg) => isTagged(leg)) ? leases.split : [];
  const totalLeases = isTagged(leases.total) ? [leases.total] : splitLeases;
  const deductions: { aggregates: readonly string[]; leases: readonly string[] }[] = [];
  const pending: string[] = [];
  for (const concept of inclusive) {
    const scope = concepts.leaseInclusive?.[concept];
    const leg = leases.split[scope === "current" ? 0 : 1];
    const legLeases = leg !== undefined && isTagged(leg) ? [leg] : [];
    const match = scope === "total" ? totalLeases : legLeases;
    if (match.length > 0) {
      deductions.push({ aggregates: [concept], leases: match });
    } else {
      pending.push(concept);
    }
  }
  // One lease total spans both legs only when they tie to a lease-inclusive total (VSAT); else its split is unknown.
  if (pending.length === 2 && isTagged(leases.total) && legsTieToTotal) {
    deductions.push({ aggregates: [...pending], leases: [leases.total] });
    pending.length = 0;
  }
  return {
    subtracted: [...new Set(deductions.flatMap((deduction) => deduction.leases))],
    unadjusted: pending,
    deductions,
  };
}

// `expression` is a selected debt concept, e.g. `DebtCurrent+LongTermDebtNoncurrent-FinanceLeaseLiabilityCurrent`.
export function unadjustedLeaseInclusiveDebt(
  taxonomy: FinancialStatementTaxonomy,
  expression: string,
): readonly string[] {
  const terms = expression.match(/[+-]?[^+-]+/gu) ?? [];
  const subtracted = new Set(
    terms.filter((term) => term.startsWith("-")).map((term) => term.slice(1)),
  );
  const used = terms
    .filter((term) => !term.startsWith("-"))
    .map((term) => term.replace(/^\+/u, ""));
  return leaseAdjustment(DEBT_CONCEPTS[taxonomy], used, (concept) => subtracted.has(concept))
    .unadjusted;
}

function classifiedDebtLines(concepts: DebtTaxonomyConcepts): ReadonlySet<string> {
  return new Set([
    ...[concepts.current, concepts.noncurrent].flatMap((side) => [
      ...side.generic,
      ...side.instruments.flat(),
    ]),
    ...Object.entries(concepts.umbrellas ?? {}).flat(2),
  ]);
}

function coveredDebtConcepts(
  concepts: DebtTaxonomyConcepts,
  sides: readonly DebtSide[],
  usedUmbrellas: readonly string[],
  isTagged: (concept: string) => boolean,
): ReadonlySet<string> {
  const covered = new Set([
    ...sides.flatMap((side, index) =>
      side.generic === undefined
        ? side.instruments.filter((group) => group.some((c) => side.concepts.includes(c))).flat()
        : [
            ...(index === 0 ? concepts.current : concepts.noncurrent).generic,
            ...side.instruments.flat(),
          ],
    ),
    ...(sides.every((side) => side.generic !== undefined) ? concepts.totals : []),
    ...Object.values(concepts.financeLeases ?? {}).flat(),
    ...usedUmbrellas.flatMap((umbrella) => [umbrella, ...(concepts.umbrellas?.[umbrella] ?? [])]),
    ...(sides[1]?.generic === undefined ? [] : (concepts.constituents ?? [])),
  ]);
  for (const [umbrella, legs] of Object.entries(concepts.umbrellas ?? {})) {
    if (
      legs.every((leg) => covered.has(leg)) ||
      (isTagged(umbrella) && legs.some((leg) => isTagged(leg)))
    ) {
      covered.add(umbrella);
    }
  }
  return covered;
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
  usedUmbrellas: readonly string[],
  tagged: ReadonlyMap<string, unknown>,
  history: readonly DebtHistoryFact[],
): string | undefined {
  const recognized = recognizedDebtConcepts(taxonomy);
  const unrecognized = [...tagged.keys()].filter((concept) => !recognized.has(concept));
  if (unrecognized.length > 0) {
    return `unrecognized borrowing concepts are tagged: ${unrecognized.join(", ")}`;
  }
  if (usedUmbrellas.length === 0 && sides.every((side) => side.concepts.length === 0)) {
    return "no borrowing line item is tagged";
  }
  const covered = coveredDebtConcepts(DEBT_CONCEPTS[taxonomy], sides, usedUmbrellas, (concept) =>
    tagged.has(concept),
  );
  // Two generic side lines are the classified debt totals, so prior footnote borrowings are constituents.
  const bothGeneric = sides.every((side) => side.generic !== undefined);
  const omitted = omittedDebtConcepts(
    instant,
    (concept) => covered.has(concept) || bothGeneric,
    history,
  );
  return omitted.length > 0
    ? `omits ${omitted.join(", ")}, reported nonzero within the prior year or earlier for this instant`
    : undefined;
}

const sumValues = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);

// A restated component sums only as a single-filing reclassification that keeps the original total.
function restatedDebtComponentReason<T>(
  instant: DebtInstant,
  used: readonly string[],
  tagged: ReadonlyMap<string, T>,
  history: readonly DebtHistoryFact[],
  valueOf: (fact: T) => number,
): string | undefined {
  const components = used.map((concept) => {
    const value = valueOf(tagged.get(concept) as T);
    const filings = history.filter(
      (fact) => fact.concept === concept && fact.periodEnd === instant.periodEnd,
    );
    const original = restatedFromOriginalFiling(value, filings);
    const filedAt = filings
      .map((fact) => fact.filedAt)
      .toSorted()
      .at(-1);
    return { concept, value, original, filedAt };
  });
  const restated = components.filter((component) => component.original !== undefined);
  const singleFiling = new Set(components.map((component) => component.filedAt)).size === 1;
  if (
    restated.length === 0 ||
    (singleFiling &&
      sumValues(components.map((component) => component.original?.value ?? component.value)) ===
        sumValues(components.map((component) => component.value)))
  ) {
    return undefined;
  }
  return `a later filing restated ${restated.map(({ concept, original }) => `${concept} (originally ${String(original?.value)}, filed ${original?.filedAt ?? ""})`).join(", ")} without restating a debt total`;
}

type LongTermDebtUse = "line" | "total" | "line-without-current";

// LongTermDebt's scope is read only from its own filing's lines; `currentElsewhere` is nonzero current debt in any filing.
function longTermDebtUse(
  concepts: DebtTaxonomyConcepts,
  value: (concept: string) => number | undefined,
  currentElsewhere: boolean,
  [current, noncurrent]: readonly DebtSide[],
): LongTermDebtUse | { readonly reason: string } {
  const ambiguous = concepts.ambiguousLongTermDebt;
  const longTermDebt = ambiguous === undefined ? undefined : value(ambiguous.concept);
  if (ambiguous === undefined || longTermDebt === undefined) {
    return "line";
  }
  const sum = (names: readonly string[]) =>
    names.reduce((acc, name) => acc + (value(name) ?? 0), 0);
  const asNoncurrentGeneric = noncurrent?.generic === ambiguous.concept;
  const noncurrentLines = asNoncurrentGeneric
    ? noncurrent.instruments.flatMap(
        (aliases) => aliases.find((alias) => value(alias) !== undefined) ?? [],
      )
    : (noncurrent?.concepts ?? []);
  const currentLines = current?.concepts ?? [];
  const currentSum = sum(currentLines);
  if (noncurrentLines.length === 0) {
    if (currentSum === 0 && !currentElsewhere) {
      return "total";
    }
    const identity = ambiguous.noncurrentIdentity;
    const total = value(identity.total);
    const currentTotal = value(identity.currentTotal);
    const noncurrentTotal =
      value(identity.noncurrentTotal) ??
      (total === undefined || currentTotal === undefined ? undefined : total - currentTotal);
    return longTermDebt !== 0 &&
      currentSum !== 0 &&
      noncurrentTotal === longTermDebt + sum(identity.others)
      ? "line"
      : {
          reason: `${ambiguous.concept} is tagged beside nonzero current debt (${currentLines.join(", ")}) without a noncurrent line or total that establishes whether it includes current maturities`,
        };
  }
  const noncurrentSum = sum(noncurrentLines);
  if (longTermDebt === noncurrentSum) {
    return "line";
  }
  if (currentSum !== 0 && longTermDebt === currentSum + noncurrentSum) {
    return "total";
  }
  const maturities = value(ambiguous.current);
  if (
    asNoncurrentGeneric &&
    maturities !== undefined &&
    maturities !== 0 &&
    longTermDebt === maturities + noncurrentSum
  ) {
    return "line-without-current";
  }
  // Explicit lines define the total; LongTermDebt may sit at principal (Apple), so only a contradiction refuses them.
  if (
    !asNoncurrentGeneric &&
    longTermDebt >= noncurrentSum &&
    longTermDebt <= currentSum + noncurrentSum
  ) {
    return "line";
  }
  return {
    reason: `${ambiguous.concept} (${String(longTermDebt)}) reconciles to none of the tagged lines (${[...currentLines, ...noncurrentLines].join(", ")})`,
  };
}

// Shared by legacy SEC metrics and canonical statements; `tagged` holds one fact per concept at one instant.
export function resolveDebtAtInstant<T>(
  taxonomy: FinancialStatementTaxonomy,
  instant: DebtInstant,
  tagged: ReadonlyMap<string, T>,
  history: readonly DebtHistoryFact[],
  valueOf: (fact: T) => number,
  filedAtOf: (fact: T) => string,
  principal: {
    readonly dueWithinYear?: number;
    readonly total?: number;
    readonly unamortized?: number;
  } = {},
  liabilities: readonly DebtHistoryFact[] = [],
): DebtResolution<T> {
  const concepts = DEBT_CONCEPTS[taxonomy];
  const contributor = (concept: string) => ({ concept, fact: tagged.get(concept) as T });
  const ambiguous = concepts.ambiguousLongTermDebt;
  const sidesOf = (has: (concept: string) => boolean) => {
    const firstOf = (aliases: readonly string[]) => aliases.find(has);
    const shortTermOf = ambiguous === undefined ? undefined : firstOf(ambiguous.shortTerm);
    return [concepts.current, concepts.noncurrent].map((side) => {
      const generic = firstOf(side.generic);
      return {
        generic,
        instruments: side.instruments,
        concepts:
          generic === undefined
            ? side.instruments.flatMap((aliases) => firstOf(aliases) ?? [])
            : [
                generic,
                // Added beside maturities; `unprovenCurrent` gaps it unless DebtCurrent sums both (commercial paper excepted).
                ...(generic === ambiguous?.current && shortTermOf !== undefined
                  ? [shortTermOf]
                  : []),
              ],
      };
    });
  };
  const first = (aliases: readonly string[]) => aliases.find((alias) => tagged.has(alias));
  const sides = sidesOf((concept) => tagged.has(concept));
  const umbrellas = Object.entries(concepts.umbrellas ?? {})
    .filter(([umbrella, legs]) => tagged.has(umbrella) && !legs.some((leg) => tagged.has(leg)))
    .map(([umbrella]) => umbrella);
  const mismatched = Object.entries(concepts.umbrellas ?? {})
    .filter(([umbrella, legs]) => {
      const tagLegs = legs.filter((leg) => tagged.has(leg));
      const umbrellaValue = tagged.has(umbrella) ? valueOf(tagged.get(umbrella) as T) : 0;
      const legSum = tagLegs.reduce((acc, leg) => acc + valueOf(tagged.get(leg) as T), 0);
      return (
        tagged.has(umbrella) &&
        tagLegs.length > 0 &&
        Math.abs(umbrellaValue - legSum) > 1e-9 * Math.max(1, Math.abs(umbrellaValue))
      );
    })
    .map(([umbrella]) => umbrella);
  const overlap = sides.some((side) => side.generic !== undefined)
    ? umbrellas.filter((umbrella) => valueOf(tagged.get(umbrella) as T) !== 0)
    : [];
  const usedUmbrellas = overlap.length > 0 ? [] : umbrellas;
  const valueAt = (concept: string) =>
    tagged.has(concept) ? valueOf(tagged.get(concept) as T) : undefined;
  const longTermDebtFact = ambiguous === undefined ? undefined : tagged.get(ambiguous.concept);
  const longTermDebtFiledAt =
    longTermDebtFact === undefined ? undefined : filedAtOf(longTermDebtFact);
  const longTermDebtFiling = new Map(
    [...tagged].flatMap(([concept, fact]) =>
      filedAtOf(fact) === longTermDebtFiledAt ? [[concept, valueOf(fact)] as const] : [],
    ),
  );
  for (const fact of [...history, ...liabilities]) {
    if (
      fact.periodEnd === instant.periodEnd &&
      fact.filedAt === longTermDebtFiledAt &&
      !longTermDebtFiling.has(fact.concept)
    ) {
      longTermDebtFiling.set(fact.concept, fact.value);
    }
  }
  const scopeSides = sidesOf((concept) => longTermDebtFiling.has(concept));
  const longTermDebt = longTermDebtUse(
    concepts,
    (concept) => longTermDebtFiling.get(concept),
    (sides[0]?.concepts ?? []).some((concept) => valueAt(concept) !== 0),
    scopeSides,
  );
  const restatedScope =
    longTermDebt === "total"
      ? scopeSides
          .flatMap((side) => side.concepts)
          .filter((concept) => valueAt(concept) !== longTermDebtFiling.get(concept))
      : [];
  const filedTotal = first(
    ambiguous !== undefined &&
      longTermDebt === "total" &&
      restatedScope.length === 0 &&
      (scopeSides[0]?.concepts ?? []).some((concept) => longTermDebtFiling.get(concept) !== 0)
      ? // A total that reconciles to its filing's lines is carrying basis; Combined can be principal (AVGO).
        [ambiguous.concept, ...concepts.totals]
      : concepts.totals.filter(
          (concept) => concept !== ambiguous?.concept || longTermDebt === "total",
        ),
  );
  const legs = filedTotal === undefined ? undefined : concepts.totalLegs?.[filedTotal];
  const legLines =
    legs !== undefined &&
    legs.every((leg) => tagged.has(leg)) &&
    principal.unamortized !== undefined &&
    principal.unamortized !== 0 &&
    (valueAt(filedTotal ?? "") ?? 0) - legs.reduce((acc, leg) => acc + (valueAt(leg) ?? 0), 0) ===
      principal.unamortized
      ? legs
      : undefined;
  const total = legLines === undefined ? filedTotal : undefined;
  const used =
    total === undefined
      ? (legLines ?? [...sides.flatMap((side) => side.concepts), ...usedUmbrellas]).filter(
          (concept) => longTermDebt !== "line-without-current" || concept !== ambiguous?.current,
        )
      : [total];
  const { subtracted, unadjusted, deductions } = leaseAdjustment(
    concepts,
    used,
    (concept) => tagged.has(concept),
    legLines !== undefined,
  );
  const unsplitLease =
    unadjusted.length === 2 &&
    concepts.financeLeases !== undefined &&
    (valueAt(concepts.financeLeases.total) ?? 0) !== 0
      ? `${concepts.financeLeases.total} is tagged only as a total, so its split across ${unadjusted.join(", ")} is unknown`
      : undefined;
  const sum = (names: readonly string[]) =>
    names.reduce((acc, name) => acc + valueOf(tagged.get(name) as T), 0);
  const excess = deductions.find(({ aggregates, leases }) => sum(leases) > sum(aggregates));
  const componentReason = (() => {
    if (total !== undefined) {
      return undefined;
    }
    if (mismatched.length > 0) {
      return `${mismatched.join(", ")} differs from the sum of its tagged legs`;
    }
    if (overlap.length > 0) {
      return `${overlap.join(", ")} may overlap a generic long-term-debt line`;
    }
    if (typeof longTermDebt === "object") {
      return longTermDebt.reason;
    }
    return (
      incompleteDebtReason(taxonomy, instant, sides, usedUmbrellas, tagged, history) ??
      restatedDebtComponentReason(instant, [...used, ...subtracted], tagged, history, valueOf)
    );
  })();
  const omittedShortTerm =
    ambiguous !== undefined &&
    total === ambiguous.concept &&
    (sides[0]?.concepts ?? []).every((concept) => valueAt(concept) === 0)
      ? omittedDebtConcepts(
          instant,
          (concept) => ![...ambiguous.shortTerm, ambiguous.currentTotal].includes(concept),
          history,
        )
      : [];
  const currentGeneric = sides[0]?.generic;
  const currentInstruments = concepts.current.instruments
    .flatMap((aliases) => first(aliases) ?? [])
    .filter((concept) => valueAt(concept) !== 0);
  // Commercial paper is never a long-term maturity, so beside maturities it adds; a total must still show it.
  const unprovenInstruments = currentInstruments.filter(
    (concept) => total !== undefined || concept !== ambiguous?.commercialPaper,
  );
  // Issuers tag short-term lines inside (AMAT) or beside (GPN) current maturities; equal amounts prove neither.
  const added = unprovenInstruments.filter((concept) => used.includes(concept));
  const subsumed = unprovenInstruments.filter((concept) => !used.includes(concept));
  const generic = currentGeneric ?? "";
  const classifiedLines = [...(sides[1]?.concepts ?? []), generic];
  // The combined total is defined to hold short-term debt, so equal to the classified lines it shows them inside (AMD FY2025 10-K).
  const combinedHoldsSubsumed =
    currentGeneric !== undefined &&
    total !== undefined &&
    total === ambiguous?.combinedTotal &&
    valueAt(total) === sum(classifiedLines) &&
    sum(subsumed) <= sum([generic]) &&
    [undefined, sum([generic])].includes(valueAt(ambiguous?.currentTotal ?? ""));
  const unprovenCurrent =
    ambiguous !== undefined &&
    currentGeneric !== undefined &&
    currentGeneric !== ambiguous.currentTotal &&
    valueAt(currentGeneric) !== 0 &&
    ((added.length > 0 && valueAt(ambiguous.currentTotal) !== sum([generic, ...added])) ||
      (subsumed.length > 0 &&
        !combinedHoldsSubsumed &&
        (total === undefined || valueAt(total) !== sum([...classifiedLines, ...subsumed]))));
  const strayConstituents =
    total === undefined && sides[1]?.generic === undefined
      ? (concepts.constituents ?? []).filter(
          (concept) => tagged.has(concept) && valueAt(concept) !== 0,
        )
      : [];
  // PayPal tags principal due within a year but not its current debt; Meta's line nets to its whole principal.
  const untaggedCurrent =
    total === undefined &&
    (principal.dueWithinYear ?? 0) > 0 &&
    (sides[0]?.concepts ?? []).length === 0 &&
    (principal.total === undefined ||
      principal.total - (principal.unamortized ?? 0) !== sum(used) - sum(subtracted));
  // An instrument larger than the only line that could hold it sits beside it (AAOI convertibles).
  const besideInstruments = [concepts.current, concepts.noncurrent].flatMap((side, index) => {
    const holder = total ?? sides[index]?.generic;
    const held = holder === undefined ? undefined : valueAt(holder);
    return held === undefined
      ? []
      : side.instruments
          .flatMap((aliases) => first(aliases) ?? [])
          .filter((concept) => !used.includes(concept) && (valueAt(concept) ?? 0) > held)
          .map(
            (concept) =>
              `${concept} (${String(valueAt(concept))}) exceeds ${holder ?? ""} (${String(held)})`,
          );
  });
  const incompleteReason =
    unsplitLease !== undefined
      ? unsplitLease
      : besideInstruments.length > 0
        ? `${besideInstruments.join(", ")}, so it cannot be inside the selected debt`
        : strayConstituents.length > 0
          ? `${strayConstituents.join(", ")} tagged without a noncurrent debt line or total that holds it`
          : total === ambiguous?.concept && restatedScope.length > 0
            ? `a later filing restated ${restatedScope.join(", ")} without restating ${ambiguous?.concept ?? ""}`
            : unprovenCurrent
              ? `${unprovenInstruments.join(", ")} tagged beside ${generic} with no ${ambiguous?.currentTotal ?? ""} or total showing whether they are one line or two`
              : untaggedCurrent
                ? `${US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT} (${String(principal.dueWithinYear)}) shows principal due within a year, but no current debt line is tagged`
                : omittedShortTerm.length > 0
                  ? `${ambiguous?.concept ?? ""} excludes ${omittedShortTerm.join(", ")}, reported nonzero within the prior year`
                  : excess === undefined
                    ? componentReason
                    : `finance-lease deduction ${excess.leases.join(", ")} exceeds ${excess.aggregates.join(", ")}`;
  const reconciledTotal =
    total === ambiguous?.concept &&
    longTermDebt === "total" &&
    restatedScope.length === 0 &&
    (scopeSides[0]?.concepts ?? []).some((concept) => longTermDebtFiling.get(concept) !== 0);
  const lines = classifiedDebtLines(concepts);
  const lineScope =
    unadjusted.length === 0 &&
    (total === undefined
      ? used.length > 0 && used.every((concept) => lines.has(concept))
      : reconciledTotal);
  return {
    basis: total !== undefined && subtracted.length === 0 ? "total" : "components",
    contributors: [
      ...used.map((concept) => contributor(concept)),
      ...subtracted.map((concept) => ({ ...contributor(concept), subtract: true as const })),
    ],
    ...(incompleteReason !== undefined ? { incompleteReason } : {}),
    ...(unadjusted.length > 0 ? { leaseInclusive: unadjusted } : {}),
    ...(lineScope ? { lineScope: true as const } : {}),
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

export function incompleteDebtNote(
  periodEnd: string,
  reason: string,
  publicAt: string,
): FinancialStatementNote {
  return {
    code: "incomplete-composite-series",
    seriesKey: "debt",
    periodKey: `instant|${periodEnd}`,
    publicAt,
    message: `Debt composite for ${periodEnd} is incomplete: ${reason}.`,
  };
}

// The newest debt instant is incomplete, so no older amount may stand in as the latest debt.
export function withheldDebt(
  artifact: FinancialStatementsArtifact,
): { readonly periodEnd: string; readonly reason: string } | undefined {
  const debt = financialStatementSeriesByKey(artifact, "debt");
  const debtEnd =
    debt === undefined
      ? undefined
      : latestFinancialStatementFact(financialStatementFacts(debt))?.periodEnd;
  // Reader artifacts written before omission notes existed carry none.
  const [note] = (artifact.omissionNotes ?? [])
    .filter(
      (candidate) =>
        candidate.code === "incomplete-composite-series" &&
        candidate.seriesKey === "debt" &&
        candidate.periodKey !== undefined &&
        (debtEnd === undefined || candidate.periodKey.replace(/^instant\|/u, "") > debtEnd),
    )
    .toSorted((left, right) => (right.periodKey ?? "").localeCompare(left.periodKey ?? ""));
  return note?.periodKey === undefined
    ? undefined
    : {
        periodEnd: note.periodKey.replace(/^instant\|/u, ""),
        reason:
          /is incomplete: (?<reason>.*)\.$/u.exec(note.message)?.groups?.reason ?? note.message,
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
  const latestInterimEnd = latestFinancialStatementFact(interim)?.periodEnd;
  const latestEndFacts = interim.filter((fact) => fact.periodEnd === latestInterimEnd);
  // Only each span's latest revision may reconcile; a superseded original never stands in.
  const latestEndRevisions = [
    ...new Set(latestEndFacts.map((fact) => financialStatementPeriodMonths(fact))),
  ].map(
    (months) =>
      latestEndFacts
        .filter((fact) => financialStatementPeriodMonths(fact) === months)
        .toSorted(compareFinancialStatementRevisions)[0]!,
  );
  const latestYearToDate = latestFinancialStatementFact(
    latestEndRevisions.filter(
      (fact) =>
        fact.periodStart !== undefined &&
        fact.periodEnd > fiscalYear.periodEnd &&
        Math.abs(daysBetween(fiscalYear.periodEnd, fact.periodStart) ?? Infinity) <=
          FY_BOUNDARY_TOLERANCE_DAYS,
    ),
  );
  if (latestYearToDate === undefined || latestYearToDate.periodStart === undefined) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "No latest-end interim duration fact starts at the fiscal-year boundary",
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
  if (
    fiscalYear.periodStart === undefined ||
    startAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
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

function isDividendsPerShare(item: FinancialStatementSeries): boolean {
  return item.key === "dividendsPerShare";
}

// Dividend declarations keep their own window so neither cadence displaces the other's periods.
export function capFinancialStatementPeriods(series: readonly FinancialStatementSeries[]): {
  readonly series: readonly FinancialStatementSeries[];
  readonly notes: readonly FinancialStatementNote[];
} {
  const nonDividend = series.filter((item) => !isDividendsPerShare(item));
  const statements = capSharedPeriods(
    nonDividend,
    nonDividend.filter((item) => !CAP_FOLLOWER_SERIES.has(item.key)),
  );
  const dividends = capSharedPeriods(series.filter((item) => isDividendsPerShare(item)));
  const capped = new Map(
    [...statements.series, ...dividends.series].map((item) => [item.key, item]),
  );
  return {
    series: series.map((item) => capped.get(item.key)!),
    notes: [
      ...statements.notes,
      ...dividends.notes.map((note) => ({ ...note, seriesKey: "dividendsPerShare" as const })),
    ],
  };
}

function capSharedPeriods(
  series: readonly FinancialStatementSeries[],
  keySeries: readonly FinancialStatementSeries[] = series,
): {
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
      for (const fact of keySeries.flatMap((item) => item[period])) {
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
  for (const item of series.filter((candidate) => !keySeries.includes(candidate))) {
    for (const period of ["annual", "interim"] as const) {
      const dropped = item[period].filter((fact) => !keep(period, fact));
      for (const periodKey of new Set(dropped.map((fact) => fact.periodKey))) {
        notes.push({
          code: "history-cap",
          seriesKey: item.key,
          periodKey: `${period}|${periodKey}`,
          message: `${item.label} ${period} period ${periodKey} omitted: the core statements do not retain it`,
        });
      }
    }
  }
  return {
    series: series.map((item) => ({
      ...item,
      annual: item.annual.filter((fact) => keep("annual", fact)),
      interim: item.interim.filter((fact) => keep("interim", fact)),
    })),
    notes,
  };
}
