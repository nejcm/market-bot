import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EquityAnalysisCompletenessDimension } from "../../../src/domain/types";
import {
  EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS,
  resolveCoverageLevel,
} from "../../../src/domain/equity-analysis-completeness";
import { classifyGap } from "../../../src/report/gap-triage";
import type { FinancialLensArtifact } from "../../../src/sources/extended-evidence/financial-lens";
import type {
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "../../../src/sources/extended-evidence/financial-statements-contract";
import {
  capFinancialStatementPeriods,
  detectFinancialStatementCadence,
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementSeries,
  financialStatementSeriesByKey,
  incompleteFinancialStatementNotes,
  latestFinancialStatementFact,
} from "../../../src/sources/extended-evidence/financial-statement-selection";
import {
  DAYS_PER_YEAR,
  MIN_CAGR_ANNUAL_POINTS,
  type FundamentalHistoryArtifact,
  type FundamentalHistorySeries,
} from "../../../src/sources/extended-evidence/fundamental-history";
import { identityTolerance } from "../../../src/sources/extended-evidence/untagged-financial-table-validation";
import {
  MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
  MIXED_PERIOD_METRIC,
} from "../../../src/sources/extended-evidence/valuation-comps";
import type { FixtureMeta, RunFixtureResult } from ".";

const DAY_MS = 86_400_000;
const DURATION_MONTHS = new Set([3, 6, 9, 12]);
const PER_SHARE_CURRENCY = /^([A-Z]{3})\/shares$/u;
const ISO_CURRENCY = /^[A-Z]{3}$/u;

const FINANCIAL_LENS_INPUTS: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
  netMargin: ["netIncome", "revenue"],
  freeCashFlowProxy: ["operatingCashFlow", "capitalExpenditure"],
  cashConversion: ["operatingCashFlow", "netIncome"],
  roe: ["netIncome", "stockholdersEquity"],
  roa: ["netIncome", "totalAssets"],
  payoutRatio: ["dividendsPaid", "netIncome"],
  revenueDeltaPercent: ["revenue"],
  grossProfitDeltaPercent: ["grossProfit"],
  operatingIncomeDeltaPercent: ["operatingIncome"],
  netIncomeDeltaPercent: ["netIncome"],
  dilutedEpsDeltaPercent: ["dilutedEps"],
  operatingCashFlowDeltaPercent: ["operatingCashFlow"],
  annualizedRevenue: ["revenue"],
  evToAnnualizedRevenue: ["revenue"],
  marketCapToAnnualizedRevenue: ["revenue"],
  valuationSupportability: ["revenue"],
  valuationCaveat: ["revenue"],
  pcfRatio: ["operatingCashFlow"],
};

const FLOW_OVER_INSTANT_INPUTS: Readonly<
  Record<string, readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey]>
> = {
  roe: ["netIncome", "stockholdersEquity"],
  roa: ["netIncome", "totalAssets"],
};

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

function invariant(condition: boolean, code: string, message: string): asserts condition {
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
): void {
  invariant(
    JSON.stringify(retained) === JSON.stringify(independentlyCapped),
    "A1",
    "instant facts changed the duration facts retained by the period cap",
  );
}

function assertCapShapeIndependence(series: readonly FinancialStatementSeries[]): void {
  const durationOnly = series.map((item) => ({
    ...item,
    annual: item.annual.filter((fact) => fact.periodStart !== undefined),
    interim: item.interim.filter((fact) => fact.periodStart !== undefined),
  }));
  const independentlyCapped = capFinancialStatementPeriods(durationOnly).series;
  assertRetainedDurationFactsIdentical(
    durationProjection(series),
    durationProjection(independentlyCapped),
  );
}

function assertPeriodStructure(series: FinancialStatementSeries): void {
  for (const periodType of ["annual", "interim"] as const) {
    const facts = series[periodType];
    const periodKeys = new Set<string>();
    for (let index = 0; index < facts.length; index += 1) {
      const fact = facts[index]!;
      const expectedPeriodKey =
        fact.periodStart === undefined
          ? `instant|${fact.periodEnd}`
          : `${fact.periodStart}|${fact.periodEnd}`;
      invariant(
        fact.periodKey === expectedPeriodKey,
        "A2",
        `${series.key} ${periodType} fact has an invalid periodKey`,
      );
      if (fact.periodStart !== undefined) {
        invariant(
          DURATION_MONTHS.has(financialStatementPeriodMonths(fact) ?? -1),
          "A2",
          `${series.key} ${periodType} duration is not 3, 6, 9, or 12 months`,
        );
      }
      invariant(
        !periodKeys.has(fact.periodKey),
        "A3",
        `${series.key} ${periodType} contains duplicate periodKey ${fact.periodKey}`,
      );
      periodKeys.add(fact.periodKey);
      const prior = facts[index - 1];
      invariant(
        prior === undefined || prior.periodEnd < fact.periodEnd,
        "A3",
        `${series.key} ${periodType} is not strictly increasing by periodEnd`,
      );
    }
  }
}

