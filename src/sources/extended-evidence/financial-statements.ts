import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import {
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import {
  capFinancialStatementPeriods,
  deriveFinancialStatementTtm,
  detectFinancialStatementCadence,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  financialStatementFacts,
  incompleteFinancialStatementNotes,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import {
  type DebtFactReader,
  debtScopeUnprovenNotes,
  isUnprovenDebtNote,
  factsForDebt,
  withheldGrossPrincipalDebt,
} from "./sec-debt";
import {
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementSupersedingFact,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
} from "./financial-statements-contract";
import {
  type ParsedFact,
  type SelectedSeries,
  type FinancialStatementsDeriveInput,
  TAXONOMIES,
  taxonomyRoot,
  unitFacts,
  factsForDefinition,
  revenueConceptSwitchNotes,
  compositeFromContributors,
  withCompositeFirstPublicAt,
  isObservable,
  currencyForUnit,
  periodType,
  isStatementPeriod,
  periodKey,
  toSelectedFact,
  selectRestatements,
  chronological,
} from "./financial-statement-facts";
import {
  taxonomyScore,
  selectTaxonomy,
  selectReportingCurrency,
  withoutTranslationFilings,
} from "./financial-statement-taxonomy";
import {
  firstAnnualReports,
  dividendPaymentFiled,
  unfiledSeries,
  supportedSixKFacts,
  structuredFinancialGaps,
} from "./financial-statement-filing-coverage";
import {
  withheldDerivationNotes,
  untaggedContinuingIncomeNotes,
  untaggedConsolidatedIncomeNotes,
  declarationSpanNotes,
  staleConceptHistoryNotes,
  unprovenRestatementNotes,
  instantSeriesOmissionNotes,
} from "./financial-statement-notes";
import { factsForDepreciationAndAmortization } from "./financial-statement-depreciation";
import { derivedSeriesFacts } from "./financial-statement-derived-series";
import {
  scopeAlignedOperatingCashFlow,
  discontinuedIfrsOperatingCashFlow,
  scopeMatchedCapexFacts,
  withheldExtensionCapex,
} from "./financial-statement-cash-flow-scope";
import {
  selectEnterpriseValueBridge,
  selectStatutoryTaxRate,
  selectEquityStack,
} from "./financial-statement-balance-components";
import { mixedShareBasisNotes, withoutMixedShareBasisTtm } from "./financial-statement-share-basis";
import {
  filedDurationFacts,
  isSupersedingFact,
  factPublicAt,
  supersedingFact,
  supersedingDurationFacts,
  withoutSupersededFiscalYearTtm,
} from "./financial-statement-superseding";

function expectedUnit(definition: FinancialStatementSeriesDefinition, currency: string): string {
  if (definition.unitKind === "shares") {
    return "shares";
  }
  return definition.unitKind === "per-share" ? `${currency}/shares` : currency;
}

function materializeBasis(
  raw: readonly ParsedFact[],
  definition: FinancialStatementSeriesDefinition,
  reportingCurrency: string,
  sourceId: string,
  analysisAsOf: string,
  unit: string,
  aliasFacts: readonly ParsedFact[],
): SelectedSeries {
  const observable = raw.filter((fact) => isObservable(fact, analysisAsOf));
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
    aliasFacts,
  );
  const interimSelection = selectRestatements(
    compatible.filter((fact) => periodType(fact, definition) === "interim"),
    definition.key,
    aliasFacts,
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

  const annual = annualSelection.facts
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, definition, reportingCurrency, sourceId));
  const interim = interimSelection.facts
    .toSorted(chronological)
    .map((fact) => toSelectedFact(fact, definition, reportingCurrency, sourceId));
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

function aliasConceptFacts(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  definition: FinancialStatementSeriesDefinition,
  selected: readonly ParsedFact[],
  eligible: (fact: ParsedFact) => boolean,
): readonly ParsedFact[] {
  const root = taxonomyRoot(payload, taxonomy);
  const selectedConcepts = new Set(selected.map((fact) => fact.concept));
  return root === undefined
    ? []
    : definition.concepts[taxonomy]
        .filter((concept) => !selectedConcepts.has(concept))
        .flatMap((concept) => unitFacts(taxonomy, root, concept).filter(eligible));
}

function selectSeries(
  payload: unknown,
  taxonomy: FinancialStatementTaxonomy,
  reportingCurrency: string,
  definition: FinancialStatementSeriesDefinition,
  input: FinancialStatementsDeriveInput,
): SelectedSeries {
  const unit = expectedUnit(definition, reportingCurrency);
  const eligible = (fact: ParsedFact) =>
    isObservable(fact, input.analysisAsOf) && fact.unit === unit;
  const debtReader: DebtFactReader = {
    root: (candidate) => taxonomyRoot(payload, candidate),
    unitFacts,
    composite: (contributors, subtracted, candidates) =>
      withCompositeFirstPublicAt(
        compositeFromContributors(contributors, subtracted),
        definition,
        candidates,
        subtracted,
      ),
  };
  const debt =
    definition.key === "debt"
      ? factsForDebt(debtReader, taxonomy, eligible, input.secFilings ?? [])
      : undefined;
  const depreciationAndAmortization =
    definition.key === "depreciationAndAmortization" && taxonomy === "us-gaap"
      ? factsForDepreciationAndAmortization(payload, definition, eligible, input.secFilings ?? [])
      : undefined;
  const operatingCashFlow =
    definition.key === "operatingCashFlow" && taxonomy === "us-gaap"
      ? scopeAlignedOperatingCashFlow(payload, definition, eligible)
      : undefined;
  const reported =
    debt?.facts ??
    depreciationAndAmortization?.facts ??
    operatingCashFlow?.facts ??
    factsForDefinition(payload, taxonomy, definition, eligible);
  const derived =
    operatingCashFlow !== undefined
      ? { facts: [], withheld: operatingCashFlow.withheld }
      : definition.key === "capitalExpenditure"
        ? scopeMatchedCapexFacts(
            payload,
            taxonomy,
            reported,
            eligible,
            (fact) => isObservable(fact, input.analysisAsOf),
            input.secFilings ?? [],
          )
        : taxonomy === "us-gaap"
          ? derivedSeriesFacts(payload, definition, reported, eligible, (fact) =>
              isObservable(fact, input.analysisAsOf),
            )
          : discontinuedIfrsOperatingCashFlow(payload, definition, reported, eligible);
  const basis = [
    ...reported.filter((fact) => derived?.superseded?.has(periodKey(fact)) !== true),
    ...(derived?.facts ?? []),
  ];
  const declarationSpans =
    definition.key === "dividendsPerShare"
      ? basis.filter((fact) => !isStatementPeriod(fact, definition))
      : definition.kind === "duration"
        ? basis.filter((fact) => (financialStatementPeriodMonths(fact) ?? 3) < 3)
        : [];
  const facts = basis.filter((fact) => !declarationSpans.includes(fact));
  const selected = materializeBasis(
    facts,
    definition,
    reportingCurrency,
    input.sourceId,
    input.analysisAsOf,
    unit,
    operatingCashFlow !== undefined
      ? (operatingCashFlow.datingAliases ?? [])
      : debt === undefined && depreciationAndAmortization === undefined
        ? aliasConceptFacts(payload, taxonomy, definition, facts, eligible)
        : [],
  );
  if (debt === undefined) {
    return {
      ...selected,
      ...(derived === undefined ? {} : { withheld: derived.withheld }),
      omissionNotes: [
        ...selected.omissionNotes,
        ...(depreciationAndAmortization?.notes ?? []),
        ...(derived?.notes ?? []),
        ...revenueConceptSwitchNotes(payload, taxonomy, definition, eligible),
        ...unprovenRestatementNotes(payload, taxonomy, definition, facts, input.analysisAsOf),
        ...(operatingCashFlow === undefined
          ? staleConceptHistoryNotes(payload, taxonomy, definition, facts, eligible)
          : []),
        ...declarationSpanNotes(
          declarationSpans.filter((fact) => eligible(fact)),
          definition,
        ),
      ],
    };
  }
  const withGross =
    taxonomy === "us-gaap" ? withheldGrossPrincipalDebt(debtReader, selected, eligible) : selected;
  const withNotes = { ...withGross, omissionNotes: [...withGross.omissionNotes, ...debt.notes] };
  return {
    ...withNotes,
    omissionNotes: [
      ...withNotes.omissionNotes,
      ...debtScopeUnprovenNotes(debtReader, taxonomy, eligible, withNotes),
    ],
  };
}

const DIVIDENDS_PER_SHARE = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
  (definition) => definition.key === "dividendsPerShare",
)!;
// Observed quarterly-as-annual rows sit at or below 0.332x; a semiannual rate (0.5x) still passes.
const DPS_RECONCILIATION_FLOOR = 0.4;
const DPS_FALLBACK_CEILING = 2;

