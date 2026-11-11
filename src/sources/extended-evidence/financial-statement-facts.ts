import { DAY_MS } from "../../config/shared";
import { isRecord, readNumber, readString } from "../../guards";
import type { ExtendedEvidenceItem } from "../../domain/evidence";
import {
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  isRevenueConceptInRecencyBucket,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  compositeStatementIdentity,
  restatedFromOriginalFiling,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  isYearAligned,
  MAX_ANNUAL_PERIODS_PER_SHAPE,
} from "./financial-statement-selection";
import { calendarYearFromPeriodEnd } from "./financial-statement-period-identity";
import {
  COMPOSITE_STATEMENT_FACT_FORMULA,
  SEC_COMPANYFACTS_UNIT_SCALE,
  canonicalizeSecForm,
  isAnnualReportForm,
  isCalendarDate,
  readSecFactPeriodMetadata,
  type CanonicalSecForm,
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementTaxonomy,
  type OriginalFiling,
  type SupportedSecForm,
  ZERO_BORROWINGS_EXTRACTION_METHOD,
} from "./financial-statements-contract";

interface ParsedCompositeComponent {
  readonly concept: string;
  readonly value: number;
  readonly accessionNumber: string | null;
  readonly filedAt: string;
  readonly periodEnd: string;
  readonly sourceIds?: readonly string[];
}

export interface ParsedFact {
  readonly value: number;
  readonly restatedFrom?: OriginalFiling;
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
  readonly firstPublicAt?: string;
  readonly lineScope?: true;
  readonly sourceIds?: readonly string[];
  readonly proofSourceIds?: readonly string[];
  readonly faceLeases?: readonly string[];
  readonly zeroBorrowingsProof?: string;
  readonly composite?: {
    readonly formula: typeof COMPOSITE_STATEMENT_FACT_FORMULA;
    readonly components: readonly ParsedCompositeComponent[];
  };
}

export interface SelectedSeries {
  readonly series: FinancialStatementSeries;
  readonly validationNotes: readonly FinancialStatementNote[];
  readonly omissionNotes: readonly FinancialStatementNote[];
  readonly withheld?: readonly WithheldDerivation[];
}

export interface FinancialStatementsDeriveInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly analysisAsOf: string;
  readonly sourceId: string;
  readonly sourceUrl?: string;
  readonly submissionsPayload?: unknown;
  readonly submissionsSourceId?: string;
  readonly secFilings?: readonly ExtendedEvidenceItem[];
}

export const TAXONOMIES: readonly FinancialStatementTaxonomy[] = ["us-gaap", "ifrs-full"];
const STATEMENT_DURATION_MONTHS = new Set([3, 6, 9, 12]);

