import type { ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import { FACE_LABEL_PREFIX, FACE_LINE_PREFIX } from "../sec-segment-facts";
import { leaseInclusiveDebtGap, withheldDebtGap } from "./sec-fundamentals-format";
import {
  DEBT_CONCEPTS,
  US_GAAP_DEBT_DUE_WITHIN_YEAR_CONCEPTS,
  US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT,
} from "./financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  financialStatementFacts,
  financialStatementSeriesByKey,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import {
  grossPrincipalWithholdsDebt,
  statementFiscalPeriodKey,
} from "./financial-statement-period-identity";
import {
  GROSS_PRINCIPAL_DEBT_CONCEPT,
  type FinancialStatementNote,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
} from "./financial-statements-contract";
import {
  type DebtResolution,
  debtCandidateConcepts,
  debtIdentityConcepts,
  incompleteDebtNote,
  recognizedDebtConcepts,
  resolveDebtAtInstant,
  unadjustedLeaseInclusiveDebt,
  unsupersededDebtResolutions,
} from "./sec-debt-resolution";
import type { ParsedFact, SelectedSeries } from "./financial-statements";

export interface DebtFactReader {
  readonly root: (taxonomy: FinancialStatementTaxonomy) => Record<string, unknown> | undefined;
  readonly unitFacts: (
    taxonomy: FinancialStatementTaxonomy,
    root: Record<string, unknown>,
    concept: string,
  ) => readonly ParsedFact[];
  readonly composite: (
    contributors: readonly ParsedFact[],
    subtracted: ReadonlySet<string>,
    candidates: readonly ParsedFact[],
  ) => ParsedFact;
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

function debtRestatements(
  fact: ParsedFact | undefined,
  basis: "total" | "components",
  candidates: readonly ParsedFact[],
): readonly ParsedFact[] {
  if (fact === undefined || basis === "components") {
    return fact === undefined ? [] : [fact];
  }
  const key = statementFiscalPeriodKey(fact);
  return candidates.filter(
    (candidate) =>
      candidate.concept === fact.concept && statementFiscalPeriodKey(candidate) === key,
  );
}

export function factsForDebt(
  { root: taxonomyRoot, unitFacts, composite }: DebtFactReader,
  taxonomy: FinancialStatementTaxonomy,
  eligible: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const root = taxonomyRoot(taxonomy);
  if (root === undefined) {
    return { facts: [], notes: [] };
  }
  const recognized = recognizedDebtConcepts(taxonomy);
  const candidates = debtCandidateConcepts(taxonomy, root)
    .flatMap((concept) => unitFacts(taxonomy, root, concept))
    .filter(
      (fact) => eligible(fact) && (fact.periodStart === undefined || recognized.has(fact.concept)),
    );
  const instants = new Map<string, Map<string, ParsedFact>>();
  for (const fact of candidates.toSorted(compareFinancialStatementFacts)) {
    const key = statementFiscalPeriodKey(fact);
    const tagged = instants.get(key) ?? new Map<string, ParsedFact>();
    if (!tagged.has(fact.concept)) {
      tagged.set(fact.concept, fact);
    }
    instants.set(key, tagged);
  }
  const history = candidates.map(({ concept, periodEnd, filedAt, value, amendment }) => ({
    concept,
    amendment,
    periodEnd,
    filedAt,
    value,
  }));
  const principalFacts = Object.fromEntries(
    (
      [
        ["dueWithinYear", US_GAAP_PRINCIPAL_DUE_WITHIN_YEAR_CONCEPT],
        ["total", GROSS_PRINCIPAL_DEBT_CONCEPT],
        ["unamortized", "DebtInstrumentUnamortizedDiscountPremiumAndDebtIssuanceCostsNet"],
      ] as const
    ).map(([key, concept]) => [
      key,
      taxonomy === "us-gaap"
        ? unitFacts(taxonomy, root, concept).filter(
            (fact) => fact.periodStart === undefined && eligible(fact),
          )
        : [],
    ]),
  );
  const liabilities = debtIdentityConcepts(taxonomy).flatMap((concept) =>
    unitFacts(taxonomy, root, concept)
      .filter((fact) => fact.periodStart === undefined && eligible(fact))
      .map(({ periodEnd, filedAt, value, amendment }) => ({
        concept,
        amendment,
        periodEnd,
        filedAt,
        value,
      })),
  );
  const resolved = [...instants.values()].map((tagged) => {
    const facts = [...tagged.values()];
    const instant = {
      periodEnd: facts[0]?.periodEnd ?? "",
      filedAt:
        facts
          .map((fact) => fact.filedAt)
          .toSorted()
          .at(-1) ?? "",
    };
    const resolveAt = (lines: ReadonlyMap<string, ParsedFact>) =>
      resolveDebtAtInstant(
        taxonomy,
        instant,
        lines,
        history,
        (fact) => fact.value,
        (fact) => fact.filedAt,
        Object.fromEntries(
          Object.entries(principalFacts).map(([key, values]) => [
            key,
            values
              .filter(
                (fact) => fact.periodEnd === instant.periodEnd && fact.filedAt <= instant.filedAt,
              )
              .toSorted(compareFinancialStatementFacts)
              .at(0)?.value,
          ]),
        ),
        liabilities,
      );
    const resolution = withFaceStatementDebt(
      resolveAt(tagged),
      tagged,
      resolveAt,
      faceDebtLines(filings, instant.periodEnd, recognized, taxonomy),
    );
    const subtracted = new Set(
      resolution.contributors.flatMap((contributor) =>
        contributor.subtract === true ? [contributor.concept] : [],
      ),
    );
    const contributors = resolution.contributors.map(({ fact, subtract }) =>
      subtract === true ? { ...fact, value: -fact.value } : fact,
    );
    const [anchor] = contributors;
    const incomplete = resolution.incompleteReason !== undefined || anchor === undefined;
    const resolveFact = (): ParsedFact | undefined => {
      if (incomplete) {
        return undefined;
      }
      return resolution.basis === "total"
        ? anchor
        : composite(contributors, subtracted, candidates);
    };
    const fact = resolveFact();
    return {
      ...instant,
      fact,
      restatements: debtRestatements(fact, resolution.basis, candidates),
      incomplete,
      incompleteReason: resolution.incompleteReason,
      basis: resolution.basis,
      lineScope: resolution.lineScope === true,
      proofSourceIds: resolution.proofSourceIds,
    };
  });
  const current = unsupersededDebtResolutions(resolved);
  const [latest] = current
    .flatMap((entry) => (entry.fact === undefined ? [] : [{ ...entry, fact: entry.fact }]))
    .toSorted((left, right) => compareFinancialStatementFacts(left.fact, right.fact));
  const notes = new Map(
    current.flatMap(({ periodEnd, filedAt, incompleteReason }) =>
      incompleteReason === undefined
        ? []
        : [[periodEnd, incompleteDebtNote(periodEnd, incompleteReason, filedAt)] as const],
    ),
  );
  const ineligible = (latest?.fact.concept.split(/[+-]/u) ?? []).flatMap((concept) =>
    unitFacts(taxonomy, root, concept).filter((fact) => !eligible(fact)),
  );
  const kept = new Set(current.flatMap((entry) => (entry.incomplete ? [] : entry.restatements)));
  const lineScoped = new Set(
    current.flatMap((entry) => (!entry.incomplete && entry.lineScope ? entry.restatements : [])),
  );
  const proofs = new Map(
    current.flatMap((entry) =>
      entry.incomplete || entry.proofSourceIds === undefined
        ? []
        : entry.restatements.map((fact) => [fact, entry.proofSourceIds] as const),
    ),
  );
  return {
    facts: [
      ...candidates.filter((fact) => kept.has(fact)),
      ...[...kept].filter((fact) => fact.composite !== undefined),
      ...ineligible,
    ].map((fact) => ({
      ...fact,
      ...(lineScoped.has(fact) ? { lineScope: true as const } : {}),
      ...(proofs.has(fact) ? { proofSourceIds: proofs.get(fact) ?? [] } : {}),
    })),
    notes: [...notes.values()],
  };
}

const FACE_DEBT_WORDS = /debt|loan|mortgage|notes|borrowing/iu;
const sumOf = (values: readonly number[]) => values.reduce((acc, value) => acc + value, 0);
const FACE_NON_DEBT_WORDS =
  /lease|receivable|warrant|tax|interest|derivative|accrued|accounts payable|accountspayable/iu;

interface FaceDebtLines {
  readonly accessionNumber: string;
  readonly sourceIds: readonly string[];
  readonly standard: ReadonlyMap<string, number>;
  readonly extensions: readonly { readonly concept: string; readonly value: number }[];
}

function faceDebtLines(
  filings: readonly ExtendedEvidenceItem[],
  periodEnd: string,
  recognized: ReadonlySet<string>,
  taxonomy: FinancialStatementTaxonomy,
): readonly FaceDebtLines[] {
  const pattern = DEBT_CONCEPTS[taxonomy].unrecognizedBorrowing;
  const classify = (text: string) => {
    const debt = FACE_DEBT_WORDS.test(text);
    return debt === FACE_NON_DEBT_WORDS.test(text) ? undefined : debt;
  };
  return filings.flatMap(({ metrics, sourceIds }) => {
    if (taxonomy !== "us-gaap" || metrics?.reportDate !== periodEnd) {
      return [];
    }
    const standard = new Map<string, number>();
    const extensions: { concept: string; value: number }[] = [];
    for (const [key, value] of Object.entries(metrics)) {
      const qualified = key.startsWith(FACE_LINE_PREFIX) ? key.split("|")[2] : undefined;
      const [prefix, concept] = qualified?.split(":") ?? [];
      if (prefix === undefined || concept === undefined || typeof value !== "number") {
        continue;
      }
      const label = String(metrics[`${FACE_LABEL_PREFIX}${qualified ?? ""}`] ?? "");
      if (prefix === "us-gaap") {
        if (recognized.has(concept) || pattern?.test(concept) === true) {
          standard.set(concept, value);
        }
        continue;
      }
      // Name and filer label must each classify the line and agree, or footing proves nothing about it.
      const debt = classify(concept);
      if (debt === undefined || debt !== classify(label)) {
        return [];
      }
      if (debt) {
        extensions.push({ concept, value });
      }
    }
    return standard.size === 0 || typeof metrics.accessionNumber !== "string"
      ? []
      : [{ accessionNumber: metrics.accessionNumber, sourceIds, standard, extensions }];
  });
}

// A face statement that foots to its subtotals lists every debt line, so it settles omission and placement gaps.
function withFaceStatementDebt(
  resolution: DebtResolution<ParsedFact>,
  tagged: ReadonlyMap<string, ParsedFact>,
  resolveAt: (lines: ReadonlyMap<string, ParsedFact>) => DebtResolution<ParsedFact>,
  faces: readonly FaceDebtLines[],
): DebtResolution<ParsedFact> {
  if (resolution.incompleteReason === undefined) {
    return resolution;
  }
  const recognized = recognizedDebtConcepts("us-gaap");
  for (const face of faces) {
    const proven = resolveAt(
      new Map(
        [...tagged].filter(([concept]) => recognized.has(concept) || !face.standard.has(concept)),
      ),
    );
    const gross = proven.contributors.filter(({ subtract }) => subtract !== true);
    const [anchor] = gross;
    if (
      anchor === undefined ||
      proven.leaseInclusive !== undefined ||
      (proven.incompleteReason !== undefined && !proven.incompleteReason.startsWith("omits ")) ||
      proven.contributors.some(({ fact }) => fact.accessionNumber !== face.accessionNumber)
    ) {
      continue;
    }
    const grossSum = sumOf(gross.map(({ fact }) => fact.value));
    const standardSum = sumOf([...face.standard.values()]);
    const extensionSum = sumOf(face.extensions.map(({ value }) => value));
    // Tagged lines either equal the standard face lines (extensions sit beside) or all face debt lines (inside).
    const beside = grossSum === standardSum;
    if (!beside && grossSum !== standardSum + extensionSum) {
      continue;
    }
    const { composite: _composite, ...base } = anchor.fact;
    const { incompleteReason: _reason, ...complete } = proven;
    const cited = { ...complete, proofSourceIds: face.sourceIds };
    return !beside || face.extensions.length === 0
      ? cited
      : {
          ...cited,
          basis: "components",
          contributors: [
            ...proven.contributors,
            ...face.extensions.map(({ concept, value }) => ({
              concept,
              fact: { ...base, concept, value, sourceIds: face.sourceIds },
            })),
          ],
        };
  }
  return resolution;
}

// Principal is face value, not the balance-sheet carrying amount EV needs, so its newer instant withholds debt.
export function withheldGrossPrincipalDebt(
  { root: taxonomyRoot, unitFacts }: DebtFactReader,
  selected: SelectedSeries,
  eligible: (fact: ParsedFact) => boolean,
): SelectedSeries {
  const root = taxonomyRoot("us-gaap");
  const net = latestFinancialStatementFact(financialStatementFacts(selected.series));
  const gross = (
    root === undefined ? [] : unitFacts("us-gaap", root, GROSS_PRINCIPAL_DEBT_CONCEPT)
  ).filter((fact) => fact.periodStart === undefined && eligible(fact));
  const [latestGross] = gross.toSorted(compareFinancialStatementFacts);
  const [grossAtNet] = gross
    .filter((fact) => fact.periodEnd === net?.periodEnd)
    .toSorted(compareFinancialStatementFacts);
  const unrecognized = DEBT_CONCEPTS["us-gaap"].unrecognizedBorrowing;
  // A borrowing line above gross principal at the same instant contradicts it as the total.
  const exceedsGross =
    latestGross !== undefined &&
    root !== undefined &&
    unrecognized !== undefined &&
    Object.keys(root)
      .filter((concept) => unrecognized.test(concept))
      .some((concept) =>
        unitFacts("us-gaap", root, concept).some(
          (fact) =>
            fact.periodStart === undefined &&
            fact.periodEnd === latestGross.periodEnd &&
            eligible(fact) &&
            fact.value > latestGross.value,
        ),
      );
  if (
    net === undefined ||
    latestGross === undefined ||
    exceedsGross ||
    !grossPrincipalWithholdsDebt(
      net,
      latestGross.periodEnd,
      grossAtNet?.value,
      US_GAAP_DEBT_DUE_WITHIN_YEAR_CONCEPTS.flatMap((concept) =>
        (root === undefined ? [] : unitFacts("us-gaap", root, concept))
          .filter(
            (fact) =>
              fact.periodStart === undefined &&
              fact.periodEnd === latestGross.periodEnd &&
              eligible(fact),
          )
          .map((fact) => fact.value),
      ),
    )
  ) {
    return selected;
  }
  return {
    ...selected,
    omissionNotes: [
      ...selected.omissionNotes,
      incompleteDebtNote(
        latestGross.periodEnd,
        `only gross principal (${GROSS_PRINCIPAL_DEBT_CONCEPT}) is tagged after ${net.periodEnd}, not the carrying amount`,
        latestGross.filedAt,
      ),
    ],
  };
}

export function debtAliasesTagged(
  { root: taxonomyRoot, unitFacts }: Pick<DebtFactReader, "root" | "unitFacts">,
  taxonomies: readonly FinancialStatementTaxonomy[],
): boolean {
  return taxonomies.some((candidate) => {
    const root = taxonomyRoot(candidate);
    return (
      root !== undefined &&
      [...recognizedDebtConcepts(candidate)].some(
        (concept) => unitFacts(candidate, root, concept).length > 0,
      )
    );
  });
}

// Same text as the SEC summary gap, which is derived from it, so dedupeSourceGaps collapses the pair.
export function financialStatementsDebtBasisGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  const withheld = withheldDebt(artifact);
  if (withheld !== undefined) {
    return [{ ...withheldDebtGap(withheld.periodEnd, withheld.reason), symbol: artifact.symbol }];
  }
  const latest = latestFinancialStatementFact(
    financialStatementFacts(artifact.statements.balanceSheet.debt),
  );
  const leaseInclusive =
    latest === undefined ? [] : unadjustedLeaseInclusiveDebt(latest.taxonomy, latest.concept);
  return latest === undefined || leaseInclusive.length === 0
    ? []
    : [{ ...leaseInclusiveDebtGap(latest.periodEnd, leaseInclusive), symbol: artifact.symbol }];
}
