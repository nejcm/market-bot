import { ZERO_BORROWINGS_EXTRACTION_METHOD } from "../sources/extended-evidence/financial-statements-contract";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "../sources/extended-evidence/financial-statements-contract";
import {
  capFinancialStatementPeriods,
  detectFinancialStatementCadence,
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodKey,
  financialStatementPeriodMonths,
  financialStatementSeries,
  financialStatementSeriesByKey,
  incompleteFinancialStatementNotes,
  latestFinancialStatementFact,
} from "../sources/extended-evidence/financial-statement-selection";
import { DEPRECIATION_AND_AMORTIZATION_COMPONENTS } from "../sources/extended-evidence/financial-statement-definitions";
import { identityTolerance } from "../sources/extended-evidence/untagged-financial-table-validation";

interface DurationFactProjection {
  readonly seriesKey: FinancialStatementSeriesKey;
  readonly periodType: "annual" | "interim";
  readonly periodKey: string;
  readonly periodEnd: string;
  readonly value: number;
  readonly currency: string | null;
  readonly unit: string;
  readonly unitScale: number;
}

type FinancialInvariantCheck = (
  condition: boolean,
  code: string,
  message: string,
  periodEnd?: string,
) => void;

export interface FinancialInvariantResult {
  readonly code: string;
  readonly assertedCount: number;
  readonly failingCount: number;
  readonly assertedPeriodCount: number | null;
  readonly failingPeriodCount: number | null;
  readonly latestFailingPeriodEnd: string | null;
}

