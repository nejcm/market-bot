import type { ExtendedEvidenceItem } from "../../domain/evidence";
import {
  EXTENSION_CAPEX_CHECKED_KEY,
  EXTENSION_CAPEX_FACT_PREFIX,
  EXTENSION_DISCONTINUED_INVESTING_PREFIX,
} from "../sec-segment-facts";
import { CAPEX_CALC_PREFIX } from "../sec-calculation-linkbase";
import {
  DISCONTINUED_OPERATIONS_CONCEPTS,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  IFRS_DISCONTINUED_OPERATIONS_CONCEPTS,
  conceptScope,
  isContinuingScope,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import { compareFinancialStatementRevisions } from "./financial-statement-selection";
import {
  type FinancialStatementNote,
  type FinancialStatementTaxonomy,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type SelectedSeries,
  taxonomyRoot,
  unitFacts,
  factsForDefinition,
  compositeFromContributors,
  withCompositeFirstPublicAt,
  type WithheldDerivation,
  periodKey,
} from "./financial-statement-facts";
import {
  type DerivedSeriesFacts,
  NO_DERIVED_FACTS,
  filingContextKey,
  withheldPeriod,
} from "./financial-statement-derived-series";

const TOTAL_OPERATING_CASH_FLOW_CONCEPT = "NetCashProvidedByUsedInOperatingActivities";
const CONTINUING_OPERATING_CASH_FLOW_CONCEPT =
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
const DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT =
  "CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations";
const DISCONTINUED_OPERATIONS_CASH_FLOW_REASON =
  "discontinued operations are reported for the period and no continuing-operations operating cash flow is tagged";

const lastFiled = (facts: readonly ParsedFact[]) => {
  const filed = new Map<string, ParsedFact>();
  for (const fact of facts) {
    const key = periodKey(fact);
    const current = filed.get(key);
    if (current === undefined || compareFinancialStatementRevisions(fact, current) < 0) {
      filed.set(key, fact);
    }
  }
  return filed;
};

// ASC 205-20: continuing OCF where tagged; a total amount stands in only for a period with no discontinued operations.
export function scopeAlignedOperatingCashFlow(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts & { readonly datingAliases?: readonly ParsedFact[] } {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return NO_DERIVED_FACTS;
  }
  const continuing = unitFacts("us-gaap", root, CONTINUING_OPERATING_CASH_FLOW_CONCEPT).filter(
    eligible,
  );
  const total = unitFacts("us-gaap", root, TOTAL_OPERATING_CASH_FLOW_CONCEPT).filter(eligible);
  const continuingFiled = lastFiled(continuing);
  const totalFiled = lastFiled(total);
  const discontinued = new Set(
    DISCONTINUED_OPERATIONS_CONCEPTS.flatMap((concept) => unitFacts("us-gaap", root, concept))
      .filter((fact) => eligible(fact) && fact.value !== 0)
      .map((fact) => periodKey(fact)),
  );
  // An equal total keeps its earlier date when no DISCONTINUED_OPERATIONS_CONCEPTS fact is nonzero.
  const useContinuing = (key: string) => {
    const [current, totalCurrent] = [continuingFiled.get(key), totalFiled.get(key)];
    return (
      current !== undefined &&
      (totalCurrent === undefined ||
        (current.filedAt >= totalCurrent.filedAt &&
          (current.value !== totalCurrent.value || discontinued.has(key))))
    );
  };
  const facts = continuing.filter((fact) => useContinuing(periodKey(fact)));
  const discontinuedCash = unitFacts(
    "us-gaap",
    root,
    DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT,
  ).filter(eligible);
  const subtracted = new Set([DISCONTINUED_OPERATING_CASH_FLOW_CONCEPT]);
  const withheld: WithheldDerivation[] = [];
  for (const fact of total) {
    const key = periodKey(fact);
    if (useContinuing(key)) {
      continue;
    }
    // ASC 230-10-45-24: total minus discontinued OCF, both from the newest filing for the period (a recast supersedes).
    const component = discontinuedCash.find(
      (candidate) =>
        fact === totalFiled.get(key) &&
        filingContextKey(candidate) !== undefined &&
        filingContextKey(candidate) === filingContextKey(fact),
    );
    if (discontinued.has(key) && component !== undefined) {
      facts.push(
        withCompositeFirstPublicAt(
          compositeFromContributors([fact, { ...component, value: -component.value }], subtracted),
          definition,
          [...total, ...discontinuedCash],
          subtracted,
        ),
      );
      continue;
    }
    if (discontinued.has(key)) {
      if (!withheld.some((period) => period.periodKey === key)) {
        withheld.push(withheldPeriod(fact, DISCONTINUED_OPERATIONS_CASH_FLOW_REASON));
      }
      continue;
    }
    facts.push(fact);
  }
  const derived = new Set(facts.map((fact) => periodKey(fact)));
  return {
    facts,
    withheld: withheld.filter((period) => !derived.has(period.periodKey)),
    datingAliases: continuing.filter((fact) => !discontinued.has(periodKey(fact))),
  };
}

const IFRS_CONTINUING_OPERATING_CASH_FLOW_CONCEPT =
  "CashFlowsFromUsedInOperatingActivitiesContinuingOperations";

// IFRS 5.33(c): a period with discontinued operations, or a tagged continuing OCF that differs from total, takes
// That continuing OCF when it is as current as the total, else is withheld.
export function discontinuedIfrsOperatingCashFlow(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): DerivedSeriesFacts | undefined {
  const root = taxonomyRoot(payload, "ifrs-full");
  if (definition.key !== "operatingCashFlow" || root === undefined) {
    return undefined;
  }
  const discontinued = new Set(
    [...IFRS_DISCONTINUED_OPERATIONS_CONCEPTS, ...DISCONTINUED_INVESTING_CONCEPTS["ifrs-full"]]
      .flatMap((concept) => unitFacts("ifrs-full", root, concept))
      .filter((fact) => eligible(fact) && fact.value !== 0)
      .map((fact) => periodKey(fact)),
  );
  const continuing = latestByPeriod(
    unitFacts("ifrs-full", root, IFRS_CONTINUING_OPERATING_CASH_FLOW_CONCEPT).filter(eligible),
  );
  const totals = latestByPeriod(reported.filter(eligible));
  const scoped = [...new Set([...totals.keys(), ...continuing.keys()])].filter(
    (key) =>
      discontinued.has(key) ||
      (continuing.has(key) &&
        totals.has(key) &&
        continuing.get(key)!.value !== totals.get(key)!.value),
  );
  const current = (key: string) => {
    const [flow, total] = [continuing.get(key), totals.get(key)];
    return flow !== undefined && (total === undefined || flow.filedAt >= total.filedAt);
  };
  return {
    facts: scoped.filter(current).map((key) => continuing.get(key)!),
    withheld: scoped
      .filter((key) => !current(key))
      .map((key) =>
        withheldPeriod(
          totals.get(key)!,
          continuing.has(key)
            ? "continuing-operations operating cash flow is older than the newest total for the period"
            : DISCONTINUED_OPERATIONS_CASH_FLOW_REASON,
        ),
      ),
    superseded: new Set(scoped),
  };
}

function latestByPeriod(facts: readonly ParsedFact[]): Map<string, ParsedFact> {
  const latest = new Map<string, ParsedFact>();
  for (const fact of facts) {
    const current = latest.get(periodKey(fact));
    if (current === undefined || compareFinancialStatementRevisions(fact, current) < 0) {
      latest.set(periodKey(fact), fact);
    }
  }
  return latest;
}

// Accession -> capex concepts its calculation linkbase subtracts inside the continuing-operations investing subtotal.
// Unioned per accession, so a proof-free item for the same filing (a debt face, say) never erases a proof.
function continuingInvestingCapex(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const proven = new Map<string, Set<string>>();
  for (const { metrics } of filings) {
    for (const [key, weight] of Object.entries(metrics ?? {})) {
      if (key.startsWith(CAPEX_CALC_PREFIX) && weight === -1) {
        const accession = String(metrics!.accessionNumber);
        proven.set(
          accession,
          (proven.get(accession) ?? new Set()).add(key.slice(CAPEX_CALC_PREFIX.length)),
        );
      }
    }
  }
  return proven;
}

const DISCONTINUED_INVESTING_CONCEPTS: Readonly<
  Record<FinancialStatementTaxonomy, readonly string[]>
> = {
  "us-gaap": [
    "CapitalExpenditureDiscontinuedOperations",
    "CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations",
  ],
  "ifrs-full": ["CashFlowsFromUsedInInvestingActivitiesDiscontinuedOperations"],
};

// Periods with a nonzero discontinued-operations capex or investing fact, tagged or issuer-extension, from any filing.
function discontinuedInvestingPeriods(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  observable: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): ReadonlySet<string> {
  const root = taxonomyRoot(payload, taxonomy);
  const tagged = (root === undefined ? [] : DISCONTINUED_INVESTING_CONCEPTS[taxonomy])
    .flatMap((concept) => unitFacts(taxonomy, root!, concept))
    .filter((fact) => observable(fact) && fact.value !== 0)
    .map((fact) => `${String(fact.periodStart)}|${fact.periodEnd}`);
  const extensions = filings.flatMap(({ metrics }) =>
    Object.entries(metrics ?? {}).flatMap(([key, value]) => {
      if (!key.startsWith(EXTENSION_DISCONTINUED_INVESTING_PREFIX) || value === 0) {
        return [];
      }
      const [, start, end] = key.slice(EXTENSION_DISCONTINUED_INVESTING_PREFIX.length).split("|");
      return [`${String(start)}|${String(end)}`];
    }),
  );
  return new Set([...tagged, ...extensions]);
}

// Beside continuing OCF: a linkbase-proven same-filing capex line is unqualified, discontinued investing evidence without that proof withholds, else the filed line carries a `capex-scope-unproven` note.
export function scopeMatchedCapexFacts(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reported: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
  observable: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): DerivedSeriesFacts {
  const operatingCashFlow = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    ({ key }) => key === "operatingCashFlow",
  );
  if (operatingCashFlow === undefined) {
    return NO_DERIVED_FACTS;
  }
  const flows =
    taxonomy === "us-gaap"
      ? scopeAlignedOperatingCashFlow(payload, operatingCashFlow, eligible).facts
      : (discontinuedIfrsOperatingCashFlow(
          payload,
          operatingCashFlow,
          factsForDefinition(payload, taxonomy, operatingCashFlow, eligible),
          eligible,
        )?.facts ?? []);
  const continuing = latestByPeriod(
    flows.filter((fact) => isContinuingScope(conceptScope(fact.concept))),
  );
  const proven = continuingInvestingCapex(filings);
  const gaapRoot = taxonomyRoot(payload, "us-gaap");
  // The linkbase arc binds only where the filing also tags the continuing subtotal for the same period.
  const subtotals = new Set(
    (gaapRoot === undefined
      ? []
      : unitFacts(
          "us-gaap",
          gaapRoot,
          "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
        )
    )
      .filter(eligible)
      .map((fact) => `${String(fact.accessionNumber)}|${periodKey(fact)}|${fact.unit}`),
  );
  const mixed = discontinuedInvestingPeriods(payload, taxonomy, observable, filings);
  const filed = latestByPeriod(
    reported.filter((fact) => eligible(fact) && continuing.has(periodKey(fact))),
  );
  const facts: ParsedFact[] = [];
  const withheld: WithheldDerivation[] = [];
  const notes: FinancialStatementNote[] = [];
  const superseded = new Set<string>();
  for (const [key, flow] of continuing) {
    const capex = reported.find(
      (fact) =>
        eligible(fact) &&
        periodKey(fact) === key &&
        fact.accessionNumber !== null &&
        fact.accessionNumber === flow.accessionNumber &&
        subtotals.has(`${fact.accessionNumber}|${key}|${fact.unit}`) &&
        proven.get(fact.accessionNumber)?.has(fact.concept) === true,
    );
    const latest = filed.get(key);
    if (capex !== undefined) {
      facts.push(capex);
      superseded.add(key);
    } else if (latest === undefined) {
      continue;
    } else if (mixed.has(`${String(latest.periodStart)}|${latest.periodEnd}`)) {
      superseded.add(key);
      withheld.push(
        withheldPeriod(
          latest,
          "operating cash flow is continuing operations, discontinued-operations investing cash flow is reported for the period, and no calculation linkbase places capital expenditure inside the continuing-operations investing subtotal",
        ),
      );
    } else {
      notes.push({
        code: "capex-scope-unproven",
        seriesKey: "capitalExpenditure",
        periodKey: key,
        message: `SEC capital expenditure for ${String(latest.periodStart)} to ${latest.periodEnd} is the filed line beside continuing-operations operating cash flow; no calculation linkbase proves it is continuing-operations only, and no discontinued-operations investing is reported for the period`,
      });
    }
  }
  return { facts, withheld, superseded, notes };
}