export function unreconciledDividendsPerShare(
  dividendsPerShare: number,
  dilutedShares: number,
  dividendsPaid: number,
): number | undefined {
  const ratio = (dividendsPerShare * dilutedShares) / dividendsPaid;
  return ratio < DPS_RECONCILIATION_FLOOR ? ratio : undefined;
}

function reconciledDividendsPerShare(
  selected: readonly SelectedSeries[],
  taxonomy: FinancialStatementTaxonomy,
  select: (definition: FinancialStatementSeriesDefinition) => SelectedSeries,
  filed: (concept: string) => readonly ParsedFact[],
): readonly SelectedSeries[] {
  const annual = (key: FinancialStatementSeriesKey) =>
    selected.find((item) => item.series.key === key)?.series.annual ?? [];
  const [paid, shares] = [annual("dividendsPaid"), annual("dilutedShares")];
  // The DPS filing's own operands first, else the selected series; undefined is unproven.
  const reconcile = (fact: FinancialStatementFact) => {
    const chosen = (series: readonly FinancialStatementFact[]) =>
      series.find((other) => other.periodKey === fact.periodKey);
    const inFiling = (series: readonly FinancialStatementFact[]) => {
      const pick = chosen(series);
      if (pick === undefined || fact.accessionNumber === null) {
        return undefined;
      }
      return filed(pick.concept).find(
        (other) =>
          other.accessionNumber === fact.accessionNumber &&
          other.unit === pick.unit &&
          periodKey(other) === fact.periodKey,
      );
    };
    const ratioOf = (operands: readonly (ParsedFact | FinancialStatementFact | undefined)[]) => {
      const [dividends, diluted] = [Math.abs(operands[0]?.value ?? 0), operands[1]?.value ?? 0];
      // A negative figure is unproven: the metric's not-meaningful verdict, unless a fallback reconciles.
      return fact.value >= 0 && dividends > 0 && diluted > 0
        ? { fact, dividends, diluted, ratio: (fact.value * diluted) / dividends }
        : undefined;
    };
    const latest = ratioOf([chosen(paid), chosen(shares)]);
    const found = ratioOf([inFiling(paid), inFiling(shares)]) ?? latest;
    return found && { ...found, latestRatio: latest?.ratio ?? found.ratio };
  };
  const verdicts = new Map<FinancialStatementFact, ReturnType<typeof reconcile>>();
  const verdict = (fact: FinancialStatementFact) => {
    if (!verdicts.has(fact)) {
      verdicts.set(fact, reconcile(fact));
    }
    return verdicts.get(fact);
  };
  // Proof is recorded only where the latest restated operands would not reconcile.
  const proven = (fact: FinancialStatementFact): FinancialStatementFact => {
    const { dividends, diluted, ratio, latestRatio } = verdict(fact)!;
    return latestRatio >= DPS_RECONCILIATION_FLOOR
      ? fact
      : {
          ...fact,
          dividendsPaidProof: `reconciled in its own filing: DPS x ${String(diluted)} diluted shares is ${ratio.toFixed(2)}x dividends paid of ${String(dividends)}; later restated figures give ${latestRatio.toFixed(2)}x`,
        };
  };
  const ok = (fact: FinancialStatementFact) =>
    (verdict(fact)?.ratio ?? 0) >= DPS_RECONCILIATION_FLOOR;
  return selected.map((item) => {
    if (item.series.key !== "dividendsPerShare") {
      return item;
    }
    const used = new Set(item.series.annual.map((fact) => fact.concept));
    const others = DIVIDENDS_PER_SHARE.concepts[taxonomy].filter((concept) => !used.has(concept));
    const alternateSelection =
      others.length === 0 || item.series.annual.every(ok)
        ? undefined
        : select({
            ...DIVIDENDS_PER_SHARE,
            concepts: { ...DIVIDENDS_PER_SHARE.concepts, [taxonomy]: others },
          });
    const alternate = alternateSelection?.series.annual ?? [];
    const notes: FinancialStatementNote[] = [];
    const reconciled = item.series.annual.flatMap((fact) => {
      if (ok(fact)) {
        return [proven(fact)];
      }
      const fallback = alternate.find((other) => other.periodKey === fact.periodKey);
      const fallbackRatio = fallback === undefined ? undefined : verdict(fallback)?.ratio;
      if (fallbackRatio !== undefined && fallbackRatio <= DPS_FALLBACK_CEILING && ok(fallback!)) {
        return [proven(fallback!)];
      }
      const failed = verdict(fact);
      // A declared zero stands even when earlier declarations settle in this year.
      if (failed === undefined || fact.value === 0) {
        return [fact];
      }
      const reason = `${failed.fact.concept} ${String(failed.fact.value)} x ${String(failed.diluted)} diluted shares is ${failed.ratio.toFixed(2)}x dividends paid of ${String(failed.dividends)}, below the ${String(DPS_RECONCILIATION_FLOOR)}x floor`;
      notes.push({
        code: "dps-unreconciled",
        seriesKey: "dividendsPerShare",
        periodKey: fact.periodKey,
        reason,
        message: `SEC dividends per share is withheld for ${fact.periodKey}: ${reason}`,
      });
      return [];
    });
    const latest = reconciled.at(-1);
    // When the fallback supplies the newest year, interim rows follow it and the primary's staleness note no longer holds.
    if (alternateSelection !== undefined && latest !== undefined && !used.has(latest.concept)) {
      return {
        ...alternateSelection,
        series: { ...alternateSelection.series, annual: reconciled },
        validationNotes: [...item.validationNotes, ...alternateSelection.validationNotes],
        omissionNotes: [
          ...item.omissionNotes.filter((note) => note.code !== "stale-concept-history"),
          ...alternateSelection.omissionNotes,
          ...notes,
        ],
      };
    }
    return {
      ...item,
      series: { ...item.series, annual: reconciled },
      omissionNotes: [...item.omissionNotes, ...notes],
    };
  });
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
      consolidatedNetIncome: get("consolidatedNetIncome"),
      consolidatedContinuingIncome: get("consolidatedContinuingIncome"),
      continuingIncome: get("continuingIncome"),
      interestExpense: get("interestExpense"),
      incomeTaxExpense: get("incomeTaxExpense"),
      pretaxIncome: get("pretaxIncome"),
    },
    balanceSheet: {
      cash: get("cash"),
      currentAssets: get("currentAssets"),
      currentLiabilities: get("currentLiabilities"),
      totalAssets: get("totalAssets"),
      goodwill: get("goodwill"),
      totalLiabilities: get("totalLiabilities"),
      stockholdersEquity: get("stockholdersEquity"),
      debt: get("debt"),
    },
    cashFlowStatement: {
      operatingCashFlow: get("operatingCashFlow"),
      capitalExpenditure: get("capitalExpenditure"),
      depreciationAndAmortization: get("depreciationAndAmortization"),
      dividendsPaid: get("dividendsPaid"),
      shareRepurchases: get("shareRepurchases"),
    },
    perShare: {
      dilutedEps: get("dilutedEps"),
      continuingDilutedEps: get("continuingDilutedEps"),
      dilutedShares: get("dilutedShares"),
      dividendsPerShare: get("dividendsPerShare"),
    },
  };
}