function assertSeriesUnits(
  artifact: FinancialStatementsArtifact,
  series: FinancialStatementSeries,
): void {
  const facts = financialStatementFacts(series);
  if (facts.length === 0) {
    return;
  }
  invariant(
    financialStatementFactsAreCompatible(facts),
    "A4",
    `${series.key} mixes currencies or units`,
  );
  for (const fact of facts) {
    if (fact.currency === null || fact.currency === artifact.reportingCurrency) {
      continue;
    }
    invariant(
      artifact.omissionNotes.some(
        (note) => note.code === "mixed-currencies" && note.seriesKey === series.key,
      ),
      "A4",
      `${series.key} currency ${fact.currency} does not match reporting currency`,
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
  };
}

export function balanceSheetIdentityCoverage(
  artifact: FinancialStatementsArtifact,
): BalanceSheetIdentityCoverage {
  const { asserted, skipped, failing, completePeriods } = evaluateBalanceSheetIdentity(artifact);
  return { asserted, skipped, failing, completePeriods };
}

function assertBalanceSheetIdentity(artifact: FinancialStatementsArtifact): void {
  const { failures } = evaluateBalanceSheetIdentity(artifact);
  invariant(
    failures.length === 0,
    "A6",
    `balance-sheet identity fails for ${String(failures.length)} period(s): ${failures.join("; ")}`,
  );
}

export function assertFinancialStatementInvariants(artifact: FinancialStatementsArtifact): void {
  const series = financialStatementSeries(artifact);
  assertCapShapeIndependence(series);
  for (const item of series) {
    assertPeriodStructure(item);
    assertSeriesUnits(artifact, item);
  }
  invariant(
    detectFinancialStatementCadence(series) === artifact.interimCadence,
    "A5",
    "interim cadence disagrees with observed statement facts",
  );
  assertBalanceSheetIdentity(artifact);
  const surfaced = new Set(artifact.validationNotes.map(noteKey));
  for (const note of incompleteFinancialStatementNotes(series)) {
    invariant(
      surfaced.has(noteKey(note)),
      "A7",
      `computed incomplete-statement note was not surfaced: ${note.message}`,
    );
  }
}

function yearsBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS / DAYS_PER_YEAR;
}

function assertSummarySpan(
  series: FundamentalHistorySeries,
  summary: { readonly years: number; readonly periodStart: string; readonly periodEnd: string },
  kind: "cagr" | "marginChange",
): void {
  const first = series.annual.find((point) => point.periodEnd === summary.periodStart);
  const last = series.annual.find((point) => point.periodEnd === summary.periodEnd);
  invariant(
    first !== undefined && last !== undefined,
    "B9",
    `${series.key} ${kind} endpoints missing`,
  );
  invariant(
    Math.abs(summary.years - yearsBetween(first.periodEnd, last.periodEnd)) < 1e-12,
    "B9",
    `${series.key} ${kind} years disagree with its annual-point span`,
  );
}

export function assertFundamentalHistoryInvariants(
  history: FundamentalHistoryArtifact,
  requireRevenueDepth: boolean,
): void {
  for (const series of Object.values(history.series)) {
    if (series.cagr !== undefined) {
      assertSummarySpan(series, series.cagr, "cagr");
    }
    if (series.marginChange !== undefined) {
      assertSummarySpan(series, series.marginChange, "marginChange");
      const first = series.annual.at(0);
      const last = series.annual.at(-1);
      invariant(
        first !== undefined &&
          last !== undefined &&
          series.marginChange.periodStart === first.periodEnd &&
          series.marginChange.periodEnd === last.periodEnd,
        "B9",
        `${series.key} marginChange does not summarize the emitted annual array`,
      );
      invariant(
        Math.sign(series.marginChange.percentagePoints) === Math.sign(last.value - first.value),
        "B9",
        `${series.key} marginChange sign disagrees with its annual endpoints`,
      );
    }
  }
  if (requireRevenueDepth) {
    // This is the production CAGR viability floor; A1/B9 guard cap loss and summarized span.
    invariant(
      history.series.revenue.annual.length >= MIN_CAGR_ANNUAL_POINTS,
      "B10",
      `SEC-backed deep fixture retained fewer than ${String(MIN_CAGR_ANNUAL_POINTS)} annual revenue periods`,
    );
  }
}