// IREN FY2026: hardware carried in PP&E is paid on an extension line beside the standard capex line.
export function withheldExtensionCapex(
  selected: SelectedSeries,
  filings: readonly ExtendedEvidenceItem[],
): SelectedSeries {
  const { ttm, ...series } = selected.series;
  const facts = [...series.annual, ...series.interim];
  if (series.key !== "capitalExpenditure" || facts.length === 0) {
    return selected;
  }
  const periodic = filings.filter(
    ({ metrics }) => metrics?.[EXTENSION_CAPEX_CHECKED_KEY] === "true",
  );
  if (periodic.length === 0) {
    return {
      ...selected,
      omissionNotes: [
        ...selected.omissionNotes,
        {
          code: "unchecked-extension-capex",
          seriesKey: "capitalExpenditure",
          message:
            "SEC capital expenditure is the standard PP&E payments tag only; no 10-K or 10-Q primary document was checked, so issuer-extension investing lines were not checked",
        },
      ],
    };
  }
  const checkedThrough = periodic
    .map(({ metrics }) => metrics?.reportDate)
    .filter((date): date is string => typeof date === "string")
    .toSorted()
    .at(-1);
  const unchecked = [...facts, ...(ttm === undefined ? [] : [ttm])].filter(
    ({ periodEnd }) => checkedThrough === undefined || periodEnd > checkedThrough,
  );
  const uncheckedNotes =
    unchecked.length === 0
      ? []
      : [
          {
            code: "unchecked-extension-capex" as const,
            seriesKey: "capitalExpenditure" as const,
            message: `SEC capital expenditure ending after ${checkedThrough ?? "the parsed filings"} is the standard PP&E payments tag only; no 10-K or 10-Q primary document covering it was parsed, so issuer-extension investing lines were not checked`,
          },
        ];
  const lines = periodic.flatMap(({ metrics, sourceIds }) =>
    Object.entries(metrics ?? {}).flatMap(([key, value]) => {
      const [concept, start, end, unit] = key.slice(EXTENSION_CAPEX_FACT_PREFIX.length).split("|");
      const matched = facts.find((fact) => fact.periodStart === start && fact.periodEnd === end);
      return key.startsWith(EXTENSION_CAPEX_FACT_PREFIX) &&
        typeof value === "number" &&
        matched !== undefined
        ? [{ concept, start: start!, end: end!, unit, value, matched, metrics, sourceIds }]
        : [];
    }),
  );
  if (lines.length === 0) {
    return { ...selected, omissionNotes: [...selected.omissionNotes, ...uncheckedNotes] };
  }
  const overlaps = (fact: { readonly periodStart?: string; readonly periodEnd: string }) =>
    lines.some(
      ({ start, end }) => (fact.periodStart ?? fact.periodEnd) < end && fact.periodEnd > start,
    );
  const annual = series.annual.filter((fact) => !overlaps(fact));
  const interim = series.interim.filter((fact) => !overlaps(fact));
  const kept = new Set([...annual, ...interim]);
  const ttmKept =
    ttm !== undefined &&
    !overlaps(ttm) &&
    Object.values(ttm.components).every((fact) => kept.has(fact));
  return {
    ...selected,
    series: { ...series, annual, interim, ...(ttmKept ? { ttm } : {}) },
    omissionNotes: [
      ...selected.omissionNotes,
      ...uncheckedNotes,
      ...lines.map(({ concept, start, end, unit, value, matched, metrics, sourceIds }) => ({
        code: "incomplete-composite-series" as const,
        seriesKey: "capitalExpenditure" as const,
        periodKey: matched.periodKey,
        message: `SEC capital expenditure for ${start} to ${end} omitted: ${String(metrics?.form)} ${String(metrics?.accessionNumber)} (${sourceIds.join(", ")}) also tags issuer-extension PP&E-like investing payment ${String(concept)} ${String(value)} ${String(unit)} beside the standard PP&E line (${String(matched.value)} ${matched.unit}), so neither is proven to be total capex`,
      })),
    ],
  };
}
