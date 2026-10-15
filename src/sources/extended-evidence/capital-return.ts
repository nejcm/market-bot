import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "./financial-statements-contract";
import { conceptScope, scopedLabel } from "./financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  earlierShareBasisPeriods,
  financialStatementFacts,
  financialStatementSeriesByKey,
  isYearAligned,
  touchesEarlierShareBasis,
} from "./financial-statement-selection";
import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
  seriesNotFiled,
  statementInput as metricStatementInput,
} from "./metric-engine";

export type JoinSeries =
  | "dividendsPaid"
  | "shareRepurchases"
  | "operatingCashFlow"
  | "capitalExpenditure"
  | "dilutedShares"
  | "dividendsPerShare"
  | "revenue"
  | "operatingIncome"
  | "interestExpense"
  | "incomeTaxExpense"
  | "pretaxIncome"
  | "depreciationAndAmortization"
  | "stockholdersEquity"
  | "debt"
  | "cash";

type FiscalYearSeries = readonly [JoinSeries, ...JoinSeries[]];

export const SERIES_LABELS: Readonly<Record<JoinSeries, string>> = {
  dividendsPaid: "dividends paid",
  shareRepurchases: "share repurchases",
  operatingCashFlow: "operating cash flow",
  capitalExpenditure: "capital expenditure",
  dilutedShares: "diluted shares",
  dividendsPerShare: "dividends per share",
  revenue: "revenue",
  operatingIncome: "operating income",
  interestExpense: "interest expense",
  incomeTaxExpense: "income tax expense",
  pretaxIncome: "pretax income",
  depreciationAndAmortization: "depreciation and amortization",
  stockholdersEquity: "stockholders' equity",
  debt: "debt",
  cash: "cash and cash equivalents",
};

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365;
const ENDPOINT_TOLERANCE_DAYS = 15;
const SHARE_TREND_BAND = 0.03;
const SHARE_TREND_YEARS = 3;
// R8: the next fiscal year (12 months) plus the 20-F four-month deadline; past this a newer FY was due.
const NEXT_ANNUAL_FILING_DUE_MONTHS = 16;
// A 52/53-week year can end up to a week after the calendar anniversary.
const FISCAL_YEAR_END_SLACK_DAYS = 7;

interface MissingSelection {
  readonly facts: readonly FinancialStatementFact[];
  readonly missing: string;
  readonly cause?: "not-filed";
}

type FiscalYearSelection =
  | {
      readonly facts: readonly FinancialStatementFact[];
      readonly missing?: undefined;
      readonly cause?: undefined;
    }
  | MissingSelection;

function notFiledSelection(
  ctx: MetricContext,
  key: JoinSeries,
  facts: readonly FinancialStatementFact[],
): MissingSelection | undefined {
  return seriesNotFiled(ctx, key)
    ? { facts, missing: `${SERIES_LABELS[key]} not filed by the issuer`, cause: "not-filed" }
    : undefined;
}

function eligibleAnnualFacts(
  ctx: MetricContext,
  key: FinancialStatementSeriesKey,
): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return (series?.annual ?? [])
    .filter(
      (fact) =>
        fact.periodType === "annual" &&
        fact.periodStart !== undefined &&
        isYearAligned(fact.periodStart, fact.periodEnd),
    )
    .toSorted(compareFinancialStatementFacts);
}

export function statementInput(fact: FinancialStatementFact, key: JoinSeries): MetricInput {
  const scope = key === "pretaxIncome" ? conceptScope(fact.concept) : undefined;
  return metricStatementInput(fact, key, scopedLabel(SERIES_LABELS[key], scope));
}

// Month-end period ends map to month-end due dates (June 30 -> October 31).
function nextAnnualFilingCutoff(periodEnd: string): string {
  const end = new Date(`${periodEnd.slice(0, 10)}T00:00:00Z`);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth() + NEXT_ANNUAL_FILING_DUE_MONTHS;
  const day = end.getUTCDate();
  const isMonthEnd = new Date(Date.UTC(year, end.getUTCMonth() + 1, 0)).getUTCDate() === day;
  const targetMonthEnd = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const due = Date.UTC(year, month, isMonthEnd ? targetMonthEnd : Math.min(day, targetMonthEnd));
  return new Date(due + FISCAL_YEAR_END_SLACK_DAYS * DAY_MS).toISOString().slice(0, 10);
}