function statementInputFact(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
  periodEnd: string,
  periodMonths: number,
  allowNearbyInstant: boolean,
): FinancialStatementFact | undefined {
  const series = financialStatementSeriesByKey(artifact, key);
  if (series === undefined) {
    return;
  }
  const facts = financialStatementFacts(series);
  const exactDuration = facts.filter(
    (fact) => fact.periodEnd === periodEnd && financialStatementPeriodMonths(fact) === periodMonths,
  );
  if (exactDuration.length > 0) {
    return latestFinancialStatementFact(exactDuration);
  }
  if (!allowNearbyInstant) {
    return;
  }
  return facts
    .filter(
      (fact) =>
        fact.periodStart === undefined &&
        Math.abs(Date.parse(fact.periodEnd) - Date.parse(periodEnd)) / DAY_MS <=
          MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
    )
    .toSorted(
      (left, right) =>
        Math.abs(Date.parse(left.periodEnd) - Date.parse(periodEnd)) -
        Math.abs(Date.parse(right.periodEnd) - Date.parse(periodEnd)),
    )[0];
}

export function assertFinancialLensPeriodHygiene(
  artifact: FinancialStatementsArtifact,
  lenses: FinancialLensArtifact,
): void {
  for (const metric of lenses.lenses.flatMap((lens) => lens.metrics)) {
    if (metric.periodEnd === undefined || metric.periodMonths === undefined) {
      continue;
    }
    if (metric.value === MIXED_PERIOD_METRIC) {
      continue;
    }
    const inputKeys = FINANCIAL_LENS_INPUTS[metric.key];
    invariant(inputKeys !== undefined, "B8", `${metric.key} has no statement-input contract`);
    const flowOverInstant = FLOW_OVER_INSTANT_INPUTS[metric.key];
    const facts = inputKeys.map((key) =>
      statementInputFact(
        artifact,
        key,
        metric.periodEnd!,
        metric.periodMonths!,
        flowOverInstant?.[1] === key,
      ),
    );
    invariant(
      facts.every((fact) => fact !== undefined),
      "B8",
      `${metric.key} has no compatible facts for ${metric.periodEnd}`,
    );
    const compatibleFacts = facts as readonly FinancialStatementFact[];
    invariant(
      financialStatementFactsAreCompatible(compatibleFacts),
      "B8",
      `${metric.key} mixes statement currencies or units`,
    );
    if (flowOverInstant !== undefined) {
      const [flow, instant] = compatibleFacts;
      invariant(
        flow !== undefined &&
          instant !== undefined &&
          Math.abs(Date.parse(flow.periodEnd) - Date.parse(instant.periodEnd)) / DAY_MS <=
            MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS,
        "B8",
        `${metric.key} flow and balance-sheet periods diverge by more than 92 days`,
      );
    }
  }
}

export function assertSourceIdClosure(
  value: unknown,
  knownSourceIds: ReadonlySet<string>,
  root = "artifact",
): void {
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      const itemPath = `${path}.${key}`;
      if (key === "sourceIds") {
        invariant(Array.isArray(item), "C12", `${itemPath} is not an array`);
        for (const sourceId of item) {
          invariant(
            typeof sourceId === "string" && knownSourceIds.has(sourceId),
            "C12",
            `${itemPath} cites unknown source ID ${String(sourceId)}`,
          );
        }
      } else {
        visit(item, itemPath);
      }
    }
  };
  visit(value, root);
}

function assertGapTriage(result: RunFixtureResult): void {
  const appendixIndex = result.markdown.indexOf("\n## Appendix\n");
  const reader = (
    appendixIndex === -1 ? result.markdown : result.markdown.slice(0, appendixIndex)
  ).replaceAll("\\", "");
  for (const gap of result.report.dataGaps) {
    const inReader = reader.includes(gap);
    if (classifyGap(gap, result.report.symbol) === "material") {
      invariant(inReader, "C13", `material gap missing from reader block: ${gap}`);
    } else {
      invariant(!inReader, "C13", `diagnostic gap leaked into reader block: ${gap}`);
    }
  }
}

