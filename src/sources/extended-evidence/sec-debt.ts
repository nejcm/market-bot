import type { ExtendedEvidenceItem } from "../../domain/evidence";
import type { SourceGap } from "../../domain/sources";
import { FACE_LABEL_PREFIX, FACE_LINE_PREFIX, PRIOR_FACE_LINE_PREFIX } from "../sec-segment-facts";
import { isDebtBasisGap, leaseInclusiveDebtGap, withheldDebtGap } from "./sec-fundamentals-format";
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
  type DebtFaceSide,
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

export function isWithheldDebtNote(note: FinancialStatementNote): boolean {
  return (
    (note.code === "incomplete-composite-series" || note.code === "debt-held-for-sale") &&
    note.seriesKey === "debt"
  );
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
        isWithheldDebtNote(candidate) &&
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
    const resolveAt = (lines: ReadonlyMap<string, ParsedFact>, face?: FaceDebtLines) =>
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
        (concept, side) =>
          face !== undefined &&
          face.sides.get(concept) === side &&
          lines.get(concept)?.accessionNumber === face.accessionNumber &&
          lines.get(concept)?.value === face.standard.get(concept),
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
      faceLeases: resolution.faceLeases,
    };
  });
  const current = unsupersededDebtResolutions(resolved);
  const [latest] = current
    .flatMap((entry) => (entry.fact === undefined ? [] : [{ ...entry, fact: entry.fact }]))
    .toSorted((left, right) => compareFinancialStatementFacts(left.fact, right.fact));
  // A newer filing's complete resolution of the instant publishes it, so older withholds are moot (ORCL 10-Q prior-year columns).
  const notes = new Map(
    current.flatMap(({ periodEnd, filedAt, incompleteReason }) =>
      incompleteReason === undefined ||
      current.some(
        (other) => !other.incomplete && other.periodEnd === periodEnd && other.filedAt > filedAt,
      )
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
  const faceLeases = new Map(
    current.flatMap((entry) =>
      entry.incomplete || entry.faceLeases === undefined
        ? []
        : entry.restatements.map((fact) => [fact, entry.faceLeases] as const),
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
      ...(faceLeases.has(fact) ? { faceLeases: faceLeases.get(fact) ?? [] } : {}),
    })),
    notes: [
      ...notes.values(),
      ...heldForSaleDebtNotes(unitFacts, taxonomy, root, eligible, candidates),
    ],
  };
}

const DISPOSAL_GROUP_LIABILITY_CONCEPTS: Readonly<
  Record<FinancialStatementTaxonomy, readonly string[]>
> = {
  "us-gaap": [
    "LiabilitiesOfDisposalGroupIncludingDiscontinuedOperation",
    "LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent",
    "LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationNoncurrent",
  ],
  "ifrs-full": ["LiabilitiesIncludedInDisposalGroupsClassifiedAsHeldForSale"],
};

// A disposal group's liabilities carry no debt breakdown, so an instant with no debt line stays unproven.
function heldForSaleDebtNotes(
  unitFacts: DebtFactReader["unitFacts"],
  taxonomy: FinancialStatementTaxonomy,
  root: Record<string, unknown>,
  eligible: (fact: ParsedFact) => boolean,
  debtCandidates: readonly ParsedFact[],
): readonly FinancialStatementNote[] {
  const withDebt = new Set(debtCandidates.map(({ periodEnd }) => periodEnd));
  const held = new Map<string, ParsedFact>();
  for (const fact of DISPOSAL_GROUP_LIABILITY_CONCEPTS[taxonomy].flatMap((concept) =>
    unitFacts(taxonomy, root, concept),
  )) {
    if (
      fact.periodStart === undefined &&
      fact.value !== 0 &&
      eligible(fact) &&
      !withDebt.has(fact.periodEnd) &&
      !held.has(fact.periodEnd)
    ) {
      held.set(fact.periodEnd, fact);
    }
  }
  return [...held.values()].map(({ periodEnd, filedAt, concept, accessionNumber }) => ({
    code: "debt-held-for-sale",
    seriesKey: "debt",
    periodKey: `instant|${periodEnd}`,
    publicAt: filedAt,
    message: `Debt for ${periodEnd} is incomplete: ${concept} (${accessionNumber ?? "accession not filed"}) files liabilities held for sale and no standard ${taxonomy} debt concept is tagged for that date, so continuing-operations debt is unproven.`,
  }));
}