function staleAnchor(ctx: MetricContext, label: string, periodEnd: string): string | undefined {
  const analysisAsOf = ctx.statements?.analysisAsOf;
  return analysisAsOf !== undefined && analysisAsOf.slice(0, 10) > nextAnnualFilingCutoff(periodEnd)
    ? `stale ${label} as of ${periodEnd}`
    : undefined;
}

// R1: the first series anchors the fiscal year; every other series must share its exact period.
function fiscalYearFacts(ctx: MetricContext, keys: FiscalYearSeries): FiscalYearSelection {
  const [anchorKey, ...joinedKeys] = keys;
  const [anchor] = eligibleAnnualFacts(ctx, anchorKey);
  if (anchor === undefined) {
    return { facts: [], missing: `no year-aligned annual ${SERIES_LABELS[anchorKey]} fact` };
  }
  const stale = staleAnchor(ctx, SERIES_LABELS[anchorKey], anchor.periodEnd);
  if (stale !== undefined) {
    return { facts: [anchor], missing: stale };
  }
  const facts = [anchor];
  for (const key of joinedKeys) {
    const match = eligibleAnnualFacts(ctx, key).find(
      (fact) => fact.periodKey === anchor.periodKey && fact.periodType === anchor.periodType,
    );
    if (match === undefined) {
      return {
        facts,
        missing: `no same-period ${SERIES_LABELS[key]} for the fiscal year ending ${anchor.periodEnd}`,
      };
    }
    facts.push(match);
  }
  return { facts };
}

export type Gate = (
  ctx: MetricContext,
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
) => MetricOutcome | undefined;

const NO_GATE: Gate = () => undefined;

// Unfiled inputs are wildcards: the filed ones still run the full anchor, join, freshness and gate path,
// And any failure there wins; only a would-be value becomes not-filed.
export function joinedMetric(
  keys: FiscalYearSeries,
  gate: Gate,
  compute: (ctx: MetricContext, facts: readonly FinancialStatementFact[]) => MetricOutcome,
) {
  return (ctx: MetricContext): MetricOutcome => {
    const unfiled = keys.filter((key) => seriesNotFiled(ctx, key));
    const filed = keys.filter((key) => !unfiled.includes(key));
    const [first, ...rest] = filed;
    const selection: FiscalYearSelection =
      first === undefined ? { facts: [] } : fiscalYearFacts(ctx, [first, ...rest]);
    if (selection.missing !== undefined) {
      return missingOutcome(selection, filed);
    }
    const blocked = gate(ctx, selection.facts, filed);
    if (blocked !== undefined) {
      return blocked;
    }
    if (unfiled.length === 0) {
      return compute(ctx, selection.facts);
    }
    return missingOutcome(
      {
        facts: selection.facts,
        missing: `${unfiled.map((key) => SERIES_LABELS[key]).join(" and ")} not filed by the issuer`,
        cause: "not-filed",
      },
      filed,
    );
  };
}

function missingOutcome(
  { facts, missing: reason, cause }: MissingSelection,
  keys: readonly JoinSeries[],
  extraInputs: readonly MetricInput[] = [],
): MetricOutcome {
  const [anchor] = facts;
  return {
    status: "missing",
    reason,
    ...(cause !== undefined ? { cause } : {}),
    ...(anchor !== undefined ? { periodEnd: anchor.periodEnd } : {}),
    inputs: [...inputsOf(facts, keys), ...extraInputs],
  };
}

export function inputsOf(
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
): readonly MetricInput[] {
  return facts.map((fact, index) => statementInput(fact, keys[index]!));
}

function absoluteSum(facts: readonly FinancialStatementFact[]): number {
  return facts.reduce((sum, fact) => sum + Math.abs(fact.value), 0);
}

