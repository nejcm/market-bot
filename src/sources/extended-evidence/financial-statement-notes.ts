import { DAY_MS } from "../../config/shared";
import {
  DISCONTINUED_OPERATIONS_CONCEPTS,
  NONCONTROLLING_INCOME_CONCEPTS,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import { debtAliasesTagged } from "./sec-debt";
import {
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementNotePeriod,
  type FinancialStatementSeries,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
  type InterimCadence,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type SelectedSeries,
  TAXONOMIES,
  taxonomyRoot,
  unitFacts,
  isObservable,
  isStatementPeriod,
  periodType,
  periodKey,
} from "./financial-statement-facts";

const QUARTERLY_REPORTING_PERIOD_DAYS = 120;
const SEMIANNUAL_REPORTING_PERIOD_DAYS = 200;
const ANNUAL_REPORTING_PERIOD_DAYS = 400;

function noteSpan(start: string | undefined, end: string): string {
  return `${start ?? "instant"} to ${end}`;
}

function withheldFact(
  fact: Pick<FinancialStatementFact, "periodStart" | "periodEnd">,
  reason: string,
): Pick<FinancialStatementNote, "periods" | "reason"> {
  return {
    periods: [
      {
        ...(fact.periodStart === undefined ? {} : { start: fact.periodStart }),
        end: fact.periodEnd,
      },
    ],
    reason,
  };
}

// One note per series and reason, limited to periods its input series retains after the cap.
export function withheldDerivationNotes(
  selected: readonly SelectedSeries[],
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  return selected.flatMap(({ series, withheld = [] }) => {
    const input = series.key === "netIncome" ? income.consolidatedNetIncome : income.revenue;
    const retained = new Set(financialStatementFacts(input).map((fact) => fact.periodKey));
    const byReason = new Map<string, Map<string, FinancialStatementNotePeriod>>();
    for (const period of withheld.filter((item) => retained.has(item.periodKey))) {
      const spans = byReason.get(period.reason) ?? new Map();
      spans.set(noteSpan(period.periodStart, period.periodEnd), {
        ...(period.periodStart === undefined ? {} : { start: period.periodStart }),
        end: period.periodEnd,
      });
      byReason.set(period.reason, spans);
    }
    return [...byReason].map(([reason, spans]) => {
      const sorted = [...spans].toSorted(([left], [right]) => left.localeCompare(right));
      return {
        code: "withheld-derivation" as const,
        seriesKey: series.key,
        periods: sorted.map(([, period]) => period),
        reason,
        message: `SEC ${series.label.toLowerCase()} is not derived for ${sorted.map(([span]) => span).join(", ")}: ${reason}`,
      };
    });
  });
}

// Revenue is a continuing line; total net income for a period with discontinued operations has no margin partner.
export function untaggedContinuingIncomeNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
  analysisAsOf: string,
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  const root = taxonomy === "us-gaap" ? taxonomyRoot(payload, taxonomy) : undefined;
  if (root === undefined) {
    return [];
  }
  const discontinued = new Set(
    DISCONTINUED_OPERATIONS_CONCEPTS.flatMap((concept) => unitFacts("us-gaap", root, concept))
      .filter((fact) => fact.value !== 0 && isObservable(fact, analysisAsOf))
      .map((fact) => periodKey(fact)),
  );
  const continuing = new Set(
    financialStatementFacts(income.continuingIncome).map((f) => f.periodKey),
  );
  return financialStatementFacts(income.netIncome)
    .filter((fact) => discontinued.has(fact.periodKey) && !continuing.has(fact.periodKey))
    .map((fact) => ({
      code: "withheld-derivation" as const,
      seriesKey: "continuingIncome" as const,
      periodKey: fact.periodKey,
      ...withheldFact(
        fact,
        "discontinued operations are reported and no continuing-operations income is tagged",
      ),
      message: `SEC net margin is withheld for ${noteSpan(fact.periodStart, fact.periodEnd)}: discontinued operations are reported and no continuing-operations income is tagged`,
    }));
}

function periodKeys(series: FinancialStatementSeries): ReadonlySet<string> {
  return new Set(financialStatementFacts(series).map((fact) => fact.periodKey));
}