export function parseFact(
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
  const period = readSecFactPeriodMetadata(value);
  if (numericValue === undefined || form === undefined || period === undefined) {
    return undefined;
  }
  const { filed: filedAt, end: periodEnd, fp: fiscalPeriod } = period;
  const fiscalYear = calendarYearFromPeriodEnd(periodEnd);
  if (fiscalYear === undefined) {
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

export function taxonomyRoot(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
): Record<string, unknown> | undefined {
  const root = factsRoot(payload);
  return root !== undefined && isRecord(root[taxonomy]) ? root[taxonomy] : undefined;
}

export function unitFacts(
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

export function factsForLatestPeriodConcept(
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  concepts: readonly string[],
  eligible: (fact: ParsedFact) => boolean,
): readonly ParsedFact[] {
  const ranked = concepts
    .map((concept, priority) => {
      const facts = unitFacts(taxonomy, root, concept);
      const latestPeriodEnd = facts
        .filter((fact) => eligible(fact))
        .map((fact) => fact.periodEnd)
        .toSorted()
        .at(-1);
      return { facts, latestPeriodEnd, priority };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        readonly facts: readonly ParsedFact[];
        readonly latestPeriodEnd: string;
        readonly priority: number;
      } => candidate.latestPeriodEnd !== undefined,
    );
  const latestPeriodEnd = ranked
    .map((candidate) => candidate.latestPeriodEnd)
    .toSorted()
    .at(-1);
  if (latestPeriodEnd === undefined) {
    return [];
  }
  return (
    ranked
      .filter((candidate) => candidate.latestPeriodEnd === latestPeriodEnd)
      .toSorted((left, right) => left.priority - right.priority)[0]?.facts ?? []
  );
}

export function factsForDefinition(
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
  if (definition.key === "dividendsPerShare") {
    // Declarations are annual-anchored; a newer interim cash-paid tag must not hide declared annual history.
    const annualBasis = factsForLatestPeriodConcept(
      taxonomy,
      root,
      concepts,
      (fact) =>
        eligible(fact) &&
        fact.periodStart !== undefined &&
        isYearAligned(fact.periodStart, fact.periodEnd) &&
        periodType(fact, definition) === "annual",
    );
    const statementBasis =
      annualBasis.length > 0
        ? annualBasis
        : factsForLatestPeriodConcept(
            taxonomy,
            root,
            concepts,
            (fact) => eligible(fact) && isStatementPeriod(fact, definition),
          );
    // Spans-only issuers still surface their declarations as omission evidence.
    return statementBasis.length > 0
      ? statementBasis
      : factsForLatestPeriodConcept(taxonomy, root, concepts, eligible);
  }
  return definition.key === "revenue"
    ? selectRevenueConcept(taxonomy, root, definition, eligible).facts
    : factsForLatestPeriodConcept(taxonomy, root, concepts, eligible);
}

function selectRevenueConcept(
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const ranked = definition.concepts[taxonomy]
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
    return { facts: [], notes: [] };
  }
  const [preferred, ...rest] = ranked
    .filter((candidate) =>
      isRevenueConceptInRecencyBucket(candidate.latest.periodEnd, latestPeriodEnd),
    )
    .toSorted(
      (left, right) =>
        left.priority - right.priority ||
        left.latest.concept.localeCompare(right.latest.concept) ||
        left.latest.unit.localeCompare(right.latest.unit),
    );
  if (preferred === undefined) {
    return { facts: [], notes: [] };
  }
  const annualRevisions = (facts: readonly ParsedFact[]) =>
    new Map(
      selectRestatements(
        facts.filter((fact) => eligible(fact) && periodType(fact, definition) === "annual"),
        definition.key,
        [],
      ).facts.map((fact) => [periodKey(fact), fact] as const),
    );
  const preferredAnnual = annualRevisions(preferred.facts);
  // A newer tag replaces the preferred one only if, inside the annual cap over both tags' periods, it
  // Carries every preferred period at the same value and one filing tags both for the newest one.
  const sameScopeNewer = rest.find((candidate) => {
    const candidateAnnual = annualRevisions(candidate.facts);
    const capped = [...new Map([...candidateAnnual, ...preferredAnnual]).values()]
      .toSorted(chronological)
      .slice(-MAX_ANNUAL_PERIODS_PER_SHAPE)
      .map((fact) => periodKey(fact))
      .filter((key) => preferredAnnual.has(key));
    const anchor = preferredAnnual.get(capped.at(-1) ?? "");
    return (
      candidate.latest.periodEnd > preferred.latest.periodEnd &&
      anchor !== undefined &&
      anchor.accessionNumber !== null &&
      candidateAnnual.get(periodKey(anchor))?.accessionNumber === anchor.accessionNumber &&
      capped.every((key) => candidateAnnual.get(key)?.value === preferredAnnual.get(key)!.value)
    );
  });
  if (sameScopeNewer === undefined) {
    return forwardRevenueSplice(preferred, ranked, eligible, []);
  }
  const cappedKeys = (annual: ReadonlyMap<string, ParsedFact>) =>
    [...annual.values()]
      .toSorted(chronological)
      .slice(-MAX_ANNUAL_PERIODS_PER_SHAPE)
      .map((fact) => periodKey(fact));
  const switchedKeys = new Set(cappedKeys(annualRevisions(sameScopeNewer.facts)));
  const interimKeys = (facts: readonly ParsedFact[]) =>
    new Set(
      facts
        .filter((fact) => eligible(fact) && periodType(fact, definition) === "interim")
        .map((fact) => periodKey(fact)),
    );
  const switchedInterim = interimKeys(sameScopeNewer.facts);
  return forwardRevenueSplice(sameScopeNewer, ranked, eligible, [
    ...cappedKeys(preferredAnnual)
      .filter((key) => !switchedKeys.has(key))
      .map((key) => ({
        code: "history-cap" as const,
        seriesKey: definition.key,
        periodKey: `annual|${key}`,
        message: `Older annual period ${key} under ${preferred.latest.concept} omitted: revenue switched to ${sameScopeNewer.latest.concept} on same-filing proof, and the ${String(MAX_ANNUAL_PERIODS_PER_SHAPE)}-period annual cap keeps its newer periods`,
      })),
    ...[...interimKeys(preferred.facts)]
      .filter((key) => !switchedInterim.has(key))
      .map((key) => ({
        code: "history-cap" as const,
        seriesKey: definition.key,
        periodKey: `interim|${key}`,
        message: `Interim period ${key} under ${preferred.latest.concept} omitted: revenue switched to ${sameScopeNewer.latest.concept} on same-filing proof, which does not tag that period`,
      })),
  ]);
}

interface RevenueCandidate {
  readonly facts: readonly ParsedFact[];
  readonly latest: ParsedFact;
}

interface RevenueSpan {
  readonly start: string;
  readonly end: string;
  readonly value: number;
  readonly accession: string | null;
  readonly filedAt: string;
}

function dayBefore(date: string): string {
  return new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10);
}

function rawSpans(facts: readonly ParsedFact[]): readonly RevenueSpan[] {
  return facts.flatMap((fact) =>
    fact.periodStart === undefined
      ? []
      : [
          {
            start: fact.periodStart,
            end: fact.periodEnd,
            value: fact.value,
            accession: fact.accessionNumber,
            filedAt: fact.filedAt,
          },
        ],
  );
}

// A same-filing YTD less a later-starting span of the same end implies the span before it.
function derivedSpans(facts: readonly ParsedFact[]): readonly RevenueSpan[] {
  const raw = rawSpans(facts);
  return raw.flatMap((ytd) =>
    raw
      .filter(
        (part) =>
          ytd.accession !== null &&
          part.accession === ytd.accession &&
          part.end === ytd.end &&
          part.start > ytd.start,
      )
      .map((part) => ({ ...ytd, end: dayBefore(part.start), value: ytd.value - part.value })),
  );
}

const sameSpan = (left: RevenueSpan, right: RevenueSpan) =>
  left.start === right.start && left.end === right.end;

const conflicts = (left: readonly RevenueSpan[], right: readonly RevenueSpan[]) =>
  left.some((a) => right.some((b) => sameSpan(a, b) && a.value !== b.value));

// Extends the selected revenue concept with a newer alias's later periods only when an overlap proves both tag one line.
function forwardRevenueSplice(
  selected: RevenueCandidate,
  ranked: readonly RevenueCandidate[],
  eligible: (fact: ParsedFact) => boolean,
  notes: readonly FinancialStatementNote[],
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const { concept, unit, periodEnd: selectedEnd } = selected.latest;
  const selectedRaw = rawSpans(selected.facts.filter(eligible));
  const selectedDerived = derivedSpans(selected.facts.filter(eligible));
  const roster = ranked.flatMap((candidate) => candidate.facts.filter(eligible));
  for (const alias of ranked) {
    const aliasConcept = alias.latest.concept;
    const facts = alias.facts.filter(eligible);
    if (aliasConcept === concept || alias.latest.periodEnd <= selectedEnd) {
      continue;
    }
    const appended = facts.filter((fact) => fact.periodEnd > selectedEnd);
    const forward = new Set(appended.map((fact) => fact.accessionNumber));
    const aliasRaw = rawSpans(facts);
    const aliasDerived = derivedSpans(facts);
    const otherTotal = rawSpans(roster.filter((fact) => fact.concept !== aliasConcept));
    const [proof] = [...aliasRaw, ...aliasDerived]
      .filter((span) => span.accession !== null && forward.has(span.accession))
      .flatMap((span) =>
        selectedRaw
          .filter((other) => sameSpan(span, other) && other.value === span.value)
          .map((other) => ({
            span,
            publicAt: other.filedAt > span.filedAt ? other.filedAt : span.filedAt,
          })),
      )
      .toSorted((left, right) => left.publicAt.localeCompare(right.publicAt));
    if (
      proof === undefined ||
      facts.some((fact) => fact.unit !== unit) ||
      conflicts(selectedRaw, aliasRaw) ||
      conflicts(selectedRaw, aliasDerived) ||
      conflicts(aliasRaw, selectedDerived) ||
      conflicts(rawSpans(appended), otherTotal)
    ) {
      continue;
    }
    const periodEnds = [...new Set(appended.map((fact) => fact.periodEnd))].toSorted();
    const spans = [
      ...new Set(appended.map((fact) => `${fact.periodStart ?? "instant"} to ${fact.periodEnd}`)),
    ];
    const { start, end, value, accession } = proof.span;
    return {
      facts: [
        ...selected.facts,
        ...appended.map((fact) => ({
          ...fact,
          firstPublicAt: fact.filedAt > proof.publicAt ? fact.filedAt : proof.publicAt,
        })),
      ],
      notes: [
        ...notes,
        {
          code: "revenue-concept-splice",
          seriesKey: "revenue",
          revenueSplice: {
            selectedConcept: concept,
            selectedEnd,
            aliasConcept,
            proofStart: start,
            proofEnd: end,
            proofAccession: accession!,
            periodEnds,
          },
          message: `SEC revenue under ${concept} ends ${selectedEnd}; ${spans.toSorted().join(", ")} come from ${aliasConcept} in ${[...forward].toSorted().join(", ")}, proven by ${aliasConcept} in ${accession!} matching ${concept} ${start} to ${end} at ${String(value)}`,
        },
      ],
    };
  }
  return { facts: selected.facts, notes };
}

export function revenueConceptSwitchNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): readonly FinancialStatementNote[] {
  const root = taxonomyRoot(payload, taxonomy);
  return root === undefined || definition.key !== "revenue"
    ? []
    : selectRevenueConcept(taxonomy, root, definition, eligible).notes;
}

