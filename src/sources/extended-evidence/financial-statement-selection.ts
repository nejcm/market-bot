import type { FinancialStatementSeriesDefinition } from "./financial-statement-definitions";
import {
  SEC_COMPANYFACTS_UNIT_SCALE,
  type FinancialStatementFact,
  type FinancialStatementName,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementTtm,
  type FinancialStatementsArtifact,
  type InterimCadence,
} from "./financial-statements-contract";

const DAY_MS = 86_400_000;
const DAYS_PER_MONTH = 30.4368;
const ALIGNMENT_MIN_DAYS = 350;
const ALIGNMENT_MAX_DAYS = 380;
const FY_BOUNDARY_TOLERANCE_DAYS = 10;
const MAX_ANNUAL_PERIODS = 10;
const MAX_INTERIM_PERIODS = 12;

function daysBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? (endMs - startMs) / DAY_MS
    : undefined;
}

export function financialStatementPeriodMonths(
  fact: Pick<FinancialStatementFact, "periodStart" | "periodEnd">,
): number | undefined {
  if (fact.periodStart === undefined) {
    return undefined;
  }
  const days = daysBetween(fact.periodStart, fact.periodEnd);
  return days !== undefined && days > 0 ? Math.round(days / DAYS_PER_MONTH) : undefined;
}

function financialStatementDurationDays(fact: FinancialStatementSelectionFact): number {
  return fact.periodStart === undefined ? 0 : (daysBetween(fact.periodStart, fact.periodEnd) ?? 0);
}

export type FinancialStatementSelectionFact = Pick<
  FinancialStatementFact,
  "periodStart" | "periodEnd" | "filedAt" | "amendment" | "accessionNumber"
>;

export function financialStatementSeries(
  artifact: FinancialStatementsArtifact,
): readonly FinancialStatementSeries[] {
  return [
    ...Object.values(artifact.statements.incomeStatement),
    ...Object.values(artifact.statements.balanceSheet),
    ...Object.values(artifact.statements.cashFlowStatement),
    ...Object.values(artifact.statements.perShare),
  ];
}

export function financialStatementSeriesByKey(
  artifact: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
): FinancialStatementSeries | undefined {
  return financialStatementSeries(artifact).find((series) => series.key === key);
}

export function compareFinancialStatementFacts(
  left: FinancialStatementSelectionFact,
  right: FinancialStatementSelectionFact,
): number {
  return (
    right.periodEnd.localeCompare(left.periodEnd) ||
    financialStatementDurationDays(right) - financialStatementDurationDays(left) ||
    right.filedAt.localeCompare(left.filedAt) ||
    Number(right.amendment) - Number(left.amendment) ||
    (right.accessionNumber ?? "").localeCompare(left.accessionNumber ?? "")
  );
}

export function latestFinancialStatementFact(
  facts: readonly FinancialStatementFact[],
): FinancialStatementFact | undefined {
  return facts.toSorted(compareFinancialStatementFacts).at(0);
}

export function financialStatementFacts(
  series: FinancialStatementSeries,
): readonly FinancialStatementFact[] {
  return [...series.annual, ...series.interim];
}

export function financialStatementFactForPeriod(
  facts: readonly FinancialStatementFact[],
  periodKey: string,
): FinancialStatementFact | undefined {
  return latestFinancialStatementFact(facts.filter((fact) => fact.periodKey === periodKey));
}

export function financialStatementFactsAreCompatible(
  facts: readonly FinancialStatementFact[],
): boolean {
  const [first] = facts;
  return (
    first !== undefined &&
    facts.every(
      (fact) =>
        fact.currency === first.currency &&
        fact.unit === first.unit &&
        fact.unitScale === first.unitScale,
    )
  );
}

export function financialStatementTtmsSharePeriod(
  values: readonly FinancialStatementTtm[],
): boolean {
  const [first] = values;
  return (
    first !== undefined &&
    values.every(
      (value) => value.periodStart === first.periodStart && value.periodEnd === first.periodEnd,
    )
  );
}

export function financialStatementTtmsAreCompatible(
  values: readonly FinancialStatementTtm[],
): boolean {
  const [first] = values;
  return (
    first !== undefined &&
    financialStatementTtmsSharePeriod(values) &&
    values.every(
      (value) =>
        value.currency === first.currency &&
        value.unit === first.unit &&
        value.unitScale === first.unitScale,
    )
  );
}

export function latestCommonFinancialStatementFacts(
  series: readonly (FinancialStatementSeries | undefined)[],
): readonly FinancialStatementFact[] | undefined {
  if (series.length === 0 || series.some((item) => item === undefined)) {
    return undefined;
  }
  const available = series as readonly FinancialStatementSeries[];
  const periodKeys = [
    ...new Set(financialStatementFacts(available[0]!).map((fact) => fact.periodKey)),
  ];
  const common = periodKeys.flatMap((periodKey): readonly FinancialStatementFact[][] => {
    const facts = available.map((item) =>
      financialStatementFactForPeriod(financialStatementFacts(item), periodKey),
    );
    if (
      facts.some((fact) => fact === undefined) ||
      !financialStatementFactsAreCompatible(facts as readonly FinancialStatementFact[])
    ) {
      return [];
    }
    return [[...(facts as readonly FinancialStatementFact[])]];
  });
  return common.toSorted((left, right) => compareFinancialStatementFacts(left[0]!, right[0]!))[0];
}

