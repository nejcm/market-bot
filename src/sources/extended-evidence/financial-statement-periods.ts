import type { FinancialStatementSeriesDefinition } from "./financial-statement-definitions";
import type {
  FinancialStatementFact,
  FinancialStatementName,
  FinancialStatementNote,
  FinancialStatementSeries,
  FinancialStatementSeriesKey,
  FinancialStatementTtm,
  InterimCadence,
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

export function financialStatementPeriodMonths(fact: FinancialStatementFact): number | undefined {
  if (fact.periodStart === undefined) {
    return undefined;
  }
  const days = daysBetween(fact.periodStart, fact.periodEnd);
  return days !== undefined && days > 0 ? Math.round(days / DAYS_PER_MONTH) : undefined;
}

function isYearAligned(prior: string, latest: string): boolean {
  const days = daysBetween(prior, latest);
  return days !== undefined && days >= ALIGNMENT_MIN_DAYS && days <= ALIGNMENT_MAX_DAYS;
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
  const fiscalYear = annual.at(-1)!;
  const latestYearToDate = interim
    .filter((fact) => fact.periodStart !== undefined && fact.periodEnd > fiscalYear.periodEnd)
    .toSorted(
      (left, right) =>
        right.periodEnd.localeCompare(left.periodEnd) ||
        (financialStatementPeriodMonths(right) ?? 0) -
          (financialStatementPeriodMonths(left) ?? 0) ||
        right.filedAt.localeCompare(left.filedAt),
    )
    .at(0);
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
  const priorYearToDate = interim
    .filter(
      (fact) =>
        fact.periodStart !== undefined &&
        fact.periodEnd < fiscalYear.periodEnd &&
        financialStatementPeriodMonths(fact) === latestMonths &&
        isYearAligned(fact.periodStart, latestYearToDate.periodStart!) &&
        isYearAligned(fact.periodEnd, latestYearToDate.periodEnd),
    )
    .toSorted(
      (left, right) =>
        right.periodEnd.localeCompare(left.periodEnd) || right.filedAt.localeCompare(left.filedAt),
    )
    .at(0);
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
      unitScale: 1,
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
    for (const fact of series.flatMap((item) => item[period])) {
      periodFacts.set(fact.periodKey, fact);
    }
    for (const [canonicalPeriodKey, anchor] of [...periodFacts.entries()].toSorted(
      (left, right) =>
        left[1].periodEnd.localeCompare(right[1].periodEnd) || left[0].localeCompare(right[0]),
    )) {
      const statements = (
        anchor.periodStart === undefined
          ? [["balanceSheet", required.balanceSheet]]
          : Object.entries(required)
      ) as readonly [FinancialStatementName, readonly FinancialStatementSeriesKey[]][];
      for (const [statement, keys] of statements) {
        const missing = keys.filter((key) => {
          const facts = series.find((item) => item.key === key)?.[period] ?? [];
          return statement === "balanceSheet"
            ? !facts.some((fact) => fact.periodEnd === anchor.periodEnd)
            : !facts.some((fact) => fact.periodKey === canonicalPeriodKey);
        });
        if (missing.length > 0) {
          notes.push({
            code: "incomplete-statement",
            periodKey: `${period}|${canonicalPeriodKey}`,
            message: `${statement} ${period} period ${canonicalPeriodKey} is missing ${missing.join(", ")}`,
          });
        }
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