export function compositeFromContributors(
  contributors: readonly ParsedFact[],
  subtracted: ReadonlySet<string> = new Set(),
): ParsedFact {
  const [anchor] = contributors;
  if (anchor === undefined) {
    throw new Error("compositeFromContributors requires at least one contributor");
  }
  const identity = compositeStatementIdentity(contributors);
  return {
    value: identity.value,
    form: anchor.form,
    canonicalForm: anchor.canonicalForm,
    amendment: anchor.amendment,
    accessionNumber: identity.accessionNumber,
    filedAt: identity.filedAt,
    ...(anchor.periodStart !== undefined ? { periodStart: anchor.periodStart } : {}),
    periodEnd: anchor.periodEnd,
    fiscalYear: anchor.fiscalYear,
    fiscalPeriod: anchor.fiscalPeriod,
    taxonomy: anchor.taxonomy,
    concept: contributors
      .map((fact) => `${subtracted.has(fact.concept) ? "-" : "+"}${fact.concept}`)
      .join("")
      .slice(1),
    unit: anchor.unit,
    composite: {
      formula: COMPOSITE_STATEMENT_FACT_FORMULA,
      components: contributors.map((fact) => ({
        concept: fact.concept,
        value: fact.value,
        accessionNumber: fact.accessionNumber,
        filedAt: fact.filedAt,
        periodEnd: fact.periodEnd,
        ...(fact.sourceIds === undefined ? {} : { sourceIds: fact.sourceIds }),
      })),
    },
  };
}