export function deriveFinancialStatements(
  companyFacts: unknown,
  input: FinancialStatementsDeriveInput,
): FinancialStatementsArtifact {
  const taxonomy = selectTaxonomy(companyFacts, input.analysisAsOf);
  const election =
    taxonomy === undefined
      ? { currency: undefined, candidates: [] }
      : selectReportingCurrency(companyFacts, taxonomy, input.analysisAsOf);
  const reportingCurrency = election.currency;
  const {
    payload,
    excluded: translationFilings,
    translations,
  } = taxonomy === undefined || reportingCurrency === undefined
    ? { payload: companyFacts, excluded: new Map<string, string>(), translations: new Map() }
    : withoutTranslationFilings(companyFacts, taxonomy, reportingCurrency, input.analysisAsOf);
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
      : reconciledDividendsPerShare(
          FINANCIAL_STATEMENT_SERIES_DEFINITIONS.map((definition) =>
            withheldExtensionCapex(
              selectSeries(payload, taxonomy, reportingCurrency, definition, input),
              input.secFilings ?? [],
            ),
          ),
          taxonomy,
          (definition) => selectSeries(payload, taxonomy, reportingCurrency, definition, input),
          (concept) => unitFacts(taxonomy, taxonomyRoot(payload, taxonomy) ?? {}, concept),
        );
  const equityStackSelection =
    taxonomy === undefined || reportingCurrency === undefined
      ? { validationNotes: [] }
      : selectEquityStack(payload, taxonomy, reportingCurrency, selected, input);
  const uncapped = selected.map((item) => item.series);
  const { series: retained, notes: capNotes } = capFinancialStatementPeriods(uncapped);
  const shareBasisNotes = mixedShareBasisNotes(uncapped, retained);
  const durationFacts =
    taxonomy === undefined ? [] : filedDurationFacts(payload, taxonomy, input.analysisAsOf);
  const annualConcepts = new Set(
    retained.flatMap(({ annual }) => annual.map(({ concept }) => concept)),
  );
  const filedFacts = new Map(
    durationFacts
      .filter((fact) => annualConcepts.has(fact.concept))
      .map((fact) => [
        `${fact.concept}|${periodKey(fact)}|${fact.filedAt}|${String(fact.value)}`,
        fact,
      ]),
  );
  // A re-filed year keeps a later comparative's accession; its subsequent events sit in the first filing.
  const firstPublicFiling = (fiscalYear: FinancialStatementFact) =>
    filedFacts.get(
      `${fiscalYear.concept}|${financialStatementPeriodKey(fiscalYear)}|${fiscalYear.firstPublicAt}|${String(fiscalYear.value)}`,
    ) ?? fiscalYear;
  const byFirstPublic = durationFacts.toSorted((left, right) =>
    factPublicAt(left) < factPublicAt(right)
      ? -1
      : Number(factPublicAt(left) > factPublicAt(right)),
  );
  // Per fiscal year only the earliest-public superseding fact decides eligibility at any cutoff.
  const earliestByFiscalYear = new Map<string, FinancialStatementSupersedingFact | undefined>();
  const earliestSupersedingFact = (fiscalYear: FinancialStatementFact) => {
    const filing = firstPublicFiling(fiscalYear);
    const key = `${filing.periodEnd}|${filing.accessionNumber}|${String(filing.amendment)}`;
    if (!earliestByFiscalYear.has(key)) {
      const first = byFirstPublic.find((fact) => isSupersedingFact(fact, filing));
      earliestByFiscalYear.set(key, first === undefined ? undefined : supersedingFact(first));
    }
    return earliestByFiscalYear.get(key);
  };
  const shareBasisTtm = retained.map((item) => {
    const shareBasis = withoutMixedShareBasisTtm(item, shareBasisNotes);
    const { ttm } = shareBasis.series;
    const checked =
      shareBasis.note === undefined && ttm?.formula === "FY"
        ? withoutSupersededFiscalYearTtm(
            shareBasis.series,
            supersedingDurationFacts(firstPublicFiling(ttm.components.fiscalYear), durationFacts),
            input.analysisAsOf,
          )
        : shareBasis;
    const earliest = [
      ...new Map(
        item.annual.flatMap((fiscalYear) => {
          const first = earliestSupersedingFact(fiscalYear);
          return first === undefined ? [] : [[JSON.stringify(first), first] as const];
        }),
      ).values(),
    ];
    return { ...checked, series: { ...checked.series, supersedingFacts: earliest } };
  });
  const series = shareBasisTtm.map((item) => item.series);
  const statements = seriesRecord(series);
  const currentAnnual = latestFinancialStatementFact(
    statements.incomeStatement.revenue.annual.filter((fact) => {
      const months = financialStatementPeriodMonths(fact);
      return (
        months !== undefined &&
        months >= MIN_ANNUAL_DURATION_MONTHS &&
        months <= MAX_ANNUAL_DURATION_MONTHS
      );
    }),
  );
  const interimCadence = detectFinancialStatementCadence(series);
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
    interimCadence,
    extractionMethod: "sec-companyfacts",
    ...(equityStackSelection.equityStack !== undefined
      ? { equityStack: equityStackSelection.equityStack }
      : {}),
    ...(taxonomy === "us-gaap" && reportingCurrency !== undefined
      ? {
          enterpriseValueBridge: selectEnterpriseValueBridge(payload, reportingCurrency, input),
          statutoryTaxRate: selectStatutoryTaxRate(payload, input),
        }
      : {}),
    ...(taxonomy !== undefined
      ? {
          dividendPaymentFiled: dividendPaymentFiled(payload, taxonomy, input.analysisAsOf),
          unfiledSeries: unfiledSeries(payload, input.analysisAsOf),
          firstAnnualReports: firstAnnualReports(payload, input.analysisAsOf, translations),
        }
      : {}),
    statements,
    validationNotes: [
      ...taxonomyNotes,
      ...equityStackSelection.validationNotes,
      ...selected.flatMap((item) => item.validationNotes),
      ...shareBasisTtm.flatMap((item) => (item.note === undefined ? [] : [item.note])),
      ...incompleteFinancialStatementNotes(series),
    ],
    omissionNotes: withRetainedDebtScopeNotes(
      statements.balanceSheet.debt,
      withinRetainedWindow(series, [
        ...selected.flatMap((item) => item.omissionNotes),
        ...capNotes,
        ...withheldDerivationNotes(selected, statements.incomeStatement),
        ...untaggedContinuingIncomeNotes(
          payload,
          taxonomy,
          input.analysisAsOf,
          statements.incomeStatement,
        ),
        ...untaggedConsolidatedIncomeNotes(
          payload,
          taxonomy,
          input.analysisAsOf,
          statements.incomeStatement,
        ),
        ...instantSeriesOmissionNotes(series, interimCadence, payload, taxonomy),
        ...shareBasisNotes,
        ...translationFilingNotes(
          translationFilings,
          reportingCurrency,
          statements.incomeStatement.revenue,
        ),
      ]),
    ),
    structuredFinancialGaps: structuredFinancialGaps(
      taxonomy,
      election,
      supportedSixKFacts(payload, input.analysisAsOf),
      currentAnnual,
      input,
    ),
  };
}

