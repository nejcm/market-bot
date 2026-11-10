import {
  ENTERPRISE_VALUE_BRIDGE_CONCEPTS,
  TEMPORARY_EQUITY_CONCEPT_PRIORITY,
  trimToMezzaninePeriods,
} from "./enterprise-value-bridge";
import {
  EXTENSION_INVESTMENTS_SOURCE_INFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX,
  EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX,
} from "../sec-extension-investments-proof";
import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "./financial-statement-definitions";
import { compareFinancialStatementFacts } from "./financial-statement-selection";
import {
  type FinancialStatementFact,
  ENTERPRISE_VALUE_BRIDGE_FACT_KEYS,
  type FinancialStatementEnterpriseValueBridge,
  type FinancialStatementEquityStack,
  type FinancialStatementNote,
  type FinancialStatementSeriesKey,
  type FinancialStatementTaxonomy,
  ZERO_BORROWINGS_EXTRACTION_METHOD,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type SelectedSeries,
  type FinancialStatementsDeriveInput,
  parseFact,
  taxonomyRoot,
  unitFacts,
  isObservable,
  periodType,
  periodKey,
  withFirstPublicAt,
  toSelectedFact,
  chronological,
} from "./financial-statement-facts";

const EQUITY_INCLUDING_NONCONTROLLING_CONCEPT =
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest";
const MINORITY_INTEREST_CONCEPT = "MinorityInterest";
const STATUTORY_TAX_RATE_CONCEPT =
  "EffectiveIncomeTaxRateReconciliationAtFederalStatutoryIncomeTaxRate";
type EquityStackComponentKey =
  | "minorityInterest"
  | "stockholdersEquityIncludingNoncontrollingInterest"
  | "temporaryEquity";

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

function selectInstantComponent(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  concepts: (root: Record<string, unknown>) => readonly string[],
  preferredAccessions: ReadonlyMap<string, string>,
  input: FinancialStatementsDeriveInput,
): readonly FinancialStatementFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  if (root === undefined) {
    return [];
  }
  const priority = new Map(concepts(root).map((concept, index) => [concept, index]));
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
    .map((facts) =>
      withFirstPublicAt(
        facts.toSorted(
          (left, right) =>
            Number(right.accessionNumber === preferredAccessions.get(right.periodEnd)) -
              Number(left.accessionNumber === preferredAccessions.get(left.periodEnd)) ||
            (priority.get(left.concept) ?? Number.MAX_SAFE_INTEGER) -
              (priority.get(right.concept) ?? Number.MAX_SAFE_INTEGER) ||
            compareFinancialStatementFacts(left, right),
        )[0]!,
        facts,
      ),
    )
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, instantDefinition, reportingCurrency, input.sourceId));
}