const FACE_DEBT_WORDS = /debt|loan|mortgage|notes|borrowing/iu;
const sumOf = (values: readonly number[]) => values.reduce((acc, value) => acc + value, 0);
const FACE_NON_DEBT_WORDS =
  /lease|receivable|warrant|tax|interest|derivative|accrued|accounts payable|accountspayable/iu;

// Standard borrowings whose scope varies by filer (AAOI current + noncurrent), so only a face row places them.
const FACE_SCOPED_BORROWINGS: ReadonlySet<string> = new Set(["LongTermNotesAndLoans"]);
// Rejects only, never counts, so widening it is safe.
const BORROWING_HINT = /notes|loan|debt|borrowing|credit|lease|obligation|commitment/iu;
const KNOWN_NON_BORROWING_ROWS: ReadonlySet<string> = new Set([
  ...(DEBT_CONCEPTS["us-gaap"].ambiguousLongTermDebt?.noncurrentIdentity.others ?? []),
  ...(DEBT_CONCEPTS["us-gaap"].ambiguousLongTermDebt?.noncurrentIdentity.currentOthers ?? []),
  "AssetRetirementObligationsNoncurrent",
  "AssetRetirementObligationsCurrent",
  "AssetRetirementObligation",
]);

interface FaceDebtLines {
  readonly accessionNumber: string;
  readonly sourceIds: readonly string[];
  readonly standard: ReadonlyMap<string, number>;
  readonly sides: ReadonlyMap<string, DebtFaceSide>;
  readonly extensions: readonly { readonly concept: string; readonly value: number }[];
  readonly rejected?: string;
}

function faceDebtLines(
  filings: readonly ExtendedEvidenceItem[],
  periodEnd: string,
  recognized: ReadonlySet<string>,
  taxonomy: FinancialStatementTaxonomy,
): readonly FaceDebtLines[] {
  const pattern = DEBT_CONCEPTS[taxonomy].unrecognizedBorrowing;
  const noRows = {
    standard: new Map<string, number>(),
    sides: new Map<string, DebtFaceSide>(),
    extensions: [],
  };
  const classify = (text: string) => {
    const debt = FACE_DEBT_WORDS.test(text);
    return debt === FACE_NON_DEBT_WORDS.test(text) ? undefined : debt;
  };
  return filings.flatMap(({ metrics, sourceIds }): readonly FaceDebtLines[] => {
    if (taxonomy !== "us-gaap" || metrics === undefined) {
      return [];
    }
    const linePrefix =
      metrics.reportDate === periodEnd
        ? FACE_LINE_PREFIX
        : `${PRIOR_FACE_LINE_PREFIX}${periodEnd}|`;
    const reject = (concept: string): readonly FaceDebtLines[] =>
      typeof metrics.accessionNumber === "string"
        ? [{ ...noRows, accessionNumber: metrics.accessionNumber, sourceIds, rejected: concept }]
        : [];
    const standard = new Map<string, number>();
    const sides = new Map<string, DebtFaceSide>();
    const extensions: { concept: string; value: number }[] = [];
    for (const [key, value] of Object.entries(metrics)) {
      const [side, qualified] = key.startsWith(linePrefix)
        ? key.slice(linePrefix.length).split("|")
        : [];
      const [prefix, concept] = qualified?.split(":") ?? [];
      if (prefix === undefined || concept === undefined || typeof value !== "number") {
        continue;
      }
      const labelKey =
        linePrefix === FACE_LINE_PREFIX ? qualified : `${periodEnd}|${qualified ?? ""}`;
      const label = String(metrics[`${FACE_LABEL_PREFIX}${labelKey ?? ""}`] ?? "");
      if (prefix === "us-gaap") {
        if (recognized.has(concept) || pattern?.test(concept) === true) {
          standard.set(concept, value);
          sides.set(concept, side === "current" ? "current" : "noncurrent");
          continue;
        }
        if (FACE_SCOPED_BORROWINGS.has(concept)) {
          extensions.push({ concept, value });
        } else if (
          value !== 0 &&
          !KNOWN_NON_BORROWING_ROWS.has(concept) &&
          (BORROWING_HINT.test(concept) ||
            BORROWING_HINT.test(label) ||
            (label === "" && classify(concept) !== false))
        ) {
          return reject(concept);
        }
        continue;
      }
      // Debt needs name and label to agree; only both naming non-debt words (lease, tax) clears a borrowing hint.
      const named = classify(concept);
      const labelled = classify(label);
      if (named === true && labelled === true) {
        extensions.push({ concept, value });
      } else if (
        named === true ||
        labelled === true ||
        ((named === undefined || labelled === undefined) &&
          (BORROWING_HINT.test(concept) || BORROWING_HINT.test(label)))
      ) {
        return reject(concept);
      }
    }
    const unproven = extensions.find(({ value }) => value !== 0);
    if (standard.size === 0 && unproven !== undefined) {
      return reject(unproven.concept);
    }
    return standard.size === 0 || typeof metrics.accessionNumber !== "string"
      ? []
      : [{ accessionNumber: metrics.accessionNumber, sourceIds, standard, sides, extensions }];
  });
}