function translationFilingNotes(
  filings: ReadonlyMap<string, string>,
  currency: string | undefined,
  revenue: FinancialStatementSeries,
): readonly FinancialStatementNote[] {
  if (filings.size === 0 || currency === undefined) {
    return [];
  }
  const named = [...new Set(filings.values())].toSorted().join(", ");
  const accessions = [...filings.keys()].toSorted().join(", ");
  const [earliest] = revenue.annual.map((fact) => fact.periodEnd).toSorted();
  const kept =
    earliest === undefined
      ? `no annual revenue is reported in ${currency}`
      : `annual revenue reported in ${currency} starts with the period ended ${earliest}`;
  return [
    {
      code: "translation-filing",
      message: `Excluded ${currency} convenience translations from ${filings.size} ${filings.size === 1 ? "filing" : "filings"} whose revenue is reported in ${named} (${accessions}); ${kept}`,
    },
  ];
}

// A scope note stands only on a published debt fact filed before the recast.
function withRetainedDebtScopeNotes(
  debt: FinancialStatementSeries,
  notes: readonly FinancialStatementNote[],
): readonly FinancialStatementNote[] {
  const facts = financialStatementFacts(debt);
  return notes.filter(
    (note) =>
      note.code !== "debt-scope-unproven" || facts.some((fact) => isUnprovenDebtNote(note, fact)),
  );
}