function latestFyAmount(key: JoinSeries) {
  return joinedMetric([key], NO_GATE, (_ctx, [fact]) => ({
    status: "value",
    value: Math.abs(fact!.value),
    ...(fact!.currency !== null ? { currency: fact!.currency } : {}),
    periodEnd: fact!.periodEnd,
    inputs: inputsOf([fact!], [key]),
  }));
}

function daysBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS;
}

type Endpoints =
  | {
      readonly prior: FinancialStatementFact;
      readonly latest: FinancialStatementFact;
      readonly inputs: readonly MetricInput[];
    }
  | { readonly outcome: MetricOutcome };

// R6: a split inside the window makes the endpoints incomparable; they are refused, not adjusted.
function annualEndpoints(
  ctx: MetricContext,
  key: "dilutedShares" | "dividendsPerShare",
  years: number,
): Endpoints {
  const label = SERIES_LABELS[key];
  const facts = eligibleAnnualFacts(ctx, key);
  const [latest] = facts;
  if (latest === undefined) {
    return {
      outcome: missingOutcome(
        notFiledSelection(ctx, key, []) ?? {
          facts: [],
          missing: `no year-aligned annual ${label} fact`,
        },
        [key],
      ),
    };
  }
  const stale = staleAnchor(ctx, label, latest.periodEnd);
  if (stale !== undefined) {
    return { outcome: missingOutcome({ facts: [latest], missing: stale }, [key]) };
  }
  const prior = facts.find(
    (fact) =>
      Math.abs(daysBetween(fact.periodEnd, latest.periodEnd) - years * DAYS_PER_YEAR) <=
      ENDPOINT_TOLERANCE_DAYS,
  );
  if (prior === undefined) {
    return {
      outcome: missingOutcome(
        {
          facts: [latest],
          missing: `no annual ${label} fact ${String(years)}y before the fiscal year ending ${latest.periodEnd}`,
        },
        [key],
      ),
    };
  }
  const inputs = [statementInput(prior, key), statementInput(latest, key)];
  const series = financialStatementSeriesByKey(ctx.statements!, key)!;
  const window = financialStatementFacts(series).filter(
    (fact) => fact.periodEnd >= prior.periodEnd && fact.periodEnd <= latest.periodEnd,
  );
  if (
    touchesEarlierShareBasis(window, earlierShareBasisPeriods(ctx.statements!.omissionNotes, key))
  ) {
    return {
      outcome: {
        status: "not-meaningful",
        reason: `${label} inside the window are on an earlier share basis`,
        inputs,
      },
    };
  }
  return { prior, latest, inputs };
}

function shareCountChange(ctx: MetricContext, years: number): MetricOutcome {
  const endpoints = annualEndpoints(ctx, "dilutedShares", years);
  if ("outcome" in endpoints) {
    return endpoints.outcome;
  }
  const { prior, latest, inputs } = endpoints;
  if (prior.value <= 0) {
    return {
      status: "not-meaningful",
      reason: "earlier diluted share count is not positive",
      inputs,
    };
  }
  return {
    status: "value",
    value: latest.value / prior.value - 1,
    periodEnd: latest.periodEnd,
    inputs,
  };
}

function dividendsPerShareCagr(ctx: MetricContext, years: number): MetricOutcome {
  const endpoints = annualEndpoints(ctx, "dividendsPerShare", years);
  if ("outcome" in endpoints) {
    return endpoints.outcome;
  }
  const { prior, latest, inputs } = endpoints;
  if (prior.value <= 0 || latest.value < 0) {
    return {
      status: "not-meaningful",
      reason:
        prior.value <= 0
          ? `dividends per share ${String(years)}y earlier is not positive`
          : "latest dividends per share is negative",
      inputs,
    };
  }
  return {
    status: "value",
    value: (latest.value / prior.value) ** (1 / years) - 1,
    periodEnd: latest.periodEnd,
    inputs,
  };
}