// Net margin needs income including NCI; parent-attributed income stands in only for a period with no NCI income.
export function untaggedConsolidatedIncomeNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
  analysisAsOf: string,
  income: FinancialStatementsArtifact["statements"]["incomeStatement"],
): readonly FinancialStatementNote[] {
  const root = taxonomy === undefined ? undefined : taxonomyRoot(payload, taxonomy);
  if (taxonomy === undefined || root === undefined) {
    return [];
  }
  const observable = (concept: string) =>
    unitFacts(taxonomy, root, concept).filter((fact) => isObservable(fact, analysisAsOf));
  const ifrsParent = new Map(
    observable("ProfitLossAttributableToOwnersOfParent").map((fact) => [
      periodKey(fact),
      fact.value,
    ]),
  );
  // IFRS netIncome is ProfitLoss, so a parent share that differs from it marks NCI.
  const ifrsDivergent =
    taxonomy === "ifrs-full"
      ? observable("ProfitLoss")
          .filter((fact) => {
            const parent = ifrsParent.get(periodKey(fact));
            return parent !== undefined && parent !== fact.value;
          })
          .map((fact) => periodKey(fact))
      : [];
  const noncontrolling = new Set([
    ...(taxonomy === "ifrs-full"
      ? ["ProfitLossAttributableToNoncontrollingInterests"]
      : NONCONTROLLING_INCOME_CONCEPTS
    )
      .flatMap(observable)
      .filter((fact) => fact.value !== 0)
      .map((fact) => periodKey(fact)),
    ...ifrsDivergent,
  ]);
  const consolidatedValues = new Map(
    financialStatementFacts(income.consolidatedNetIncome).map((fact) => [
      fact.periodKey,
      fact.value,
    ]),
  );
  const consolidated = periodKeys(income.consolidatedNetIncome);
  const consolidatedContinuing = periodKeys(income.consolidatedContinuingIncome);
  const continuing = periodKeys(income.continuingIncome);
  return financialStatementFacts(income.netIncome).flatMap((fact): FinancialStatementNote[] => {
    const span = noteSpan(fact.periodStart, fact.periodEnd);
    const consolidatedValue = consolidatedValues.get(fact.periodKey);
    if (
      !noncontrolling.has(fact.periodKey) &&
      (consolidatedValue === undefined || consolidatedValue === fact.value)
    ) {
      return [];
    }
    if (continuing.has(fact.periodKey) && !consolidatedContinuing.has(fact.periodKey)) {
      return [
        {
          code: "withheld-derivation" as const,
          seriesKey: "consolidatedContinuingIncome" as const,
          periodKey: fact.periodKey,
          ...withheldFact(
            fact,
            "noncontrolling interest income is reported and continuing income is tagged only as attributable to parent",
          ),
          message: `SEC continuing net margin is withheld for ${span}: noncontrolling interest income is reported and continuing income is tagged only as attributable to parent`,
        },
      ];
    }
    return taxonomy === "ifrs-full" || consolidated.has(fact.periodKey)
      ? []
      : [
          {
            code: "withheld-derivation" as const,
            seriesKey: "consolidatedNetIncome" as const,
            periodKey: fact.periodKey,
            ...withheldFact(
              fact,
              "noncontrolling interest income is reported and no consolidated net income including NCI is tagged",
            ),
            message: `SEC net margin is withheld for ${span}: noncontrolling interest income is reported and no consolidated net income including NCI is tagged`,
          },
        ];
  });
}

// Dropped spans stay visible as a declared gap; for dividends a non-zero one still counts as history.
export function declarationSpanNotes(
  spans: readonly ParsedFact[],
  definition: FinancialStatementSeriesDefinition,
): readonly FinancialStatementNote[] {
  const declared = spans.filter((fact) => fact.value !== 0);
  const latest = declared.toSorted((a, b) => a.periodEnd.localeCompare(b.periodEnd)).at(-1);
  return latest === undefined
    ? []
    : [
        {
          code: "declaration-span",
          seriesKey: definition.key,
          periodKey: periodKey(latest),
          message:
            definition.key === "dividendsPerShare"
              ? `SEC ${definition.label.toLowerCase()} has ${String(declared.length)} non-zero facts (latest ${periodKey(latest)}) omitted because they are declaration dates or spans shorter than a fiscal quarter`
              : `SEC ${definition.label.toLowerCase()} has ${String(declared.length)} non-zero off-period facts (latest ${periodKey(latest)}) omitted because their spans fall outside supported statement-period lengths`,
        },
      ];
}

function isNewer(aliasEnd: string | undefined, selectedEnd: string | undefined): boolean {
  return aliasEnd !== undefined && (selectedEnd === undefined || aliasEnd > selectedEnd);
}

