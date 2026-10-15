import { expect } from "bun:test";
import type { SourceGap } from "../../src/domain/sources";
import type { MetricSection, MetricInput } from "../../src/sources/extended-evidence/metric-engine";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import {
  financialStatementSeriesByKey,
  isYearAligned,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import { depositoryIssuerSic } from "../../src/sources/extended-evidence/industry-classification";
import type { YahooFxClose } from "../../src/sources/yahoo-fx";
import type { BuildValuationWorkbenchInput } from "../../src/sources/extended-evidence/valuation-workbench";
import type {
  ValuationWorkbenchArtifact,
  ValuationMetricKey,
} from "../../src/sources/extended-evidence/valuation-workbench-contract";
import { buildValuationWorkbench as legacyWorkbench } from "./valuation-workbench-legacy/valuation-workbench";
import {
  valuationPeriodInputs,
  periodPublicAt,
  type ValuationPeriodInputs,
} from "./valuation-workbench-legacy/valuation-workbench-inputs";

export const WORKBENCH_WAIVERS = [
  { id: "W1", rule: "R1", description: "annual input outside 350–380 days" },
  { id: "W2", rule: "R5", description: "known cross-source currency mismatch" },
  {
    id: "W3",
    rule: "R5",
    description: "metric-local citation lineage replaces observation-wide citations",
  },
] as const;
export type WorkbenchWaiver = (typeof WORKBENCH_WAIVERS)[number]["id"];

const keys = [
  "priceToEarnings",
  "priceToSales",
  "enterpriseValueToRevenue",
  "priceToFreeCashFlow",
] as const;
function fields(key: ValuationMetricKey): readonly (keyof ValuationPeriodInputs)[] {
  if (key === "priceToEarnings") {
    return ["dilutedEps"];
  }
  return [
    key === "priceToFreeCashFlow" ? "freeCashFlow" : "revenue",
    "dilutedShares",
    ...(key === "enterpriseValueToRevenue" ? (["cash", "debt"] as const) : []),
  ];
}
function fundamentals(period: ValuationPeriodInputs, key: ValuationMetricKey) {
  return fields(key).flatMap((field) => {
    const value = period[field];
    return typeof value === "object" ? [value] : [];
  });
}
function rawFacts(
  input: BuildValuationWorkbenchInput,
  row: MetricInput,
): readonly FinancialStatementFact[] {
  if (input.financialStatements === undefined || row.series === undefined) {
    return [];
  }
  const series = financialStatementSeriesByKey(
    input.financialStatements,
    row.series as FinancialStatementSeriesKey,
  );
  return [
    ...(series?.annual ?? []),
    ...(series?.interim ?? []),
    ...Object.values(series?.ttm?.components ?? {}),
  ];
}
function selectedFacts(
  input: BuildValuationWorkbenchInput,
  period: ValuationPeriodInputs,
  key: ValuationMetricKey,
) {
  if (input.financialStatements === undefined) {
    return [];
  }
  const seriesKeys: readonly FinancialStatementSeriesKey[] =
    key === "priceToEarnings"
      ? ["dilutedEps"]
      : [
          key === "priceToFreeCashFlow" ? "operatingCashFlow" : "revenue",
          ...(key === "priceToFreeCashFlow" ? (["capitalExpenditure"] as const) : []),
          ...(period.dilutedShares?.derivation === undefined
            ? (["dilutedShares"] as const)
            : (["netIncome", "dilutedEps"] as const)),
          ...(key === "enterpriseValueToRevenue" ? (["cash", "debt"] as const) : []),
        ];
  const revenueFacts = input.financialStatements.statements.incomeStatement.revenue.annual.filter(
    (fact) =>
      fact.periodEnd === period.periodEnd &&
      fact.value === period.revenue?.value &&
      fact.firstPublicAt === period.revenue?.publicAt,
  );
  return seriesKeys.flatMap((seriesKey) => {
    const series = financialStatementSeriesByKey(input.financialStatements!, seriesKey);
    const selected = period[seriesKey as keyof ValuationPeriodInputs];
    return (series?.annual ?? []).filter(
      (fact) =>
        fact.periodEnd === period.periodEnd &&
        fact.firstPublicAt <= periodPublicAt(period) &&
        (fact.periodKey.startsWith("instant|") ||
          revenueFacts.some(
            (anchor) =>
              anchor.periodKey === fact.periodKey && anchor.periodType === fact.periodType,
          )) &&
        (typeof selected !== "object" ||
          (fact.value === selected.value &&
            fact.firstPublicAt === selected.publicAt &&
            fact.unit === selected.unit &&
            fact.currency === selected.currency)),
    );
  });
}
export function workbenchWaiverPrecondition(
  id: WorkbenchWaiver,
  input: BuildValuationWorkbenchInput,
  period: ValuationPeriodInputs,
  key: ValuationMetricKey,
): boolean {
  if (id === "W1") {
    return (
      period.basis === "annual" &&
      selectedFacts(input, period, key).some(
        (fact) =>
          !fact.periodKey.startsWith("instant|") &&
          (fact.periodStart === undefined || !isYearAligned(fact.periodStart, fact.periodEnd)),
      )
    );
  }
  if (id === "W2") {
    return fundamentals(period, key).some(
      (value) =>
        typeof value.currency === "string" &&
        input.financialStatements?.reportingCurrency !== undefined &&
        value.currency !== input.financialStatements.reportingCurrency,
    );
  }
  return (
    Object.values(period).some(
      (value) => typeof value === "object" && value.sourceIds.length > 0,
    ) || depositoryIssuerSic(input.extendedEvidence) !== undefined
  );
}
function inputIds(
  input: BuildValuationWorkbenchInput,
  period: ValuationPeriodInputs,
  key: ValuationMetricKey,
  price: { sourceId: string } | null,
  fx: YahooFxClose | undefined,
): readonly string[] {
  if (
    (key === "enterpriseValueToRevenue" || key === "priceToFreeCashFlow") &&
    depositoryIssuerSic(input.extendedEvidence) !== undefined
  ) {
    return [];
  }
  const partialFcfIds =
    key === "priceToFreeCashFlow" && period.freeCashFlow === undefined
      ? selectedFacts(input, period, key)
          .filter((fact) =>
            ["operatingCashFlow", "capitalExpenditure"].some((seriesKey) => {
              const series = financialStatementSeriesByKey(
                input.financialStatements!,
                seriesKey as FinancialStatementSeriesKey,
              );
              return series?.annual.includes(fact);
            }),
          )
          .flatMap((fact) => fact.sourceIds)
      : [];
  return [
    ...new Set([
      ...fundamentals(period, key).flatMap((value) => value.sourceIds),
      ...partialFcfIds,
      ...(price === null ? [] : [price.sourceId]),
      ...(fx === undefined ? [] : [fx.sourceId]),
    ]),
  ].toSorted();
}

export function assertWorkbenchProperties(
  input: BuildValuationWorkbenchInput,
  artifact: ValuationWorkbenchArtifact,
  sections: readonly MetricSection[],
  gaps: readonly SourceGap[],
  fx: Readonly<Record<string, YahooFxClose>> = {},
): void {
  const periods =
    input.financialStatements === undefined
      ? []
      : valuationPeriodInputs(input.financialStatements).periods;
  expect(artifact.historicalMultiples.observations.length).toBe(periods.length);
  const expectedSections =
    periods.length === 0
      ? ["valuation-workbench-unavailable"]
      : periods.map(
          (period) =>
            `valuation-workbench-${period.basis}-${period.periodEnd}-${periodPublicAt(period)}`,
        );
  expect(
    sections.filter(({ id }) => id.startsWith("valuation-workbench-")).map(({ id }) => id),
  ).toEqual(expectedSections);
  if (periods.length === 0) {
    expect(sections.find(({ id }) => id === expectedSections[0])?.metrics[0]?.status).toBe(
      "missing",
    );
    expect(gaps.some(({ source }) => source === expectedSections[0])).toBe(true);
  }
  for (const [index, period] of periods.entries()) {
    const observation = artifact.historicalMultiples.observations[index]!;
    expect([observation.basis, observation.periodEnd, observation.publicAt]).toEqual([
      period.basis,
      period.periodEnd,
      periodPublicAt(period),
    ]);
    const price =
      input.priceSourceId === undefined || input.quoteCurrency === undefined
        ? undefined
        : input.priceHistory
            .filter(
              (bar) =>
                Number.isFinite(bar.close) &&
                bar.close > 0 &&
                Date.parse(bar.date) >= Date.parse(periodPublicAt(period)) &&
                Date.parse(bar.date) <= Date.parse(periodPublicAt(period)) + 7 * 86_400_000,
            )
            .toSorted((left, right) => left.date.localeCompare(right.date))[0];
    expect(observation.price).toEqual(
      price === undefined
        ? null
        : {
            close: price.close,
            sessionDate: price.date,
            currency: input.quoteCurrency!,
            sourceId: input.priceSourceId!,
          },
    );
    const section = sections.find(({ id }) => id === expectedSections[index]);
    expect(section?.metrics).toEqual(keys.map((key) => observation.metrics[key]));
    const unresolved = section!.metrics.filter(({ status }) => status !== "value");
    const gap = gaps.find(({ source }) => source === section!.id);
    expect(gap !== undefined).toBe(unresolved.length > 0);
    if (gap !== undefined) {
      expect(gap.triage).toBe(
        unresolved.some(({ status, cause }) => status === "missing" && cause !== "not-filed")
          ? "material"
          : "diagnostic",
      );
      for (const metric of unresolved) {
        expect(gap.message).toContain(metric.label);
      }
    }
    for (const key of keys) {
      const metric = observation.metrics[key];
      const rate = observation.price === null ? undefined : fx[observation.price.sessionDate];
      const effectiveFx =
        rate !== undefined &&
        rate.date <= (observation.price?.sessionDate ?? "") &&
        input.quoteCurrency !== input.financialStatements?.reportingCurrency
          ? rate
          : undefined;
      expect([...metric.sourceIds].toSorted(), `${key} sources from inputs`).toEqual([
        ...inputIds(input, period, key, observation.price, effectiveFx),
      ]);
      expect([...new Set(metric.inputs.flatMap(({ sourceIds }) => sourceIds))].toSorted()).toEqual(
        [...metric.sourceIds].toSorted(),
      );
      for (const row of metric.inputs) {
        if (row.artifact === "statements") {
          expect(
            rawFacts(input, row).some(
              (fact) =>
                fact.periodKey === row.periodKey &&
                fact.periodType === row.periodType &&
                fact.value === row.value &&
                fact.periodEnd === row.periodEnd &&
                fact.periodStart === row.periodStart &&
                fact.unit === row.unit &&
                (fact.currency ?? undefined) === row.currency &&
                JSON.stringify(fact.sourceIds) === JSON.stringify(row.sourceIds),
            ),
          ).toBe(true);
        } else if (row.artifact === "priceHistory") {
          expect(
            input.priceHistory.some((bar) => bar.date === row.periodEnd && bar.close === row.value),
          ).toBe(true);
          expect(row.sourceIds).toEqual([input.priceSourceId!]);
        } else {
          expect(row.artifact).toBe("fx");
          expect([row.value, row.periodEnd, row.sourceIds[0]]).toEqual([
            effectiveFx?.quoteCurrencyPerBaseCurrency,
            effectiveFx?.date,
            effectiveFx?.sourceId,
          ]);
        }
      }
      if (metric.status !== "value") {
        continue;
      }
      expect(metric.periodEnd).toBe(period.periodEnd);
      expect(metric.basis).toContain(
        "first verified close within 7 calendar days on or after publicAt",
      );
      expect(metric.basis).toContain(observation.price!.sessionDate);
      const close = observation.price!.close * (effectiveFx?.quoteCurrencyPerBaseCurrency ?? 1);
      const cap = close * (period.dilutedShares?.value ?? 1);
      const numerator =
        key === "priceToEarnings"
          ? close
          : key === "enterpriseValueToRevenue"
            ? cap + period.debt!.value - period.cash!.value
            : cap;
      const denominator =
        key === "priceToEarnings"
          ? period.dilutedEps!.value
          : key === "priceToFreeCashFlow"
            ? period.freeCashFlow!.value
            : period.revenue!.value;
      expect(denominator).toBeGreaterThan(0);
      expect(metric.value).toBeCloseTo(numerator / denominator, 10);
    }
  }
}

export function assertWorkbenchParity(
  input: BuildValuationWorkbenchInput,
  artifact: ValuationWorkbenchArtifact,
  sections: readonly MetricSection[],
  gaps: readonly SourceGap[],
  fx: Readonly<Record<string, YahooFxClose>> = {},
): Readonly<Record<WorkbenchWaiver, number>> {
  const legacy = legacyWorkbench(input, fx);
  assertWorkbenchProperties(input, artifact, sections, gaps, fx);
  expect([...artifact.sourceIds].toSorted()).toEqual([...legacy.sourceIds].toSorted());
  expect(artifact.peerComparison).toEqual(legacy.peerComparison);
  expect(artifact.historicalMultiples.trailingBasis).toEqual(
    legacy.historicalMultiples.trailingBasis,
  );
  expect(artifact.historicalMultiples.suppressionReasons).toEqual(
    legacy.historicalMultiples.suppressionReasons,
  );
  const periods =
    input.financialStatements === undefined
      ? []
      : valuationPeriodInputs(input.financialStatements).periods;
  const counts = { W1: 0, W2: 0, W3: 0 };
  for (const [index, old] of legacy.historicalMultiples.observations.entries()) {
    const rebuilt = artifact.historicalMultiples.observations[index]!;
    expect([rebuilt.price, rebuilt.fxConversion]).toEqual([old.price, old.fxConversion]);
    expect([...rebuilt.sourceIds].toSorted()).toEqual([...old.sourceIds].toSorted());
    expect(
      Object.fromEntries(
        Object.entries(rebuilt.inputs).map(([key, { lineage: _lineage, ...fundamental }]) => [
          key,
          fundamental,
        ]),
      ),
    ).toEqual(old.inputs);
    for (const key of keys) {
      const before = old.metrics[key];
      const after = rebuilt.metrics[key];
      const status =
        before.status === "populated"
          ? "value"
          : before.status === "suppressed"
            ? "missing"
            : before.status;
      const reason =
        before.status === "not-applicable"
          ? `${before.rationale} (SIC ${depositoryIssuerSic(input.extendedEvidence)})`
          : before.status === "populated"
            ? undefined
            : before.reason;
      if (
        status !== after.status ||
        (before.status === "populated" && before.value !== after.value) ||
        reason !== after.reason
      ) {
        const waiver = WORKBENCH_WAIVERS.filter(({ id }) => id !== "W3").find(
          ({ id }) =>
            workbenchWaiverPrecondition(id, input, periods[index]!, key) &&
            after.status === "missing" &&
            after.reason ===
              (id === "W1" ? "annual input outside 350–380 days" : "incompatible currency"),
        );
        expect(
          waiver,
          `unwaived ${input.symbol} ${index} ${key}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
        ).toBeDefined();
        counts[waiver!.id]++;
      }
      if (
        JSON.stringify([...before.sourceIds].toSorted()) !==
        JSON.stringify([...after.sourceIds].toSorted())
      ) {
        expect(workbenchWaiverPrecondition("W3", input, periods[index]!, key)).toBe(true);
        counts.W3++;
      }
    }
  }
  return counts;
}