function earliestDividendFiscalYear(ctx: MetricContext): MetricOutcome {
  const facts = eligibleAnnualFacts(ctx, "dividendsPerShare");
  if (facts.length === 0) {
    return missingOutcome(
      notFiledSelection(ctx, "dividendsPerShare", []) ?? {
        facts: [],
        missing: "no year-aligned annual dividends per share fact",
      },
      ["dividendsPerShare"],
    );
  }
  const earliest = facts.findLast((fact) => fact.value > 0);
  if (earliest === undefined) {
    return {
      status: "missing",
      reason: "no positive annual dividends per share fact in filed history",
      inputs: [statementInput(facts[0]!, "dividendsPerShare")],
    };
  }
  return {
    status: "value",
    value: `FY${String(earliest.fiscalYear)}`,
    periodEnd: earliest.periodEnd,
    inputs: [statementInput(earliest, "dividendsPerShare")],
  };
}

function filedFacts(
  ctx: MetricContext,
  key: "dividendsPaid" | "dividendsPerShare",
): readonly FinancialStatementFact[] {
  const series =
    ctx.statements === undefined ? undefined : financialStatementSeriesByKey(ctx.statements, key);
  return series === undefined ? [] : financialStatementFacts(series);
}

function zeroDividendFacts(ctx: MetricContext): boolean {
  const { missing } = fiscalYearFacts(ctx, ["dividendsPerShare", "dividendsPaid"]);
  return (
    missing === undefined &&
    filedFacts(ctx, "dividendsPaid").every((fact) => fact.value === 0) &&
    filedFacts(ctx, "dividendsPerShare").every((fact) => fact.value === 0)
  );
}

// R7(c): only an affirmed non-payer, never one whose dividend facts are absent, stale or filtered out.
function noDividendHistory(ctx: MetricContext): string | undefined {
  return ctx.statements?.dividendPaymentFiled === false && zeroDividendFacts(ctx)
    ? "no dividend history in filed data"
    : undefined;
}

function unlessPaymentEvidenceUnknown(
  compute: MetricDefinition["compute"],
): MetricDefinition["compute"] {
  return (ctx) =>
    ctx.statements?.dividendPaymentFiled === undefined && zeroDividendFacts(ctx)
      ? { status: "missing", reason: "dividend payment evidence is not recorded in this artifact" }
      : compute(ctx);
}

function latestDividendsPerShare(ctx: MetricContext): MetricOutcome {
  const outcome = latestFyAmount("dividendsPerShare")(ctx);
  const latest = outcome.status === "value" ? outcome.inputs[0]?.value : undefined;
  return outcome.status === "value" && typeof latest === "number" && latest < 0
    ? {
        status: "not-meaningful",
        reason: "latest dividends per share is negative",
        ...(outcome.periodEnd !== undefined ? { periodEnd: outcome.periodEnd } : {}),
        inputs: outcome.inputs,
      }
    : outcome;
}

function shareCountTrend(ctx: MetricContext): MetricOutcome {
  const change = shareCountChange(ctx, SHARE_TREND_YEARS);
  if (change.status !== "value" || typeof change.value !== "number") {
    return change;
  }
  if (Math.abs(change.value) < SHARE_TREND_BAND) {
    return { ...change, value: "stable" };
  }
  return { ...change, value: change.value < 0 ? "declining" : "increasing" };
}

function quoteInput(quote: NonNullable<MetricContext["quote"]>): MetricInput {
  return {
    label: "market cap",
    value: quote.marketCap,
    artifact: "quote",
    series: "marketCap",
    periodEnd: quote.asOf,
    unit: quote.currency ?? "unknown",
    ...(quote.currency !== undefined ? { currency: quote.currency } : {}),
    sourceIds: [quote.sourceId],
  };
}