export function invariant(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[${code}] ${message}`);
  }
}

function noteKey(note: FinancialStatementsArtifact["validationNotes"][number]): string {
  return JSON.stringify([note.code, note.seriesKey ?? null, note.periodKey ?? null, note.message]);
}

function durationProjection(
  series: readonly FinancialStatementSeries[],
): readonly DurationFactProjection[] {
  return series
    .flatMap((item) =>
      (["annual", "interim"] as const).flatMap((periodType) =>
        item[periodType].flatMap((fact) =>
          fact.periodStart === undefined
            ? []
            : [
                {
                  seriesKey: item.key,
                  periodType,
                  periodKey: fact.periodKey,
                  periodEnd: fact.periodEnd,
                  value: fact.value,
                  currency: fact.currency,
                  unit: fact.unit,
                  unitScale: fact.unitScale,
                },
              ],
        ),
      ),
    )
    .toSorted((left, right) =>
      `${left.seriesKey}|${left.periodType}|${left.periodKey}`.localeCompare(
        `${right.seriesKey}|${right.periodType}|${right.periodKey}`,
      ),
    );
}

export function assertRetainedDurationFactsIdentical(
  retained: readonly DurationFactProjection[],
  independentlyCapped: readonly DurationFactProjection[],
  check: FinancialInvariantCheck = invariant,
): void {
  check(
    JSON.stringify(retained) === JSON.stringify(independentlyCapped),
    "A1",
    "instant facts changed the duration facts retained by the period cap",
  );
}

function assertCapShapeIndependence(
  series: readonly FinancialStatementSeries[],
  check: FinancialInvariantCheck,
): void {
  const durationOnly = series.map((item) => ({
    ...item,
    annual: item.annual.filter((fact) => fact.periodStart !== undefined),
    interim: item.interim.filter((fact) => fact.periodStart !== undefined),
  }));
  const independentlyCapped = capFinancialStatementPeriods(durationOnly).series;
  assertRetainedDurationFactsIdentical(
    durationProjection(series),
    durationProjection(independentlyCapped),
    check,
  );
}

function assertPeriodStructure(
  series: FinancialStatementSeries,
  check: FinancialInvariantCheck,
): void {
  for (const periodType of ["annual", "interim"] as const) {
    const facts = series[periodType];
    const periodKeys = new Set<string>();
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index]!;
      const expectedPeriodKey = financialStatementPeriodKey(fact);
      check(
        fact.periodKey === expectedPeriodKey,
        "A2",
        `${series.key} ${periodType} fact has an invalid periodKey`,
        fact.periodEnd,
      );
      if (fact.periodStart !== undefined) {
        check(
          (financialStatementPeriodMonths(fact) ?? 0) >= 3,
          "A2",
          `${series.key} ${periodType} duration is shorter than 3 months`,
          fact.periodEnd,
        );
      }
      check(
        !periodKeys.has(fact.periodKey),
        "A3",
        `${series.key} ${periodType} contains duplicate periodKey ${fact.periodKey}`,
        fact.periodEnd,
      );
      periodKeys.add(fact.periodKey);
      const prior = facts[index - 1];
      check(
        prior === undefined ||
          prior.periodEnd < fact.periodEnd ||
          (prior.periodEnd === fact.periodEnd &&
            (prior.periodStart ?? "") < (fact.periodStart ?? "")),
        "A3",
        `${series.key} ${periodType} is not strictly increasing by period identity`,
        fact.periodEnd,
      );
    }
  }
}

function assertSeriesUnits(
  artifact: FinancialStatementsArtifact,
  series: FinancialStatementSeries,
  check: FinancialInvariantCheck,
): void {
  const facts = financialStatementFacts(series);
  if (facts.length === 0) {
    return;
  }
  check(
    financialStatementFactsAreCompatible(facts),
    "A4",
    `${series.key} mixes currencies or units`,
  );
  for (const fact of facts) {
    if (fact.currency === null || fact.currency === artifact.reportingCurrency) {
      continue;
    }
    check(
      artifact.omissionNotes.some(
        (note) => note.code === "mixed-currencies" && note.seriesKey === series.key,
      ),
      "A4",
      `${series.key} currency ${fact.currency} does not match reporting currency`,
      fact.periodEnd,
    );
  }
}

function balanceSheetIdentityFailure(
  assetFact: FinancialStatementFact,
  liabilityFact: FinancialStatementFact,
  equityFact: FinancialStatementFact,
  componentFacts: readonly FinancialStatementFact[] = [],
): string | undefined {
  const tolerance = identityTolerance([assetFact, liabilityFact, equityFact, ...componentFacts]);
  const residual =
    assetFact.value -
    liabilityFact.value -
    equityFact.value -
    componentFacts.reduce((sum, fact) => sum + fact.value, 0);
  return Math.abs(residual) <= tolerance
    ? undefined
    : `${assetFact.periodEnd} residual=${String(residual)} tolerance=${String(tolerance)}`;
}

export interface BalanceSheetIdentityCoverage {
  readonly asserted: number;
  readonly skipped: number;
  readonly failing: number;
  readonly completePeriods: number;
}

interface BalanceSheetIdentityEvaluation extends BalanceSheetIdentityCoverage {
  readonly failures: readonly string[];
  readonly periods: readonly { readonly periodEnd: string; readonly passed: boolean }[];
}

function componentFactForPeriodEnd(
  facts: readonly FinancialStatementFact[] | undefined,
  periodEnd: string,
): FinancialStatementFact | undefined {
  return latestFinancialStatementFact((facts ?? []).filter((fact) => fact.periodEnd === periodEnd));
}

export function assertBalanceSheetFactIdentity(
  assetFact: FinancialStatementFact,
  liabilityFact: FinancialStatementFact,
  equityFact: FinancialStatementFact,
  componentFacts: readonly FinancialStatementFact[] = [],
): void {
  const failure = balanceSheetIdentityFailure(assetFact, liabilityFact, equityFact, componentFacts);
  invariant(failure === undefined, "A6", `balance-sheet identity fails: ${failure ?? ""}`);
}

function evaluateBalanceSheetIdentity(
  artifact: FinancialStatementsArtifact,
): BalanceSheetIdentityEvaluation {
  const assets = financialStatementSeriesByKey(artifact, "totalAssets");
  const liabilities = financialStatementSeriesByKey(artifact, "totalLiabilities");
  const equity = financialStatementSeriesByKey(artifact, "stockholdersEquity");
  const assetFacts =
    artifact.equityStack?.totalAssets ??
    (assets === undefined ? [] : financialStatementFacts(assets));
  const liabilityFacts =
    artifact.equityStack?.totalLiabilities ??
    (liabilities === undefined ? [] : financialStatementFacts(liabilities));
  const equityFacts =
    artifact.equityStack?.stockholdersEquity ??
    (equity === undefined ? [] : financialStatementFacts(equity));
  const periodEnds = new Set([
    ...assetFacts.map((fact) => fact.periodEnd),
    ...liabilityFacts.map((fact) => fact.periodEnd),
    ...equityFacts.map((fact) => fact.periodEnd),
  ]);
  const failures: string[] = [];
  const periods: { periodEnd: string; passed: boolean }[] = [];
  let asserted = 0;
  for (const periodEnd of periodEnds) {
    const assetFact = componentFactForPeriodEnd(assetFacts, periodEnd);
    const liabilityFact = componentFactForPeriodEnd(liabilityFacts, periodEnd);
    const equityFact = componentFactForPeriodEnd(equityFacts, periodEnd);
    if (assetFact === undefined || liabilityFact === undefined || equityFact === undefined) {
      continue;
    }
    const temporaryEquity = componentFactForPeriodEnd(
      artifact.equityStack?.temporaryEquity,
      periodEnd,
    );
    const equityIncludingNoncontrolling = componentFactForPeriodEnd(
      artifact.equityStack?.stockholdersEquityIncludingNoncontrollingInterest,
      periodEnd,
    );
    const minorityInterest = componentFactForPeriodEnd(
      artifact.equityStack?.minorityInterest,
      periodEnd,
    );
    const identityEquity = equityIncludingNoncontrolling ?? equityFact;
    const componentFacts = [
      ...(temporaryEquity === undefined ? [] : [temporaryEquity]),
      ...(equityIncludingNoncontrolling === undefined &&
      equityFact.concept !==
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest" &&
      minorityInterest !== undefined
        ? [minorityInterest]
        : []),
    ];
    const failure = balanceSheetIdentityFailure(
      assetFact,
      liabilityFact,
      identityEquity,
      componentFacts,
    );
    asserted += 1;
    periods.push({ periodEnd, passed: failure === undefined });
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return {
    asserted,
    skipped: 0,
    failing: failures.length,
    completePeriods: asserted,
    failures,
    periods,
  };
}

export function balanceSheetIdentityCoverage(
  artifact: FinancialStatementsArtifact,
): BalanceSheetIdentityCoverage {
  const { asserted, skipped, failing, completePeriods } = evaluateBalanceSheetIdentity(artifact);
  return { asserted, skipped, failing, completePeriods };
}

function assertBalanceSheetIdentity(
  artifact: FinancialStatementsArtifact,
  check: FinancialInvariantCheck,
): void {
  const { failures, periods } = evaluateBalanceSheetIdentity(artifact);
  for (const period of periods) {
    check(
      period.passed,
      "A6",
      `balance-sheet identity fails for ${String(failures.length)} period(s): ${failures.join("; ")}`,
      period.periodEnd,
    );
  }
}

export function assertCompositeFactIntegrity(
  artifact: FinancialStatementsArtifact,
  check: FinancialInvariantCheck = invariant,
): void {
  for (const series of financialStatementSeries(artifact)) {
    const facts = financialStatementFacts(series);
    const methods = new Set(facts.map((fact) => fact.extractionMethod));
    check(
      series.key === "depreciationAndAmortization" ||
        series.key === "netIncome" ||
        series.key === "debt" ||
        series.key === "operatingCashFlow" ||
        series.key === "pretaxIncome" ||
        methods.size <= 1,
      "A8",
      `${series.key} mixes composite and direct bases`,
    );
    for (const fact of facts) {
      if (fact.composite === undefined) {
        check(
          fact.extractionMethod === "sec-companyfacts",
          "A8",
          `${series.key} ${fact.periodKey} is derived without composite contributors`,
          fact.periodEnd,
        );
        continue;
      }
      check(
        fact.extractionMethod === "derived-sec-companyfacts" ||
          (fact.extractionMethod === ZERO_BORROWINGS_EXTRACTION_METHOD &&
            series.key === "debt" &&
            fact.value === 0 &&
            fact.zeroBorrowingsProof !== undefined),
        "A8",
        `${series.key} ${fact.periodKey} carries composite contributors on a direct fact`,
        fact.periodEnd,
      );
      if (series.key === "netIncome") {
        check(
          fact.composite.components.length === 1 &&
            fact.composite.components[0]?.concept === "ProfitLoss",
          "A8",
          `${series.key} ${fact.periodKey} derives net income from anything but a ProfitLoss fallback`,
          fact.periodEnd,
        );
      }
      if (series.key === "operatingCashFlow") {
        check(
          fact.composite.components.map(({ concept }) => concept).join(",") ===
            "NetCashProvidedByUsedInOperatingActivities,CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations",
          "A8",
          `${series.key} ${fact.periodKey} derives OCF from anything but total minus discontinued`,
          fact.periodEnd,
        );
      }
      if (series.key === "pretaxIncome") {
        check(
          fact.composite.components.map(({ concept }) => concept).join(",") ===
            "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic,IncomeLossFromContinuingOperationsBeforeIncomeTaxesForeign",
          "A8",
          `${series.key} ${fact.periodKey} derives pretax income from anything but domestic + foreign`,
          fact.periodEnd,
        );
      }
      if (series.key === "depreciationAndAmortization") {
        check(
          fact.composite.components.length === DEPRECIATION_AND_AMORTIZATION_COMPONENTS.length &&
            DEPRECIATION_AND_AMORTIZATION_COMPONENTS.every((aliases) =>
              fact.composite!.components.some(
                ({ concept }) =>
                  aliases.includes(concept) ||
                  (aliases.includes("AmortizationOfIntangibleAssets") &&
                    concept === "AdjustmentForAmortization") ||
                  (aliases.includes("Depreciation") &&
                    concept === "OtherDepreciationAndAmortization"),
              ),
            ),
          "A8",
          `${series.key} ${fact.periodKey} requires complete depreciation and intangible amortization components`,
          fact.periodEnd,
        );
      }
      const componentScale = fact.composite.components.map((component) => ({
        value: component.value,
        unitScale: fact.unitScale,
      }));
      const tolerance = identityTolerance([
        { value: fact.value, unitScale: fact.unitScale },
        ...componentScale,
      ]);
      const sum = fact.composite.components.reduce(
        (total, component) => total + component.value,
        0,
      );
      check(
        Math.abs(fact.value - sum) <= tolerance,
        "A8",
        `${series.key} ${fact.periodKey} composite value ${String(fact.value)} disagrees with component sum ${String(sum)}`,
        fact.periodEnd,
      );
      check(
        fact.composite.components.every((component) => component.periodEnd === fact.periodEnd),
        "A8",
        `${series.key} ${fact.periodKey} composite mixes component period ends`,
        fact.periodEnd,
      );
      check(
        fact.composite.components.every((component) =>
          component.sourceIds.every((sourceId) => fact.sourceIds.includes(sourceId)),
        ),
        "A8",
        `${series.key} ${fact.periodKey} sourceIds omit a composite contributor`,
        fact.periodEnd,
      );
    }
  }
}

// A9: EV bridge facts are reporting-currency instants; a filer's combined line below cash is the resolver's job.
function assertEnterpriseValueBridge(
  artifact: FinancialStatementsArtifact,
  check: FinancialInvariantCheck,
): void {
  for (const fact of Object.values(artifact.enterpriseValueBridge ?? {}).flat()) {
    check(
      fact.periodKey.startsWith("instant|") && fact.currency === artifact.reportingCurrency,
      "A9",
      `EV bridge ${fact.concept} is not a reporting-currency instant`,
      fact.periodEnd,
    );
  }
}

export function assertFinancialStatementInvariants(
  artifact: FinancialStatementsArtifact,
  check: FinancialInvariantCheck = invariant,
): void {
  const series = financialStatementSeries(artifact);
  assertCapShapeIndependence(series, check);
  for (const item of series) {
    assertPeriodStructure(item, check);
    assertSeriesUnits(artifact, item, check);
  }
  check(
    detectFinancialStatementCadence(series) === artifact.interimCadence,
    "A5",
    "interim cadence disagrees with observed statement facts",
  );
  assertBalanceSheetIdentity(artifact, check);
  assertCompositeFactIntegrity(artifact, check);
  assertEnterpriseValueBridge(artifact, check);
  const { revenue } = artifact.statements.incomeStatement;
  const splice = artifact.omissionNotes.find(
    (note) => note.code === "revenue-concept-splice",
  )?.revenueSplice;
  const revenueFacts = [
    ...financialStatementFacts(revenue),
    ...Object.values(revenue.ttm?.components ?? {}),
  ];
  const selectedConcept = splice?.selectedConcept ?? revenueFacts[0]?.concept;
  for (const fact of revenueFacts.filter((item) => item.concept !== selectedConcept)) {
    check(
      splice !== undefined &&
        splice.proofAccession !== "" &&
        splice.proofStart !== "" &&
        splice.proofStart < splice.proofEnd &&
        splice.proofEnd <= splice.selectedEnd &&
        fact.concept === splice.aliasConcept &&
        fact.periodEnd > splice.selectedEnd &&
        splice.periodEnds.includes(fact.periodEnd),
      "A10",
      `revenue ${fact.concept} ${fact.periodEnd} is not covered by a revenue-concept-splice proof`,
      fact.periodEnd,
    );
  }
  const surfaced = new Set(artifact.validationNotes.map(noteKey));
  for (const note of incompleteFinancialStatementNotes(series)) {
    check(
      surfaced.has(noteKey(note)),
      "A7",
      `computed incomplete-statement note was not surfaced: ${note.message}`,
      series
        .flatMap((item) => financialStatementFacts(item))
        .find((fact) => fact.periodKey === note.periodKey)?.periodEnd,
    );
  }
}

export function collectFinancialStatementInvariants(
  artifact: FinancialStatementsArtifact,
): readonly FinancialInvariantResult[] {
  const checks = new Map<string, { passed: boolean; periodEnd: string | undefined }[]>();
  assertFinancialStatementInvariants(artifact, (passed, code, _message, periodEnd) => {
    const results = checks.get(code) ?? [];
    results.push({ passed, periodEnd });
    checks.set(code, results);
  });
  return ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"].map((code) => {
    const results = checks.get(code) ?? [];
    const failures = results.filter((result) => !result.passed);
    const periods = new Set(
      results.flatMap((result) => (result.periodEnd === undefined ? [] : [result.periodEnd])),
    );
    const failingPeriods = [
      ...new Set(
        failures.flatMap((result) => (result.periodEnd === undefined ? [] : [result.periodEnd])),
      ),
    ].toSorted();
    return {
      code,
      assertedCount: results.length,
      failingCount: failures.length,
      assertedPeriodCount: periods.size === 0 ? null : periods.size,
      failingPeriodCount:
        periods.size === 0 || failures.some((result) => result.periodEnd === undefined)
          ? null
          : failingPeriods.length,
      latestFailingPeriodEnd: failingPeriods.at(-1) ?? null,
    };
  });
}

export function financialStatementDurationProjection(
  artifact: FinancialStatementsArtifact,
): readonly DurationFactProjection[] {
  return durationProjection(financialStatementSeries(artifact));
}