function assertCompleteness(result: RunFixtureResult, knownSourceIds: ReadonlySet<string>): void {
  const completeness = result.report.equityAnalysisCompleteness;
  if (completeness === undefined) {
    return;
  }
  for (const key of EQUITY_ANALYSIS_COMPLETENESS_DIMENSION_KEYS) {
    for (const sourceId of completeness.dimensions[key].sourceIds) {
      invariant(
        knownSourceIds.has(sourceId),
        "C14",
        `${key} completeness cites unknown source ID ${sourceId}`,
      );
    }
  }
  const derivationDimensions: readonly EquityAnalysisCompletenessDimension[] = [
    completeness.dimensions.valuation,
    completeness.dimensions.expectations,
    completeness.dimensions.capitalOwnership,
    completeness.dimensions.operatingKpis,
  ];
  invariant(
    resolveCoverageLevel(derivationDimensions, completeness.financialCoreStatus) ===
      completeness.coverageLevel,
    "C14",
    "coverageLevel disagrees with its completeness dimensions",
  );
}

function assertNumericAndCurrencyHygiene(value: unknown, root: string): void {
  const visit = (candidate: unknown, path: string, key?: string): void => {
    if (typeof candidate === "number") {
      invariant(Number.isFinite(candidate), "D15", `${path} is not finite`);
      return;
    }
    if (key === "currency" && candidate !== null) {
      invariant(typeof candidate === "string", "D15", `${path} is not a currency string`);
      const perShare = PER_SHARE_CURRENCY.exec(candidate);
      invariant(
        ISO_CURRENCY.test(perShare?.[1] ?? candidate),
        "D15",
        `${path} is not a three-letter ISO currency code`,
      );
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    for (const [childKey, item] of Object.entries(candidate)) {
      visit(item, `${path}.${childKey}`, childKey);
    }
  };
  visit(value, root);
}

async function normalizedArtifacts(runDir: string): Promise<Readonly<Record<string, unknown>>> {
  const normalizedDir = join(runDir, "normalized");
  const normalizedFiles = await readdir(normalizedDir);
  const files = normalizedFiles.filter((file) => file.endsWith(".json"));
  const entries = await Promise.all(
    files.map(async (file) => [
      file,
      JSON.parse(await readFile(join(normalizedDir, file), "utf8")),
    ]),
  );
  return Object.fromEntries(entries);
}

export async function assertFinancialRunInvariants(
  result: RunFixtureResult,
  meta: FixtureMeta,
): Promise<void> {
  const statements = result.deepEquityEvidenceBundle?.derived.financialStatements;
  const history = result.deepEquityEvidenceBundle?.derived.fundamentalHistory;
  const lenses = result.deepEquityEvidenceBundle?.derived.financialLenses;
  if (statements !== undefined) {
    assertFinancialStatementInvariants(statements);
  }
  if (history !== undefined) {
    assertFundamentalHistoryInvariants(
      history,
      statements !== undefined && meta.argv.includes("--deep"),
    );
  }
  if (statements !== undefined && lenses !== undefined) {
    assertFinancialLensPeriodHygiene(statements, lenses);
  }

  assertGapTriage(result);
  const knownSourceIds = new Set(result.report.sources.map((source) => source.id));
  assertCompleteness(result, knownSourceIds);
  const normalized = await normalizedArtifacts(result.artifacts.runDir);
  if (result.deepEquityEvidenceBundle !== undefined) {
    assertSourceIdClosure(result.deepEquityEvidenceBundle, knownSourceIds, "evidence-bundle");
  }
  for (const [file, artifact] of Object.entries(normalized)) {
    assertSourceIdClosure(artifact, knownSourceIds, `normalized/${file}`);
  }
  assertNumericAndCurrencyHygiene(result.report, "report");
  assertNumericAndCurrencyHygiene(result.analytics, "analytics");
  assertNumericAndCurrencyHygiene(normalized, "normalized");
}

export function financialStatementDurationProjection(
  artifact: FinancialStatementsArtifact,
): readonly DurationFactProjection[] {
  return durationProjection(financialStatementSeries(artifact));
}