const quoteGate: Gate = (ctx, facts, keys) => {
  const { quote } = ctx;
  if (quote === undefined) {
    return missingOutcome({ facts, missing: "no quote market cap" }, keys);
  }
  const reportingCurrency = facts[0]?.currency ?? ctx.statements?.reportingCurrency ?? null;
  if (quote.currency === undefined || reportingCurrency !== quote.currency) {
    return missingOutcome(
      {
        facts,
        missing: `reporting currency ${reportingCurrency ?? "unknown"} differs from quote currency ${quote.currency ?? "unknown"}`,
      },
      keys,
      [quoteInput(quote)],
    );
  }
  return quote.marketCap <= 0
    ? {
        status: "not-meaningful",
        reason: "market cap is not positive",
        inputs: [...inputsOf(facts, keys), quoteInput(quote)],
      }
    : undefined;
};

function marketCapYield(keys: FiscalYearSeries) {
  return joinedMetric(keys, quoteGate, (ctx, facts) => ({
    status: "value",
    value: absoluteSum(facts) / ctx.quote!.marketCap,
    periodEnd: facts[0]!.periodEnd,
    inputs: [...inputsOf(facts, keys), quoteInput(ctx.quote!)],
  }));
}

function freeCashFlowOf(
  facts: readonly FinancialStatementFact[],
  keys: readonly JoinSeries[],
): number | undefined {
  const operatingCashFlow = facts[keys.indexOf("operatingCashFlow")];
  const capitalExpenditure = facts[keys.indexOf("capitalExpenditure")];
  return operatingCashFlow === undefined || capitalExpenditure === undefined
    ? undefined
    : operatingCashFlow.value - Math.abs(capitalExpenditure.value);
}

const freeCashFlowGate: Gate = (_ctx, facts, keys) => {
  const freeCashFlow = freeCashFlowOf(facts, keys);
  return freeCashFlow !== undefined && freeCashFlow <= 0
    ? {
        status: "not-meaningful",
        reason: `free cash flow is zero or negative for the fiscal year ending ${facts[0]!.periodEnd}`,
        inputs: inputsOf(facts, keys),
      }
    : undefined;
};

function freeCashFlowRatio(numerators: FiscalYearSeries) {
  const keys: FiscalYearSeries = [...numerators, "operatingCashFlow", "capitalExpenditure"];
  return joinedMetric(keys, freeCashFlowGate, (_ctx, facts) => ({
    status: "value",
    value: absoluteSum(facts.slice(0, numerators.length)) / freeCashFlowOf(facts, keys)!,
    periodEnd: facts[0]!.periodEnd,
    inputs: inputsOf(facts, keys),
  }));
}

function depositoryIssuer(ctx: MetricContext): string | undefined {
  return ctx.depositorySic === undefined
    ? undefined
    : `depository issuer (SIC ${ctx.depositorySic}): operating cash flow is not a free cash flow basis`;
}

function latestStockBasedCompensation(ctx: MetricContext): MetricOutcome {
  const fact = ctx.capitalOwnership?.stockBasedCompensation
    .filter(
      (candidate) =>
        candidate.periodStart !== undefined &&
        isYearAligned(candidate.periodStart, candidate.periodEnd),
    )
    .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
    .at(0);
  if (fact?.periodStart === undefined) {
    return { status: "missing", reason: "no year-aligned annual stock-based compensation fact" };
  }
  const inputs: readonly MetricInput[] = [
    {
      label: "stock-based compensation",
      value: fact.value,
      artifact: "capitalOwnership",
      series: "stockBasedCompensation",
      periodType: "annual",
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      unit: fact.unit,
      currency: fact.unit,
      sourceIds: fact.sourceIds,
    },
  ];
  const stale = staleAnchor(ctx, "stock-based compensation", fact.periodEnd);
  if (stale !== undefined) {
    return { status: "missing", reason: stale, periodEnd: fact.periodEnd, inputs };
  }
  return {
    status: "value",
    value: fact.value,
    currency: fact.unit,
    periodEnd: fact.periodEnd,
    inputs,
  };
}

const FCF_BASIS =
  "free cash flow = operating cash flow - capital expenditure, all from one year-aligned fiscal year";