// A short-term investments line the filing's own instance proves, dated by that filing's companyfacts AssetsCurrent.
// A proof companyfacts cannot confirm withholds its instant rather than letting it read as untagged 0.
function extensionShortTermInvestments(
  root: Record<string, unknown>,
  reportingCurrency: string,
  input: FinancialStatementsDeriveInput,
  tagged: readonly FinancialStatementFact[],
): readonly FinancialStatementFact[] {
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === "stockholdersEquity",
  );
  if (definition === undefined) {
    return [];
  }
  const taggedPeriods = new Set(tagged.map(({ periodEnd }) => periodEnd));
  const observable = (concept: string) =>
    unitFacts("us-gaap", root, concept).filter(
      (fact) => fact.periodStart === undefined && isObservable(fact, input.analysisAsOf),
    );
  const assetsCurrent = observable("AssetsCurrent");
  const proved = (input.secFilings ?? []).flatMap(({ metrics, sourceIds }) =>
    Object.entries(metrics ?? {}).flatMap<FinancialStatementFact>(([key, value]) => {
      const [periodEnd = "", currency, concept = "", total] = key
        .slice(EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX.length)
        .split("|");
      const proof = metrics?.[`${EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX}${periodEnd}`];
      if (
        !key.startsWith(EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX) ||
        typeof value !== "number" ||
        typeof proof !== "string" ||
        taggedPeriods.has(periodEnd)
      ) {
        return [];
      }
      const accession = metrics?.accessionNumber;
      const filed = assetsCurrent.find(
        (fact) => fact.periodEnd === periodEnd && fact.accessionNumber === accession,
      );
      const withheld =
        currency !== reportingCurrency
          ? `the proof is in ${String(currency)}, not reporting currency ${reportingCurrency}`
          : filed === undefined
            ? `companyfacts carry no AssetsCurrent from ${String(accession)} at ${periodEnd} to confirm it`
            : filed.unit !== reportingCurrency || String(filed.value) !== total
              ? `companyfacts AssetsCurrent ${String(filed.value)} ${filed.unit} from ${String(accession)} does not match the instance total ${String(total)}`
              : undefined;
      const form = String(metrics?.form ?? "");
      const template =
        filed ??
        Object.keys(root)
          .flatMap(observable)
          .find((fact) => fact.periodEnd === periodEnd) ??
        parseFact(
          {
            val: value,
            form,
            accn: accession,
            filed: metrics?.filingDate,
            end: periodEnd,
            fp: form.startsWith("10-K") ? "FY" : "Q",
          },
          "us-gaap",
          concept,
          reportingCurrency,
        );
      if (template === undefined) {
        return [];
      }
      const filedAt =
        withheld === undefined || typeof metrics?.filingDate !== "string"
          ? template.filedAt
          : metrics.filingDate;
      return [
        {
          ...toSelectedFact(
            {
              ...template,
              ...(typeof accession === "string" ? { accessionNumber: accession } : {}),
              filedAt,
              firstPublicAt: filedAt,
              concept,
              value,
              unit: reportingCurrency,
              proofSourceIds: sourceIds.filter(
                (id, index) => index === 0 || id.includes(EXTENSION_INVESTMENTS_SOURCE_INFIX),
              ),
            },
            definition,
            reportingCurrency,
            input.sourceId,
          ),
          extractionMethod: ZERO_BORROWINGS_EXTRACTION_METHOD,
          ...(withheld === undefined
            ? { shortTermInvestmentsProof: proof }
            : {
                shortTermInvestmentsWithheld: `${concept} proven from the XBRL instance but withheld: ${withheld}`,
              }),
        },
      ];
    }),
  );
  // The latest filing wins an instant, dated from when its value first held (as compareFinancialStatementRevisions).
  const periods = new Map<string, FinancialStatementFact[]>();
  for (const fact of proved.toSorted((left, right) => left.filedAt.localeCompare(right.filedAt))) {
    periods.set(fact.periodEnd, [...(periods.get(fact.periodEnd) ?? []), fact]);
  }
  return [...periods.values()].map((facts) => {
    const latest = facts.at(-1)!;
    const same = (fact: FinancialStatementFact) =>
      fact.value === latest.value &&
      fact.shortTermInvestmentsWithheld === latest.shortTermInvestmentsWithheld;
    const changed = facts.findLastIndex((fact) => !same(fact));
    return { ...latest, firstPublicAt: facts[changed + 1]!.filedAt };
  });
}

export function selectEnterpriseValueBridge(
  payload: unknown,
  reportingCurrency: string,
  input: FinancialStatementsDeriveInput,
): FinancialStatementEnterpriseValueBridge {
  const select = (key: keyof FinancialStatementEnterpriseValueBridge) =>
    selectInstantComponent(
      payload,
      "us-gaap",
      reportingCurrency,
      () => ENTERPRISE_VALUE_BRIDGE_CONCEPTS[key],
      new Map(),
      input,
    );
  const selected = Object.fromEntries(
    ENTERPRISE_VALUE_BRIDGE_FACT_KEYS.map((key) => [key, select(key)]),
  ) as unknown as FinancialStatementEnterpriseValueBridge;
  return trimToMezzaninePeriods({
    ...selected,
    shortTermInvestments: [
      ...selected.shortTermInvestments,
      ...extensionShortTermInvestments(
        taxonomyRoot(payload, "us-gaap") ?? {},
        reportingCurrency,
        input,
        selected.shortTermInvestments,
      ),
    ].toSorted(chronological),
  });
}

export function selectStatutoryTaxRate(
  payload: unknown,
  input: FinancialStatementsDeriveInput,
): readonly FinancialStatementFact[] {
  const root = taxonomyRoot(payload, "us-gaap");
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === "incomeTaxExpense",
  )!;
  const annual = (
    root === undefined ? [] : unitFacts("us-gaap", root, STATUTORY_TAX_RATE_CONCEPT)
  ).filter(
    (fact) =>
      fact.unit === "pure" &&
      fact.periodStart !== undefined &&
      isObservable(fact, input.analysisAsOf) &&
      periodType(fact, definition) === "annual",
  );
  const byPeriod = new Map<string, ParsedFact[]>();
  for (const fact of annual) {
    byPeriod.set(periodKey(fact), [...(byPeriod.get(periodKey(fact)) ?? []), fact]);
  }
  return [...byPeriod.values()]
    .map((facts) => withFirstPublicAt(facts.toSorted(compareFinancialStatementFacts)[0]!, facts))
    .toSorted(chronological)
    .map((fact) => ({
      ...toSelectedFact(fact, definition, "", input.sourceId),
      currency: null,
    }));
}

export function selectEquityStack(
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
    minorityInterest: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "minorityInterest"),
      preferredAccessions,
      input,
    ),
    stockholdersEquityIncludingNoncontrollingInterest: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "stockholdersEquityIncludingNoncontrollingInterest"),
      preferredAccessions,
      input,
    ),
    temporaryEquity: selectInstantComponent(
      payload,
      taxonomy,
      reportingCurrency,
      (root) => equityStackConcepts(root, "temporaryEquity"),
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