// A face statement that foots to its subtotals lists every debt line, so it settles omission and placement gaps.
function withFaceStatementDebt(
  resolution: DebtResolution<ParsedFact>,
  tagged: ReadonlyMap<string, ParsedFact>,
  resolveAt: (
    lines: ReadonlyMap<string, ParsedFact>,
    face?: FaceDebtLines,
  ) => DebtResolution<ParsedFact>,
  allFaces: readonly FaceDebtLines[],
): DebtResolution<ParsedFact> {
  const rejected = allFaces.find(
    ({ accessionNumber, rejected: concept }) =>
      concept !== undefined &&
      resolution.contributors.some(({ fact }) => fact.accessionNumber === accessionNumber),
  );
  if (rejected !== undefined) {
    return {
      ...resolution,
      incompleteReason: `face statement presents ${rejected.rejected} as a possible borrowing outside the recognized debt lines`,
    };
  }
  const faces = allFaces.filter((face) => face.rejected === undefined);
  // Same-concept rows of a footed same-filing face settle LongTermDebt scope and current-line placement.
  const placed = faces
    .map((face) => ({ face, candidate: resolveAt(tagged, face) }))
    .find(
      ({ face, candidate }) =>
        candidate.incompleteReason === undefined && presentsAll(face, candidate),
    )?.candidate;
  if (resolution.incompleteReason === undefined || placed !== undefined) {
    return withFaceRowsChecked(
      resolution.incompleteReason === undefined ? resolution : (placed ?? resolution),
      tagged,
      resolveAt,
      faces,
    );
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

const presentsAll = (face: FaceDebtLines, proven: DebtResolution<ParsedFact>) =>
  proven.contributors.length > 0 &&
  proven.contributors.every(({ fact }) => fact.accessionNumber === face.accessionNumber) &&
  proven.contributors.every(({ concept, subtract }) => subtract || face.standard.has(concept));

// When every gross line is its own same-filing face row, other face debt rows sit beside them, not inside.
function withFaceRowsChecked(
  resolution: DebtResolution<ParsedFact>,
  tagged: ReadonlyMap<string, ParsedFact>,
  resolveAt: (
    lines: ReadonlyMap<string, ParsedFact>,
    face?: FaceDebtLines,
  ) => DebtResolution<ParsedFact>,
  faces: readonly FaceDebtLines[],
): DebtResolution<ParsedFact> {
  const leases = DEBT_CONCEPTS["us-gaap"].financeLeases;
  const leaseConcepts = new Set(leases === undefined ? [] : [leases.total, ...leases.split]);
  const face = faces.find((candidate) => presentsAll(candidate, resolution));
  if (face === undefined) {
    return withOffFaceTotalChecked(resolution, faces, leaseConcepts);
  }
  const faceLeases = new Set(
    resolution.contributors.flatMap(({ concept, subtract }) =>
      subtract === true && face.standard.has(concept) ? [concept] : [],
    ),
  );
  const offFaceLease = resolution.contributors.find(
    ({ concept, subtract }) =>
      subtract === true && concept === leases?.total && !face.standard.has(concept),
  );
  const splitFaceLease = [...face.standard].find(
    ([concept, value]) => value !== 0 && leaseConcepts.has(concept) && !faceLeases.has(concept),
  );
  if (offFaceLease !== undefined && splitFaceLease !== undefined) {
    return {
      ...resolution,
      incompleteReason: `face statement presents ${splitFaceLease[0]} on its own row, so the part of ${offFaceLease.concept} inside the debt lines is unknown`,
    };
  }
  const conflicting = resolution.contributors.filter(
    ({ concept, fact }) => face.standard.has(concept) && face.standard.get(concept) !== fact.value,
  );
  if (conflicting.length > 0) {
    return {
      ...resolution,
      incompleteReason: `face statement amounts differ from tagged ${conflicting.map(({ concept }) => concept).join(", ")}`,
    };
  }
  const proven =
    faceLeases.size === 0
      ? resolution
      : resolveAt(new Map([...tagged].filter(([concept]) => !faceLeases.has(concept))), face);
  // Complete-path contributors are us-gaap tags, so no extension row is among them.
  const omitted = [
    ...[...face.standard]
      .filter(
        ([concept, value]) =>
          value !== 0 &&
          !leaseConcepts.has(concept) &&
          !proven.contributors.some((contributor) => contributor.concept === concept),
      )
      .map(([concept]) => concept),
    ...face.extensions.filter(({ value }) => value !== 0).map(({ concept }) => concept),
  ];
  const reason =
    proven.incompleteReason ??
    (!presentsAll(face, proven)
      ? "face statement lease rows leave lines outside the same-filing face"
      : omitted.length > 0
        ? `face statement presents ${omitted.join(", ")} outside the resolved debt lines`
        : undefined);
  if (reason !== undefined) {
    return { ...proven, incompleteReason: reason };
  }
  return faceLeases.size === 0
    ? proven
    : { ...proven, proofSourceIds: face.sourceIds, faceLeases: [...faceLeases] };
}

// A footed same-filing face lists every debt row, so an off-face total must equal their sum to publish.
function withOffFaceTotalChecked(
  resolution: DebtResolution<ParsedFact>,
  faces: readonly FaceDebtLines[],
  leaseConcepts: ReadonlySet<string>,
): DebtResolution<ParsedFact> {
  const gross = resolution.contributors.filter(({ subtract }) => subtract !== true);
  const face = faces.find(
    (candidate) =>
      gross.length > 0 &&
      gross.every(({ fact }) => fact.accessionNumber === candidate.accessionNumber),
  );
  if (face === undefined || resolution.incompleteReason !== undefined) {
    return resolution;
  }
  if (resolution.contributors.some(({ subtract }) => subtract === true)) {
    return {
      ...resolution,
      incompleteReason:
        "lease deduction from an off-face total is not proven by the face statement",
    };
  }
  const total = sumOf(resolution.contributors.map(({ fact }) => fact.value));
  const faceTotal = sumOf([
    ...[...face.standard]
      .filter(([concept]) => !leaseConcepts.has(concept))
      .map(([, value]) => value),
    ...face.extensions.map(({ value }) => value),
  ]);
  return Math.round(total) === Math.round(faceTotal)
    ? resolution
    : {
        ...resolution,
        incompleteReason: `face statement debt rows total ${faceTotal}, not the off-face ${resolution.contributors.map(({ concept }) => concept).join(", ")} ${total}`,
      };
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

// The collector puts these in place of the faceless SEC summary copies (isDebtBasisGap).
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
  const concepts = latest === undefined ? undefined : DEBT_CONCEPTS[latest.taxonomy];
  const faceSides = new Set<string>(
    (latest?.faceLeases ?? []).map((lease) =>
      lease === concepts?.financeLeases?.split[0]
        ? "current"
        : lease === concepts?.financeLeases?.split[1]
          ? "noncurrent"
          : "total",
    ),
  );
  const leaseInclusive =
    latest === undefined
      ? []
      : unadjustedLeaseInclusiveDebt(latest.taxonomy, latest.concept).filter(
          (concept) => !faceSides.has(concepts?.leaseInclusive?.[concept] ?? ""),
        );
  return latest === undefined || leaseInclusive.length === 0
    ? []
    : [{ ...leaseInclusiveDebtGap(latest.periodEnd, leaseInclusive), symbol: artifact.symbol }];
}

// The SEC summary derives debt without filing faces; the statements' face-aware gaps take its slot.
export function withStatementDebtBasisGaps(
  summaryGaps: readonly SourceGap[],
  artifact: FinancialStatementsArtifact | undefined,
): readonly SourceGap[] {
  if (artifact === undefined) {
    return summaryGaps;
  }
  const ownDebtBasis = (gap: SourceGap) => isDebtBasisGap(gap) && gap.symbol === artifact.symbol;
  const slot = summaryGaps.findIndex(ownDebtBasis);
  const own = summaryGaps.filter(ownDebtBasis);
  const [template] = own;
  const replaced = own.map((gap) => gap.message);
  const replacements = financialStatementsDebtBasisGaps(artifact).map((gap) => gap.message);
  if (
    template === undefined ||
    (replaced.length === replacements.length &&
      replaced.every((message, index) => message === replacements[index]))
  ) {
    return summaryGaps;
  }
  const kept = summaryGaps.filter((gap) => !ownDebtBasis(gap));
  return [
    ...kept.slice(0, slot),
    ...replacements.map((message) => ({ ...template, message })),
    ...kept.slice(slot),
  ];
}