export function staleConceptHistoryNotes(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  selected: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): readonly FinancialStatementNote[] {
  const root = taxonomyRoot(payload, taxonomy);
  const concept = selected[0]?.concept;
  if (root === undefined || concept === undefined) {
    return [];
  }
  const latestEnd = (facts: readonly ParsedFact[], annualOnly: boolean) =>
    facts
      .filter(
        (fact) =>
          eligible(fact) &&
          (annualOnly
            ? periodType(fact, definition) === "annual"
            : isStatementPeriod(fact, definition)),
      )
      .map((fact) => fact.periodEnd)
      .toSorted()
      .at(-1);
  const selectedAnnualEnd = latestEnd(selected, true);
  const selectedEnd = latestEnd(selected, false);
  const label = definition.label.toLowerCase();
  return definition.concepts[taxonomy].flatMap((alias): FinancialStatementNote[] => {
    if (alias === concept) {
      return [];
    }
    const aliasFacts = unitFacts(taxonomy, root, alias);
    const aliasAnnualEnd = latestEnd(aliasFacts, true);
    const aliasEnd = latestEnd(aliasFacts, false);
    const scope = "the tags are not combined because their scope may differ";
    if (isNewer(aliasAnnualEnd, selectedAnnualEnd)) {
      const selectedText =
        selectedAnnualEnd === undefined ? "has no annual period" : `ends ${selectedAnnualEnd}`;
      return [
        {
          code: "stale-concept-history",
          seriesKey: definition.key,
          message: `SEC ${label} annual history under ${concept} ${selectedText}, while ${alias} reports annual periods to ${aliasAnnualEnd}; ${scope}`,
        },
      ];
    }
    return isNewer(aliasEnd, selectedEnd)
      ? [
          {
            code: "stale-concept-history",
            seriesKey: definition.key,
            message: `SEC ${label} history under ${concept} ends ${selectedEnd ?? "with no eligible period"}, while ${alias} reports periods to ${aliasEnd}; ${scope}`,
          },
        ]
      : [];
  });
}

function reportingPeriodDays(cadence: InterimCadence): number {
  if (cadence === "semiannual") {
    return SEMIANNUAL_REPORTING_PERIOD_DAYS;
  }
  if (cadence === "annual-only") {
    return ANNUAL_REPORTING_PERIOD_DAYS;
  }
  return QUARTERLY_REPORTING_PERIOD_DAYS;
}

export function instantSeriesOmissionNotes(
  series: readonly FinancialStatementSeries[],
  cadence: InterimCadence,
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy | undefined,
): readonly FinancialStatementNote[] {
  // Goodwill feeds only the acquisition caveat, where an absent or lagging instant means no caveat.
  const balanceSheet = series.filter(
    (item) => item.statement === "balanceSheet" && item.key !== "goodwill",
  );
  const newestEnd = balanceSheet
    .flatMap((item) => financialStatementFacts(item).map((fact) => fact.periodEnd))
    .toSorted()
    .at(-1);
  const notes: FinancialStatementNote[] = [];
  const debt = series.find((item) => item.key === "debt");
  if (
    debt !== undefined &&
    !debtAliasesTagged(
      { root: (candidate) => taxonomyRoot(payload, candidate), unitFacts },
      taxonomy === undefined ? TAXONOMIES : [taxonomy],
    )
  ) {
    notes.push({
      code: "untagged-balance-sheet-series",
      seriesKey: "debt",
      message:
        "Debt is untagged in companyfacts; no direct or current/noncurrent component facts were selected.",
    });
  }
  if (newestEnd === undefined) {
    return notes;
  }
  const lagLimitMs = reportingPeriodDays(cadence) * DAY_MS;
  for (const item of balanceSheet) {
    const latest = latestFinancialStatementFact(financialStatementFacts(item));
    if (latest === undefined) {
      continue;
    }
    const latestMs = Date.parse(latest.periodEnd);
    const newestMs = Date.parse(newestEnd);
    if (
      !Number.isFinite(latestMs) ||
      !Number.isFinite(newestMs) ||
      newestMs - latestMs <= lagLimitMs
    ) {
      continue;
    }
    notes.push({
      code: "stale-instant-series",
      seriesKey: item.key,
      message: `${item.label} latest period end ${latest.periodEnd} lags the newest balance-sheet period end ${newestEnd} by more than one reporting period.`,
    });
  }
  return notes;
}