function noteShape(key: string): "instant" | "duration" {
  return key.startsWith("instant|") ? "instant" : "duration";
}

function noteCadences(key: string): readonly ("annual" | "interim")[] {
  if (key.startsWith("duration:12|")) {
    return ["annual"];
  }
  return /^duration:(3|6|9)\|/u.test(key) ? ["interim"] : ["annual", "interim"];
}

// Dividends per share has its own cap, so each note is judged against its series' cap scope.
function capScope(key: FinancialStatementSeriesKey | undefined): "dividends" | "core" {
  return key === "dividendsPerShare" ? "dividends" : "core";
}

// Outside the window: on no retained period, and older than what every cadence it may belong to shows, with at least one cadence capped.
export function withinRetainedWindow(
  series: readonly FinancialStatementSeries[],
  notes: readonly FinancialStatementNote[],
): readonly FinancialStatementNote[] {
  const capNotes = notes.filter(
    (note) =>
      note.code === "history-cap" &&
      (note.seriesKey === undefined || note.seriesKey === "dividendsPerShare"),
  );
  const window = (scope: "dividends" | "core") => {
    const scoped = series.filter((item) => capScope(item.key) === scope);
    const scopedCaps = capNotes.filter((note) => capScope(note.seriesKey) === scope);
    return {
      retained: new Set(
        scoped.flatMap((item) => financialStatementFacts(item).map((fact) => fact.periodKey)),
      ),
      emptySeries: new Set(
        scoped.filter((item) => financialStatementFacts(item).length === 0).map((item) => item.key),
      ),
      cadence: (period: "annual" | "interim", shape: string) => {
        const ends = scoped
          .flatMap((item) => item[period])
          .filter((fact) => noteShape(fact.periodKey) === shape)
          .map((fact) => fact.periodEnd)
          .toSorted();
        if (ends.length === 0) {
          return undefined;
        }
        const [dropped] = scopedCaps
          .flatMap((note) =>
            note.periodKey?.startsWith(`${period}|`)
              ? [note.periodKey.slice(period.length + 1)]
              : [],
          )
          .filter((key) => noteShape(key) === shape)
          .map((key) => key.split("|").at(-1)!)
          .toSorted()
          .toReversed();
        return {
          capped: dropped !== undefined,
          shows: (end: string) => (dropped === undefined ? end >= ends[0]! : end > dropped),
        };
      },
    };
  };
  const windows = { dividends: window("dividends"), core: window("core") };
  return notes.filter((note) => {
    const key = note.periodKey;
    const scoped = windows[capScope(note.seriesKey)];
    if (
      note.code === "history-cap" ||
      key === undefined ||
      scoped.retained.has(key) ||
      (note.seriesKey !== undefined && scoped.emptySeries.has(note.seriesKey))
    ) {
      return true;
    }
    const end = key.split("|").at(-1)!;
    const cadences = noteCadences(key).flatMap((period) => {
      const cadence = scoped.cadence(period, noteShape(key));
      return cadence === undefined ? [] : [cadence];
    });
    return (
      !cadences.some((cadence) => cadence.capped) || cadences.some((cadence) => cadence.shows(end))
    );
  });
}

export function financialStatementsHistoryGaps(
  artifact: FinancialStatementsArtifact,
): readonly SourceGap[] {
  return artifact.omissionNotes
    .filter(
      (note) =>
        note.code === "stale-concept-history" ||
        note.code === "withheld-derivation" ||
        note.code === "mixed-share-basis" ||
        note.code === "declaration-span" ||
        note.code === "translation-filing" ||
        note.code === "dps-unreconciled" ||
        note.code === "unproven-restatement" ||
        (note.code === "incomplete-composite-series" &&
          (note.seriesKey === "depreciationAndAmortization" ||
            note.seriesKey === "capitalExpenditure")),
    )
    .map((note) =>
      sourceGap({
        source: "sec-edgar",
        message: note.message,
        symbol: artifact.symbol,
        provider: "sec-edgar",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      }),
    );
}