export function withCompositeFirstPublicAt(
  composite: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
  candidates: readonly ParsedFact[],
  subtracted: ReadonlySet<string>,
): ParsedFact {
  const histories = (composite.composite?.components ?? []).map((component) =>
    candidates
      .filter(
        (fact) =>
          fact.concept === component.concept &&
          periodKey(fact) === periodKey(composite) &&
          periodType(fact, definition) === periodType(composite, definition),
      )
      .map((fact) => (subtracted.has(fact.concept) ? { ...fact, value: -fact.value } : fact)),
  );
  return {
    ...composite,
    // A spliced revenue component is public no earlier than its proof.
    firstPublicAt: [
      firstPublicDate(composite.value, composite.filedAt, histories),
      ...histories.flat().flatMap((fact) => fact.firstPublicAt ?? []),
    ]
      .toSorted()
      .at(-1)!,
  };
}

export interface WithheldDerivation {
  readonly periodKey: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly reason: string;
}

export function allFactsForDefinition(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  return root === undefined
    ? []
    : definition.concepts[taxonomy].flatMap((concept) => unitFacts(taxonomy, root, concept));
}

// Raw, pre-selection rows: only point-in-time observability, never form, fp, span or value shape.
export function rawConceptRows(
  root: Record<string, unknown> | undefined,
  concept: string,
  analysisAsOf: string,
): readonly unknown[] {
  const cutoff = analysisAsOf.slice(0, 10);
  const units = isRecord(root?.[concept]) ? root[concept].units : undefined;
  return (isRecord(units) ? Object.values(units) : [])
    .flatMap((values) => (Array.isArray(values) ? values : []))
    .filter((fact) => {
      const filed = isRecord(fact) ? readString(fact, "filed") : undefined;
      return filed === undefined || !isCalendarDate(filed) || filed <= cutoff;
    });
}

