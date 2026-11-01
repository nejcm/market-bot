import {
  DEBT_CONCEPTS,
  type DebtTaxonomyConcepts,
  US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT,
} from "./financial-statement-definitions";
import { restatedFromOriginalFiling } from "./financial-statement-selection";
import type {
  FinancialStatementNote,
  FinancialStatementTaxonomy,
} from "./financial-statements-contract";

const DAY_MS = 86_400_000;

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
  readonly proofSourceIds?: readonly string[];
  readonly faceLeases?: readonly string[];
}

export function debtIdentityConcepts(taxonomy: FinancialStatementTaxonomy): readonly string[] {
  const ambiguous = DEBT_CONCEPTS[taxonomy].ambiguousLongTermDebt;
  if (ambiguous === undefined) {
    return [];
  }
  const identity = ambiguous.noncurrentIdentity;
  return [
    identity.noncurrentTotal,
    identity.total,
    identity.currentTotal,
    ...identity.others,
    ...identity.currentOthers,
    ambiguous.capitalLeaseCurrent,
  ];
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

interface DebtHistoryFact {
  readonly concept: string;
  readonly amendment?: boolean;
  readonly periodEnd: string;
  readonly filedAt: string;
  readonly value: number;
}

interface DebtInstant {
  readonly periodEnd: string;
  readonly filedAt: string;
}

export type DebtFaceSide = "current" | "noncurrent";

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

// A zero balance cannot be missing from the sum (Iridium 2020 SeniorLongTermNotes after redemption).
function zeroUnrecognizedDebtConcepts<T>(
  taxonomy: FinancialStatementTaxonomy,
  tagged: ReadonlyMap<string, T>,
  valueOf: (fact: T) => number,
): readonly string[] {
  const recognized = recognizedDebtConcepts(taxonomy);
  return [...tagged].flatMap(([concept, fact]) =>
    !recognized.has(concept) && valueOf(fact) === 0 ? [concept] : [],
  );
}

export const UNRECOGNIZED_BORROWING_REASON = "unrecognized borrowing concepts are tagged";

function incompleteDebtReason<T>(
  taxonomy: FinancialStatementTaxonomy,
  instant: DebtInstant,
  sides: readonly DebtSide[],
  usedUmbrellas: readonly string[],
  tagged: ReadonlyMap<string, T>,
  history: readonly DebtHistoryFact[],
  valueOf: (fact: T) => number,
): string | undefined {
  const recognized = recognizedDebtConcepts(taxonomy);
  const zeroTagged = new Set(zeroUnrecognizedDebtConcepts(taxonomy, tagged, valueOf));
  const unrecognized = [...tagged.keys()].filter(
    (concept) => !recognized.has(concept) && !zeroTagged.has(concept),
  );
  if (unrecognized.length > 0) {
    return `${UNRECOGNIZED_BORROWING_REASON}: ${unrecognized.join(", ")}`;
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
    (concept) => covered.has(concept) || bothGeneric || zeroTagged.has(concept),
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

type LongTermDebtUse = "line" | "beside" | "total" | "line-without-current";

// LongTermDebt's scope is read only from its own filing's lines; `currentElsewhere` is nonzero current debt in any filing.
function longTermDebtUse(
  concepts: DebtTaxonomyConcepts,
  value: (concept: string) => number | undefined,
  currentElsewhere: boolean,
  [current, noncurrent]: readonly DebtSide[],
  faceRow: (concept: string, side: DebtFaceSide) => boolean,
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
  if (
    faceRow(ambiguous.concept, "noncurrent") &&
    currentLines.every((concept) => faceRow(concept, "current")) &&
    noncurrentLines.every((concept) => faceRow(concept, "noncurrent"))
  ) {
    return asNoncurrentGeneric ||
      noncurrentLines.length === 0 ||
      noncurrentLines.includes(ambiguous.concept)
      ? "line"
      : "beside";
  }
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
    longTermDebt <= Math.max(currentSum, value(ambiguous.current) ?? 0) + noncurrentSum
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
  faceRow: (concept: string, side: DebtFaceSide) => boolean = () => false,
): DebtResolution<T> {
  const concepts = DEBT_CONCEPTS[taxonomy];
  const contributor = (concept: string) => ({ concept, fact: tagged.get(concept) as T });
  const ambiguous = concepts.ambiguousLongTermDebt;
  const taggedValue = (concept: string | undefined) => {
    const fact = tagged.get(concept ?? "");
    return fact === undefined ? undefined : valueOf(fact);
  };
  const maturitiesValue = taggedValue(ambiguous?.current);
  const leaseInCurrent =
    maturitiesValue !== undefined &&
    liabilities.some(
      (fact) =>
        fact.concept === ambiguous?.capitalLeaseCurrent &&
        fact.periodEnd === instant.periodEnd &&
        fact.filedAt <= instant.filedAt &&
        fact.value !== 0 &&
        (taggedValue(ambiguous?.currentTotal) ?? 0) > maturitiesValue,
    );
  const sidesOf = (has: (concept: string) => boolean) => {
    const firstOf = (aliases: readonly string[]) => aliases.find(has);
    const shortTermOf = ambiguous === undefined ? undefined : firstOf(ambiguous.shortTerm);
    return [concepts.current, concepts.noncurrent].map((side) => {
      const generic = firstOf(
        side.generic.filter((concept) => concept !== ambiguous?.currentTotal || !leaseInCurrent),
      );
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
  const loneLegsOnly = umbrellas.filter(
    (umbrella) =>
      concepts.legsOnlyUmbrellas?.includes(umbrella) === true &&
      valueOf(tagged.get(umbrella) as T) !== 0,
  );
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
  const usedUmbrellas =
    overlap.length > 0
      ? []
      : umbrellas.filter((umbrella) => concepts.legsOnlyUmbrellas?.includes(umbrella) !== true);
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
    faceRow,
  );
  const restatedScope =
    longTermDebt === "total"
      ? scopeSides
          .flatMap((side) => side.concepts)
          .filter((concept) => valueAt(concept) !== longTermDebtFiling.get(concept))
      : [];
  const combinedFact = tagged.get(ambiguous?.combinedTotal ?? "");
  const genericFacts = sides.flatMap((side) =>
    side.generic === undefined ? [] : [tagged.get(side.generic) as T],
  );
  // Same-filing classified lines are carrying basis; a Combined that misses them can be principal (AVGO) or omit paper (QCOM).
  const principalCombined =
    combinedFact !== undefined &&
    genericFacts.length === 2 &&
    genericFacts.every((fact) => filedAtOf(fact) === filedAtOf(combinedFact)) &&
    valueOf(genericFacts[1] as T) !== 0 &&
    ![
      genericFacts.reduce((acc, fact) => acc + valueOf(fact), 0),
      sides.flatMap((side) => side.concepts).reduce((acc, c) => acc + (valueAt(c) ?? 0), 0),
    ].includes(valueOf(combinedFact))
      ? ambiguous?.combinedTotal
      : undefined;
  const filedTotal = first(
    ambiguous !== undefined &&
      longTermDebt === "total" &&
      restatedScope.length === 0 &&
      (scopeSides[0]?.concepts ?? []).some((concept) => longTermDebtFiling.get(concept) !== 0)
      ? // A total that reconciles to its filing's lines is carrying basis; Combined can be principal (AVGO).
        [ambiguous.concept, ...concepts.totals]
      : concepts.totals.filter(
          (concept) =>
            concept !== principalCombined &&
            (concept !== ambiguous?.concept || longTermDebt === "total"),
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
      ? (legLines ?? [...sides.flatMap((side) => side.concepts), ...usedUmbrellas])
          .filter(
            (concept) => longTermDebt !== "line-without-current" || concept !== ambiguous?.current,
          )
          .concat(longTermDebt === "beside" && ambiguous !== undefined ? [ambiguous.concept] : [])
          .filter((concept, index, all) => all.indexOf(concept) === index)
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
  // Debt lines plus the listed face-statement lines foot exactly to the filed subtotal, the same-filing proof of placement.
  const faceStatementLines = (side: "current" | "noncurrent", debtLines: readonly string[]) => {
    const identity = ambiguous?.noncurrentIdentity;
    const filings = new Set(debtLines.map((concept) => filedAtOf(tagged.get(concept) as T)));
    const [filedAt] = filings;
    if (identity === undefined || filings.size !== 1) {
      return false;
    }
    const filed = (concept: string) =>
      liabilities.find(
        (fact) =>
          fact.concept === concept &&
          fact.periodEnd === instant.periodEnd &&
          fact.filedAt === filedAt,
      )?.value;
    const currentTotal = filed(identity.currentTotal);
    const liabilitiesTotal = filed(identity.total);
    const subtotal =
      side === "current"
        ? currentTotal
        : (filed(identity.noncurrentTotal) ??
          (liabilitiesTotal === undefined || currentTotal === undefined
            ? undefined
            : liabilitiesTotal - currentTotal));
    const others = side === "current" ? identity.currentOthers : identity.others;
    return (
      subtotal !== undefined &&
      subtotal === sum(debtLines) + others.reduce((acc, concept) => acc + (filed(concept) ?? 0), 0)
    );
  };
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
      incompleteDebtReason(taxonomy, instant, sides, usedUmbrellas, tagged, history, valueOf) ??
      restatedDebtComponentReason(
        instant,
        [...used, ...subtracted, ...zeroUnrecognizedDebtConcepts(taxonomy, tagged, valueOf)],
        tagged,
        history,
        valueOf,
      )
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
        !(valueAt(generic) === sum(subsumed) && faceStatementLines("current", subsumed)) &&
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
  const besideBySide = [concepts.current, concepts.noncurrent].map((side, index) => {
    const holder = total ?? sides[index]?.generic;
    const held = holder === undefined ? undefined : valueAt(holder);
    return held === undefined
      ? []
      : side.instruments
          .flatMap((aliases) => first(aliases) ?? [])
          .filter((concept) => !used.includes(concept) && (valueAt(concept) ?? 0) > held)
          .map((concept) => ({ concept, holder: holder ?? "", held }));
  });
  const noncurrentBeside = (besideBySide[1] ?? []).map(({ concept }) => concept);
  const provenBeside =
    (besideBySide[0] ?? []).length === 0 &&
    faceStatementLines("noncurrent", [...(sides[1]?.concepts ?? []), ...noncurrentBeside])
      ? noncurrentBeside
      : [];
  const besideInstruments = besideBySide
    .flat()
    .filter(({ concept }) => !provenBeside.includes(concept))
    .map(
      ({ concept, holder, held }) =>
        `${concept} (${String(valueAt(concept))}) exceeds ${holder} (${String(held)})`,
    );
  const incompleteReason =
    loneLegsOnly.length > 0
      ? `${loneLegsOnly.join(", ")} is tagged without its current or noncurrent legs`
      : unsplitLease !== undefined
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
    basis:
      total !== undefined && subtracted.length === 0 && provenBeside.length === 0
        ? "total"
        : "components",
    contributors: [
      ...[...used, ...provenBeside].map((concept) => contributor(concept)),
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