function isYearAligned(prior: string, latest: string): boolean {
  const days = daysBetween(prior, latest);
  return days !== undefined && days >= ALIGNMENT_MIN_DAYS && days <= ALIGNMENT_MAX_DAYS;
}

export function financialStatementPeriodsYearAligned(
  prior: FinancialStatementFact,
  latest: FinancialStatementFact,
): boolean {
  if (prior.periodStart === undefined || latest.periodStart === undefined) {
    return false;
  }
  return (
    isYearAligned(prior.periodStart, latest.periodStart) &&
    isYearAligned(prior.periodEnd, latest.periodEnd)
  );
}

export function deriveFinancialStatementTtm(
  definition: FinancialStatementSeriesDefinition,
  annual: readonly FinancialStatementFact[],
  interim: readonly FinancialStatementFact[],
  currency: string,
): { readonly ttm?: FinancialStatementTtm; readonly note?: FinancialStatementNote } {
  if (!definition.deriveTtm || annual.length === 0) {
    return {};
  }
  const fiscalYear = latestFinancialStatementFact(annual)!;
  const latestYearToDate = latestFinancialStatementFact(
    interim.filter(
      (fact) => fact.periodStart !== undefined && fact.periodEnd > fiscalYear.periodEnd,
    ),
  );
  if (latestYearToDate === undefined || latestYearToDate.periodStart === undefined) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "No complete post-FY interim duration fact is available",
      },
    };
  }
  const latestMonths = financialStatementPeriodMonths(latestYearToDate);
  const priorYearToDate = latestFinancialStatementFact(
    interim.filter(
      (fact) =>
        fact.periodStart !== undefined &&
        fact.periodEnd < fiscalYear.periodEnd &&
        financialStatementPeriodMonths(fact) === latestMonths &&
        isYearAligned(fact.periodStart, latestYearToDate.periodStart!) &&
        isYearAligned(fact.periodEnd, latestYearToDate.periodEnd),
    ),
  );
  if (priorYearToDate === undefined || priorYearToDate.periodStart === undefined) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "No aligned prior-year interim duration fact is available",
      },
    };
  }
  const startAlignment = Math.abs(
    daysBetween(fiscalYear.periodStart ?? "", priorYearToDate.periodStart) ?? Infinity,
  );
  const boundaryAlignment = Math.abs(
    daysBetween(fiscalYear.periodEnd, latestYearToDate.periodStart) ?? Infinity,
  );
  if (
    fiscalYear.periodStart === undefined ||
    startAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    boundaryAlignment > FY_BOUNDARY_TOLERANCE_DAYS ||
    priorYearToDate.periodEnd >= fiscalYear.periodEnd
  ) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "FY/latest-YTD/prior-YTD periods do not reconcile at the fiscal-year boundary",
      },
    };
  }
  if (
    !financialStatementFactsAreCompatible([fiscalYear, latestYearToDate, priorYearToDate]) ||
    fiscalYear.currency !== currency
  ) {
    return {
      note: {
        code: "unreconciled-ttm",
        seriesKey: definition.key,
        message: "FY/latest-YTD/prior-YTD facts do not use compatible units and currency",
      },
    };
  }
  const sourceIds = [
    ...new Set([
      ...fiscalYear.sourceIds,
      ...latestYearToDate.sourceIds,
      ...priorYearToDate.sourceIds,
    ]),
  ];
  return {
    ttm: {
      value: fiscalYear.value + latestYearToDate.value - priorYearToDate.value,
      periodStart: new Date(Date.parse(priorYearToDate.periodEnd) + DAY_MS)
        .toISOString()
        .slice(0, 10),
      periodEnd: latestYearToDate.periodEnd,
      currency,
      unit: fiscalYear.unit,
      unitScale: SEC_COMPANYFACTS_UNIT_SCALE,
      extractionMethod: "derived-sec-companyfacts",
      formula: "FY + latest-YTD - prior-YTD",
      sourceIds,
      components: { fiscalYear, latestYearToDate, priorYearToDate },
    },
  };
}