export function isObservable(fact: ParsedFact, analysisAsOf: string): boolean {
  const cutoff = analysisAsOf.slice(0, 10);
  return fact.periodEnd <= cutoff && fact.filedAt <= cutoff;
}

export function currencyForUnit(unit: string): string | undefined {
  const currency = unit.endsWith("/shares") ? unit.slice(0, -7) : unit;
  return /^[A-Z]{3}$/u.test(currency) ? currency : undefined;
}

export function periodType(
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

export function isStatementPeriod(
  fact: ParsedFact,
  definition: FinancialStatementSeriesDefinition,
): boolean {
  return (
    periodType(fact, definition) === "annual" ||
    STATEMENT_DURATION_MONTHS.has(financialStatementPeriodMonths(fact) ?? -1)
  );
}

export function periodKey(fact: ParsedFact): string {
  return financialStatementPeriodKey(fact);
}

type DatedFact = ParsedFact & {
  readonly firstPublicAt: string;
  readonly restatedFrom?: OriginalFiling;
};

// Earliest filing date from which the selected value stayed effective, so A -> B -> A dates to the later A.
export function firstPublicDate(
  value: number,
  filedAt: string,
  slots: readonly (readonly ParsedFact[])[],
): string {
  const valueAt = (date: string) =>
    slots.reduce<number | undefined>((sum, slot) => {
      const [effective] = slot
        .filter((fact) => fact.filedAt <= date)
        .toSorted(compareFinancialStatementFacts);
      return sum === undefined || effective === undefined ? undefined : sum + effective.value;
    }, 0);
  const dates = [...new Set(slots.flat().map((fact) => fact.filedAt))]
    .filter((date) => date <= filedAt)
    .toSorted();
  const supersededAt = dates.findLast((date) => valueAt(date) !== value) ?? "";
  return dates.find((date) => date > supersededAt) ?? filedAt;
}

export function withFirstPublicAt(
  winner: ParsedFact,
  candidates: readonly ParsedFact[],
  aliasFacts: readonly ParsedFact[] = [],
): DatedFact {
  const peers = candidates.filter((fact) => periodKey(fact) === periodKey(winner));
  const restatedFrom =
    winner.restatedFrom ??
    (winner.composite === undefined ? restatedFromOriginalFiling(winner.value, peers) : undefined);
  // An alias tag that filed the same figure dates it with its full history (A -> B -> A holds);
  // An alias that never matched may be another scope, so it is ignored.
  const aliasPeers = aliasFacts.filter((fact) => periodKey(fact) === periodKey(winner));
  const matchingAliases = new Set(
    aliasPeers.filter((fact) => fact.value === winner.value).map((fact) => fact.concept),
  );
  const datingPeers = [...peers, ...aliasPeers.filter((fact) => matchingAliases.has(fact.concept))];
  return {
    ...winner,
    firstPublicAt:
      winner.firstPublicAt ?? firstPublicDate(winner.value, winner.filedAt, [datingPeers]),
    ...(restatedFrom === undefined ? {} : { restatedFrom }),
  };
}

export function toSelectedFact(
  fact: DatedFact,
  definition: FinancialStatementSeriesDefinition,
  currency: string,
  sourceId: string,
): FinancialStatementFact {
  const sourceIds = [
    ...new Set([
      sourceId,
      ...(fact.proofSourceIds ?? []),
      ...(fact.composite?.components.flatMap((component) => component.sourceIds ?? []) ?? []),
    ]),
  ];
  const composite =
    fact.composite === undefined
      ? undefined
      : {
          formula: fact.composite.formula,
          components: fact.composite.components.map((component) => ({
            ...component,
            sourceIds: component.sourceIds ?? [sourceId],
          })),
        };
  return {
    value: fact.value,
    periodKey: periodKey(fact),
    periodType: periodType(fact, definition),
    form: fact.form,
    canonicalForm: fact.canonicalForm,
    amendment: fact.amendment,
    accessionNumber: fact.accessionNumber,
    filedAt: fact.filedAt,
    firstPublicAt: fact.firstPublicAt,
    ...(fact.restatedFrom !== undefined ? { restatedFrom: fact.restatedFrom } : {}),
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    fiscalYear: fact.fiscalYear,
    fiscalPeriod: fact.fiscalPeriod,
    taxonomy: fact.taxonomy,
    concept: fact.concept,
    currency: fact.unit === "shares" ? null : currency,
    unit: fact.unit,
    unitScale: SEC_COMPANYFACTS_UNIT_SCALE,
    extractionMethod:
      fact.zeroBorrowingsProof !== undefined
        ? ZERO_BORROWINGS_EXTRACTION_METHOD
        : composite === undefined
          ? "sec-companyfacts"
          : "derived-sec-companyfacts",
    sourceIds,
    ...(fact.lineScope === true ? { lineScope: true as const } : {}),
    ...(fact.faceLeases === undefined ? {} : { faceLeases: fact.faceLeases }),
    ...(fact.zeroBorrowingsProof === undefined
      ? {}
      : { zeroBorrowingsProof: fact.zeroBorrowingsProof }),
    ...(composite !== undefined ? { composite } : {}),
  };
}

export function selectRestatements(
  facts: readonly ParsedFact[],
  seriesKey: FinancialStatementSeriesKey,
  aliasFacts: readonly ParsedFact[],
): { readonly facts: readonly DatedFact[]; readonly notes: readonly FinancialStatementNote[] } {
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
    return withFirstPublicAt(winner, matches, aliasFacts);
  });
  return { facts: selected, notes };
}

export function chronological(left: ParsedFact, right: ParsedFact): number {
  return (
    left.periodEnd.localeCompare(right.periodEnd) ||
    (left.periodStart ?? "").localeCompare(right.periodStart ?? "") ||
    left.filedAt.localeCompare(right.filedAt) ||
    (left.accessionNumber ?? "").localeCompare(right.accessionNumber ?? "")
  );
}