const CAPITAL_RETURN_METRICS: readonly MetricDefinition[] = [
  {
    id: "buybacksLatestFy",
    label: "Share repurchases (latest FY)",
    unit: "currency",
    basis: "cash paid for share repurchases in the latest year-aligned fiscal year",
    compute: latestFyAmount("shareRepurchases"),
  },
  {
    id: "dividendsLatestFy",
    label: "Dividends paid (latest FY)",
    unit: "currency",
    basis: "cash dividends paid in the latest year-aligned fiscal year",
    compute: latestFyAmount("dividendsPaid"),
  },
  ...[1, 3, 5].map(
    (years): MetricDefinition => ({
      id: `shareCountChange${String(years)}y`,
      label: `Diluted share count change (${String(years)}y)`,
      unit: "ratio-percent",
      basis: `diluted weighted-average shares, latest fiscal year vs the fiscal year ${String(years)}y earlier`,
      compute: (ctx) => shareCountChange(ctx, years),
    }),
  ),
  {
    id: "shareCountTrend",
    label: "Diluted share count trend (3y)",
    unit: "text",
    basis: `3y diluted share count change: declining at or below -${String(SHARE_TREND_BAND * 100)}%, increasing at or above +${String(SHARE_TREND_BAND * 100)}%, else stable`,
    compute: shareCountTrend,
  },
  {
    id: "buybackYield",
    label: "Buyback yield",
    unit: "ratio-percent",
    basis: "latest FY share repurchases / current quote market cap",
    compute: marketCapYield(["shareRepurchases"]),
  },
  {
    id: "dividendYieldFiled",
    label: "Dividend yield (filed)",
    unit: "ratio-percent",
    basis: "latest FY dividends paid / current quote market cap",
    compute: marketCapYield(["dividendsPaid"]),
  },
  {
    id: "shareholderYield",
    label: "Shareholder yield",
    unit: "ratio-percent",
    basis: "latest FY dividends paid + same-year share repurchases / current quote market cap",
    compute: marketCapYield(["dividendsPaid", "shareRepurchases"]),
  },
  {
    id: "fcfPayoutRatio",
    label: "Dividends / free cash flow",
    unit: "ratio-percent",
    basis: `latest FY dividends paid / ${FCF_BASIS}`,
    applicable: depositoryIssuer,
    compute: freeCashFlowRatio(["dividendsPaid"]),
  },
  {
    id: "totalPayoutToFcf",
    label: "Dividends + repurchases / free cash flow",
    unit: "ratio-percent",
    basis: `latest FY dividends paid + share repurchases / ${FCF_BASIS}`,
    applicable: depositoryIssuer,
    compute: freeCashFlowRatio(["dividendsPaid", "shareRepurchases"]),
  },
  {
    id: "dpsLatestFy",
    label: "Dividends per share (latest FY)",
    unit: "currency-per-share",
    basis:
      "dividends declared per share, else cash paid per share, in the latest year-aligned fiscal year",
    compute: latestDividendsPerShare,
  },
  ...[3, 5].map(
    (years): MetricDefinition => ({
      id: `dpsCagr${String(years)}y`,
      label: `Dividends per share growth (${String(years)}y CAGR)`,
      unit: "ratio-percent",
      basis: `compound annual change in dividends per share, latest fiscal year vs the fiscal year ${String(years)}y earlier`,
      applicable: noDividendHistory,
      compute: unlessPaymentEvidenceUnknown((ctx) => dividendsPerShareCagr(ctx, years)),
    }),
  ),
  {
    id: "earliestDividendFyInHistory",
    label: "Earliest dividend year in filed history",
    unit: "text",
    basis:
      "earliest year-aligned fiscal year with positive dividends per share among retained annual filings",
    applicable: noDividendHistory,
    compute: unlessPaymentEvidenceUnknown(earliestDividendFiscalYear),
  },
  {
    id: "sbcLatestFy",
    label: "Stock-based compensation (latest FY)",
    unit: "currency",
    basis: "stock-based compensation in the latest annual filing",
    compute: latestStockBasedCompensation,
  },
];

export function capitalReturnSection(ctx: MetricContext): ReturnType<typeof evaluateMetricSection> {
  return evaluateMetricSection("capital-return", "Capital Return", CAPITAL_RETURN_METRICS, ctx);
}