export function detectFinancialStatementCadence(
  series: readonly FinancialStatementSeries[],
): InterimCadence {
  const annualCount = series.reduce((count, item) => count + item.annual.length, 0);
  const interim = series.flatMap((item) => item.interim);
  if (interim.length === 0) {
    return annualCount > 0 ? "annual-only" : "unknown";
  }
  if (interim.some((fact) => fact.canonicalForm === "10-Q")) {
    return "quarterly";
  }
  const fiscalPeriods = new Set(interim.map((fact) => fact.fiscalPeriod.toUpperCase()));
  if ([...fiscalPeriods].some((period) => /^Q[1-4]$/u.test(period))) {
    return "quarterly";
  }
  if ([...fiscalPeriods].some((period) => /^(?:H[12]|HY|S[12])$/u.test(period))) {
    return "semiannual";
  }
  const durationMonths = interim.flatMap((fact) => {
    const months = financialStatementPeriodMonths(fact);
    return months === undefined ? [] : [months];
  });
  if (durationMonths.length === 0) {
    return "irregular";
  }
  if (durationMonths.some((months) => months >= 2 && months <= 4)) {
    return "quarterly";
  }
  if (durationMonths.every((months) => months >= 5 && months <= 7)) {
    return "semiannual";
  }
  return "irregular";
}

export function incompleteFinancialStatementNotes(
  series: readonly FinancialStatementSeries[],
): readonly FinancialStatementNote[] {
  const required: Readonly<Record<FinancialStatementName, readonly FinancialStatementSeriesKey[]>> =
    {
      incomeStatement: ["revenue", "operatingIncome", "netIncome"],
      balanceSheet: ["cash", "totalAssets", "totalLiabilities", "stockholdersEquity"],
      cashFlowStatement: ["operatingCashFlow"],
      perShare: ["dilutedEps"],
    };
  const notes: FinancialStatementNote[] = [];
  for (const period of ["annual", "interim"] as const) {
    const periodFacts = new Map<string, FinancialStatementFact>();
    const checkedBalancePeriodEnds = new Set<string>();
    for (const fact of series.flatMap((item) => item[period])) {
      periodFacts.set(fact.periodKey, fact);
    }
    for (const [canonicalPeriodKey, anchor] of [...periodFacts.entries()].toSorted(
      (left, right) =>
        left[1].periodEnd.localeCompare(right[1].periodEnd) || left[0].localeCompare(right[0]),
    )) {
      const statements = (
        anchor.periodStart === undefined
          ? []
          : Object.entries(required).filter(([statement]) => statement !== "balanceSheet")
      ) as readonly [FinancialStatementName, readonly FinancialStatementSeriesKey[]][];
      for (const [statement, keys] of statements) {
        const missing = keys.filter((key) => {
          const facts = series.find((item) => item.key === key)?.[period] ?? [];
          return !facts.some((fact) => fact.periodKey === canonicalPeriodKey);
        });
        if (missing.length > 0) {
          notes.push({
            code: "incomplete-statement",
            periodKey: `${period}|${canonicalPeriodKey}`,
            message: `${statement} ${period} period ${canonicalPeriodKey} is missing ${missing.join(", ")}`,
          });
        }
      }
      if (checkedBalancePeriodEnds.has(anchor.periodEnd)) {
        continue;
      }
      checkedBalancePeriodEnds.add(anchor.periodEnd);
      const missingBalance = required.balanceSheet.filter((key) => {
        const facts = series.find((item) => item.key === key)?.[period] ?? [];
        return !facts.some((fact) => fact.periodEnd === anchor.periodEnd);
      });
      if (missingBalance.length > 0) {
        notes.push({
          code: "incomplete-statement",
          periodKey: `${period}|${canonicalPeriodKey}`,
          message: `balanceSheet ${period} period ${canonicalPeriodKey} is missing ${missingBalance.join(", ")}`,
        });
      }
    }
  }
  return notes;
}

export function capFinancialStatementPeriods(series: readonly FinancialStatementSeries[]): {
  readonly series: readonly FinancialStatementSeries[];
  readonly notes: readonly FinancialStatementNote[];
} {
  const limits = { annual: MAX_ANNUAL_PERIODS, interim: MAX_INTERIM_PERIODS } as const;
  const allowed = new Map<"annual" | "interim", ReadonlySet<string>>();
  const notes: FinancialStatementNote[] = [];
  for (const period of ["annual", "interim"] as const) {
    const periodFacts = new Map<string, FinancialStatementFact>();
    for (const fact of series.flatMap((item) => item[period])) {
      periodFacts.set(fact.periodKey, fact);
    }
    const periodKeys = [...periodFacts.entries()]
      .toSorted(
        (left, right) =>
          left[1].periodEnd.localeCompare(right[1].periodEnd) || left[0].localeCompare(right[0]),
      )
      .map(([key]) => key);
    const omitted = periodKeys.slice(0, -limits[period]);
    allowed.set(period, new Set(periodKeys.slice(-limits[period])));
    for (const periodKey of omitted) {
      notes.push({
        code: "history-cap",
        periodKey: `${period}|${periodKey}`,
        message: `Older ${period} canonical period ${periodKey} omitted by the shared ${String(limits[period])}-period cap`,
      });
    }
  }
  return {
    series: series.map((item) => ({
      ...item,
      annual: item.annual.filter((fact) => allowed.get("annual")!.has(fact.periodKey)),
      interim: item.interim.filter((fact) => allowed.get("interim")!.has(fact.periodKey)),
    })),
    notes,
  };
}
