import { isRecord } from "../guards";
import type {
  EquityAnalysisDimensionStatus,
  MarketSnapshot,
  MarketSnapshotPriceAsOf,
  SourceGap,
} from "../domain/types";
import type {
  FinancialStatementFact,
  FinancialStatementsArtifact,
} from "../sources/extended-evidence/financial-statements-contract";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeries,
} from "../sources/extended-evidence/fundamental-history";
import type { PeerImpliedRange } from "../sources/extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "../sources/extended-evidence/valuation-workbench-contract";
import { readGapTriage } from "./gap-triage";

export interface TrendPeriod {
  readonly kind: "annual" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

export interface LabeledPeriod {
  readonly kind: "annual" | "interim" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

export interface FinancialTrendRow {
  readonly period: string;
  readonly revenue: string;
  readonly netIncome: string;
  readonly operatingMargin: string;
  readonly freeCashFlow: string;
}

export interface CompanyDescription {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface EquityReaderFinancialTrends {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly rows: readonly FinancialTrendRow[];
}

export interface EquityReaderStatementValue {
  readonly value: number;
  readonly filedAt: string;
  readonly unit: string;
  readonly unitScale: number;
  readonly sourceIds: readonly string[];
}

export interface EquityReaderBalanceSheetRow extends LabeledPeriod {
  readonly kind: "annual" | "interim";
  readonly cash?: EquityReaderStatementValue;
  readonly debt?: EquityReaderStatementValue;
  readonly dilutedShares?: EquityReaderStatementValue;
}

export interface EquityReaderBalanceSheetHistory {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly rows: readonly EquityReaderBalanceSheetRow[];
}

export interface EquityReaderMarketMultiple {
  readonly key: "trailingPE" | "forwardPE" | "priceToBook";
  readonly value: number;
}

export type EquityReaderValuationContext =
  | {
      readonly kind: "peer-range";
      readonly status: "derived";
      readonly range: Extract<PeerImpliedRange, { status: "derived" }>;
      readonly priceAsOf?: MarketSnapshotPriceAsOf;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly kind: "peer-range";
      readonly status: "suppressed";
      readonly range: Extract<PeerImpliedRange, { status: "suppressed" }>;
      readonly sourceIds: readonly string[];
      readonly fallbackMetrics: readonly EquityReaderMarketMultiple[];
      readonly fallbackSourceIds: readonly string[];
    }
  | {
      readonly kind: "market-multiples";
      readonly metrics: readonly EquityReaderMarketMultiple[];
      readonly sourceIds: readonly string[];
    }
  | {
      readonly kind: "unavailable";
      readonly sourceIds: readonly string[];
    };

export type EquityReaderConsensusItem =
  | {
      readonly kind: "earnings-date";
      readonly symbol: string;
      readonly date: string;
      readonly timing: string;
      readonly status: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly kind: "eps-consensus";
      readonly value: number;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly kind: "revenue-consensus";
      readonly value: number;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly kind: "analyst-consensus";
      readonly title: string;
      readonly mean: number;
      readonly period?: string;
      readonly count?: number;
      readonly sourceIds: readonly string[];
    };

export interface EquityReaderAnalystEstimateDistribution {
  readonly title: string;
  readonly period?: string;
  readonly mean?: number;
  readonly median?: number;
  readonly high?: number;
  readonly low?: number;
  readonly count?: number;
  readonly sourceIds: readonly string[];
}

export type EquityReaderFinancialCoreStatus = "complete" | "partial" | "blocked";
export type EquityReaderCoverageLevel = "comprehensive" | "substantial" | "limited";

export type EquityReaderCompletenessDimensionKey =
  | "primaryFinancials"
  | "valuation"
  | "expectations"
  | "capitalOwnership"
  | "operatingKpis";

export interface EquityReaderCompletenessDimension {
  readonly key: EquityReaderCompletenessDimensionKey;
  readonly label: string;
  readonly status: EquityAnalysisDimensionStatus;
  readonly reasonCodes: readonly string[];
  readonly asOf: string;
  readonly sourceIds: readonly string[];
}

export interface EquityReaderAppendixCompleteness {
  readonly coverageLevel: EquityReaderCoverageLevel;
  readonly asOf: string;
  readonly dimensions: readonly EquityReaderCompletenessDimension[];
}

export interface EquityReaderProjection {
  readonly defaultView: {
    readonly financialCoreStatus?: EquityReaderFinancialCoreStatus;
    readonly financialTrends?: EquityReaderFinancialTrends;
    readonly valuationContext: EquityReaderValuationContext;
    readonly earningsConsensus: readonly EquityReaderConsensusItem[];
    readonly materialGaps: readonly string[];
  };
  readonly appendix: {
    readonly completeness?: EquityReaderAppendixCompleteness;
    readonly balanceSheetHistory?: EquityReaderBalanceSheetHistory;
    readonly analystEstimateDistributions: readonly EquityReaderAnalystEstimateDistribution[];
    readonly diagnosticGaps: readonly string[];
    readonly predictionShortfalls: readonly string[];
  };
}

export const COMPLETENESS_DIMENSION_LABELS: readonly {
  readonly key: EquityReaderCompletenessDimensionKey;
  readonly label: string;
}[] = [
  { key: "primaryFinancials", label: "Primary financials" },
  { key: "valuation", label: "Valuation" },
  { key: "expectations", label: "Expectations" },
  { key: "capitalOwnership", label: "Capital & ownership" },
  { key: "operatingKpis", label: "Operating KPIs" },
];

export interface EquityReaderProjectionInput {
  readonly report: unknown;
  readonly marketSnapshot?: MarketSnapshot;
  readonly fundamentalHistory?: FundamentalHistoryArtifact;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly valuationWorkbench?: ValuationWorkbenchArtifact;
  readonly peerImpliedRange?: PeerImpliedRange;
  readonly sourceGaps?: readonly SourceGap[];
}

interface CompanyDescriptionReport {
  readonly extras?: unknown;
  readonly sources?: unknown;
}

export const NO_COMPANY_DESCRIPTION = "No cited plain-language company description is available.";
const TREND_SERIES_KEYS = ["revenue", "netIncome", "operatingMargin", "freeCashFlowProxy"] as const;
const PREDICTION_SHORTFALL_PREFIX = "predictionShortfall:";

export function periodLabel(period: LabeledPeriod): string {
  if (period.kind === "ttm") {
    return `TTM (${period.periodEnd}; filed ${period.filedAt})`;
  }
  return `${period.kind === "annual" ? "FY" : "Interim"} ending ${period.periodEnd} (filed ${period.filedAt})`;
}

export function trendPeriods(history: FundamentalHistoryArtifact): readonly TrendPeriod[] {
  const annual = new Map<string, TrendPeriod>();
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    for (const point of series.annual) {
      const existing = annual.get(point.periodEnd);
      if (existing === undefined || point.filedAt > existing.filedAt) {
        annual.set(point.periodEnd, {
          kind: "annual",
          periodEnd: point.periodEnd,
          filedAt: point.filedAt,
        });
      }
    }
  }

  const annualRows = [...annual.values()]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .slice(-5);
  let ttm: TrendPeriod | undefined = undefined;
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    const point = series.ttm;
    if (
      point !== undefined &&
      (ttm === undefined ||
        point.periodEnd > ttm.periodEnd ||
        (point.periodEnd === ttm.periodEnd && point.filedAt > ttm.filedAt))
    ) {
      ttm = {
        kind: "ttm",
        periodEnd: point.periodEnd,
        filedAt: point.filedAt,
      };
    }
  }
  return ttm === undefined ? annualRows : [...annualRows, ttm];
}

export function financialTrendGaps(history: FundamentalHistoryArtifact): readonly string[] {
  const missingRevenuePeriods = trendPeriods(history).filter(
    (period) => historyPoint(history.series.revenue, period.periodEnd, period.kind) === undefined,
  ).length;
  if (missingRevenuePeriods === 0) {
    return [];
  }
  return [
    `fundamental-history-revenue: SEC revenue history is unavailable for ${String(missingRevenuePeriods)} rendered period(s); affected revenue and derived operating-margin values are shown as unavailable`,
  ];
}

export function historyPoint(
  series: FundamentalHistorySeries,
  periodEnd: string,
  kind: TrendPeriod["kind"],
): FundamentalHistoryPoint | undefined {
  if (kind === "ttm") {
    return series.ttm?.periodEnd === periodEnd ? series.ttm : undefined;
  }
  return series.annual.find((point) => point.periodEnd === periodEnd);
}

export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
  ] as const;
  for (const [scale, suffix] of units) {
    if (absolute >= scale) {
      return `${(value / scale).toFixed(1)}${suffix}`;
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function trendValue(
  history: FundamentalHistoryArtifact,
  key: keyof FundamentalHistoryArtifact["series"],
  period: TrendPeriod,
): number | undefined {
  return historyPoint(history.series[key], period.periodEnd, period.kind)?.value;
}

export function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function formatTrendPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function financialTrendRows(
  history: FundamentalHistoryArtifact,
): readonly FinancialTrendRow[] {
  return trendPeriods(history).map((period) => ({
    period: periodLabel(period),
    revenue: formatTrendAmount(trendValue(history, "revenue", period)),
    netIncome: formatTrendAmount(trendValue(history, "netIncome", period)),
    operatingMargin: formatTrendPercent(trendValue(history, "operatingMargin", period)),
    freeCashFlow: formatTrendAmount(trendValue(history, "freeCashFlowProxy", period)),
  }));
}

export function financialTrendCurrency(history: FundamentalHistoryArtifact): string | undefined {
  return history.series.revenue.ttm?.currency ?? history.series.revenue.annual.at(-1)?.currency;
}

function uniqueSourceIds(sourceIds: readonly string[]): readonly string[] {
  return [...new Set(sourceIds)];
}

function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function financialTrends(
  history: FundamentalHistoryArtifact | undefined,
): EquityReaderFinancialTrends | undefined {
  if (history === undefined) {
    return undefined;
  }
  const rows = financialTrendRows(history);
  if (rows.length === 0) {
    return undefined;
  }
  const reportingCurrency = financialTrendCurrency(history);
  return {
    ...(reportingCurrency === undefined ? {} : { reportingCurrency }),
    sourceIds: [history.sourceId],
    rows,
  };
}

function observableStatementFact(
  fact: FinancialStatementFact,
  cutoff: string,
  periodEnd?: string,
): boolean {
  return (
    fact.periodEnd <= cutoff &&
    fact.filedAt <= cutoff &&
    (periodEnd === undefined || fact.periodEnd === periodEnd)
  );
}

function compareStatementFacts(
  left: FinancialStatementFact,
  right: FinancialStatementFact,
): number {
  return (
    right.periodEnd.localeCompare(left.periodEnd) ||
    right.filedAt.localeCompare(left.filedAt) ||
    Number(right.periodType === "annual") - Number(left.periodType === "annual")
  );
}

function selectedStatementFact(
  facts: readonly FinancialStatementFact[],
  cutoff: string,
  periodEnd: string,
): FinancialStatementFact | undefined {
  return facts
    .filter((candidate) => observableStatementFact(candidate, cutoff, periodEnd))
    .toSorted(compareStatementFacts)
    .at(0);
}

function statementValue(fact: FinancialStatementFact): EquityReaderStatementValue {
  return {
    value: fact.value,
    filedAt: fact.filedAt,
    unit: fact.unit,
    unitScale: fact.unitScale,
    sourceIds: fact.sourceIds,
  };
}

function balanceSheetHistory(
  artifact: FinancialStatementsArtifact | undefined,
  reportGeneratedAt: string | undefined,
): EquityReaderBalanceSheetHistory | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const cutoff = (reportGeneratedAt ?? artifact.analysisAsOf).slice(0, 10);
  const { cash, debt } = artifact.statements.balanceSheet;
  const { dilutedShares } = artifact.statements.perShare;
  const series = [cash, debt, dilutedShares];
  const facts = series.flatMap((item) => [...item.annual, ...item.interim]);
  const periods = [
    ...new Set(
      facts.filter((fact) => observableStatementFact(fact, cutoff)).map((fact) => fact.periodEnd),
    ),
  ]
    .toSorted()
    .slice(-5);
  const rows = periods.flatMap((periodEnd): readonly EquityReaderBalanceSheetRow[] => {
    const cashFact = selectedStatementFact([...cash.annual, ...cash.interim], cutoff, periodEnd);
    const debtFact = selectedStatementFact([...debt.annual, ...debt.interim], cutoff, periodEnd);
    const dilutedSharesFact = selectedStatementFact(
      [...dilutedShares.annual, ...dilutedShares.interim],
      cutoff,
      periodEnd,
    );
    const filingFact = [cashFact, debtFact, dilutedSharesFact]
      .filter((fact): fact is FinancialStatementFact => fact !== undefined)
      .toSorted(compareStatementFacts)
      .at(0);
    if (filingFact === undefined) {
      return [];
    }
    const { filedAt, periodType: kind } = filingFact;
    return [
      {
        kind,
        periodEnd,
        filedAt,
        ...(cashFact === undefined ? {} : { cash: statementValue(cashFact) }),
        ...(debtFact === undefined ? {} : { debt: statementValue(debtFact) }),
        ...(dilutedSharesFact === undefined
          ? {}
          : { dilutedShares: statementValue(dilutedSharesFact) }),
      },
    ];
  });
  if (rows.length === 0) {
    return undefined;
  }
  return {
    ...(artifact.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: artifact.reportingCurrency }),
    sourceIds: uniqueSourceIds([
      artifact.sourceId,
      ...rows.flatMap((row) => [
        ...(row.cash?.sourceIds ?? []),
        ...(row.debt?.sourceIds ?? []),
        ...(row.dilutedShares?.sourceIds ?? []),
      ]),
    ]),
    rows,
  };
}

function valuationSourceIds(workbench: ValuationWorkbenchArtifact | undefined): readonly string[] {
  if (workbench?.peerComparison.status === "available") {
    return workbench.peerComparison.valuationComps.sourceIds;
  }
  return workbench?.peerComparison.sourceIds ?? [];
}

function valuationPriceAsOf(
  workbench: ValuationWorkbenchArtifact | undefined,
  range: Extract<PeerImpliedRange, { status: "derived" }>,
): MarketSnapshotPriceAsOf | undefined {
  if (workbench?.peerComparison.status === "available") {
    const { priceAsOf, quoteObservedAt } = workbench.peerComparison.valuationComps.target;
    return (
      priceAsOf ??
      (quoteObservedAt === undefined
        ? undefined
        : { kind: "fetch-time-only", instant: quoteObservedAt })
    );
  }
  const { quoteObservedAt } = range.inputs;
  return quoteObservedAt === null
    ? undefined
    : { kind: "fetch-time-only", instant: quoteObservedAt };
}

function valuationContext(
  marketSnapshot: MarketSnapshot | undefined,
  workbench: ValuationWorkbenchArtifact | undefined,
  projectedRange: PeerImpliedRange | undefined,
): EquityReaderValuationContext {
  const workbenchRange =
    workbench?.peerComparison.status === "available"
      ? workbench.peerComparison.valuationComps.impliedPriceRange
      : undefined;
  const range = projectedRange ?? workbenchRange;
  const sourceIds = valuationSourceIds(workbench);
  const fundamentals = marketSnapshot?.fundamentals;
  const metrics = [
    ...(fundamentals?.trailingPE === undefined
      ? []
      : [{ key: "trailingPE" as const, value: fundamentals.trailingPE }]),
    ...(fundamentals?.forwardPE === undefined
      ? []
      : [{ key: "forwardPE" as const, value: fundamentals.forwardPE }]),
    ...(fundamentals?.priceToBook === undefined
      ? []
      : [{ key: "priceToBook" as const, value: fundamentals.priceToBook }]),
  ];
  const marketSourceIds = marketSnapshot === undefined ? [] : [marketSnapshot.sourceId];
  if (range?.status === "derived") {
    const priceAsOf = valuationPriceAsOf(workbench, range);
    return {
      kind: "peer-range",
      status: "derived",
      range,
      ...(priceAsOf === undefined ? {} : { priceAsOf }),
      sourceIds,
    };
  }
  if (range?.status === "suppressed") {
    return {
      kind: "peer-range",
      status: "suppressed",
      range,
      sourceIds,
      fallbackMetrics: metrics,
      fallbackSourceIds: marketSourceIds,
    };
  }
  if (metrics.length > 0 && marketSnapshot !== undefined) {
    return {
      kind: "market-multiples",
      metrics,
      sourceIds: [marketSnapshot.sourceId],
    };
  }
  return { kind: "unavailable", sourceIds: [] };
}

function reportRecord(report: unknown): Record<string, unknown> | undefined {
  return isRecord(report) ? report : undefined;
}

function earningsConsensus(report: unknown): readonly EquityReaderConsensusItem[] {
  const record = reportRecord(report);
  const extras = isRecord(record?.extras) ? record.extras : undefined;
  const setup = isRecord(extras?.earningsSetup) ? extras.earningsSetup : undefined;
  const event = isRecord(setup?.event) ? setup.event : undefined;
  const items: EquityReaderConsensusItem[] = [];
  if (event !== undefined) {
    const sourceIds = stringArrayValue(event.sourceIds);
    if (typeof event.date === "string") {
      const { eventDateStatus, dateStatus, symbol: eventSymbol } = event;
      let status = "confirmation unavailable";
      if (typeof eventDateStatus === "string") {
        status = eventDateStatus;
      } else if (typeof dateStatus === "string") {
        status = dateStatus;
      }
      let symbol = "";
      const reportSymbol = record?.symbol;
      if (typeof eventSymbol === "string") {
        symbol = eventSymbol;
      } else if (typeof reportSymbol === "string") {
        symbol = reportSymbol;
      }
      items.push({
        kind: "earnings-date",
        symbol,
        date: event.date,
        timing: typeof event.timing === "string" ? event.timing : "timing unavailable",
        status,
        sourceIds,
      });
    }
    if (typeof event.epsEstimate === "number") {
      items.push({ kind: "eps-consensus", value: event.epsEstimate, sourceIds });
    }
    if (typeof event.revenueEstimate === "number") {
      items.push({ kind: "revenue-consensus", value: event.revenueEstimate, sourceIds });
    }
  }
  const extendedEvidence = isRecord(record?.extendedEvidence) ? record.extendedEvidence : undefined;
  const extendedItems = Array.isArray(extendedEvidence?.items) ? extendedEvidence.items : [];
  for (const item of extendedItems) {
    if (
      !isRecord(item) ||
      item.category !== "analyst-estimates" ||
      typeof item.title !== "string" ||
      !isRecord(item.metrics) ||
      typeof item.metrics.mean !== "number"
    ) {
      continue;
    }
    items.push({
      kind: "analyst-consensus",
      title: item.title,
      mean: item.metrics.mean,
      ...(typeof item.metrics.period === "string" ? { period: item.metrics.period } : {}),
      ...(typeof item.metrics.count === "number" ? { count: item.metrics.count } : {}),
      sourceIds: stringArrayValue(item.sourceIds),
    });
  }
  return items;
}

function analystEstimateDistributions(
  report: unknown,
): readonly EquityReaderAnalystEstimateDistribution[] {
  const record = reportRecord(report);
  const extendedEvidence = isRecord(record?.extendedEvidence) ? record.extendedEvidence : undefined;
  const items = Array.isArray(extendedEvidence?.items) ? extendedEvidence.items : [];
  return items.flatMap((item): readonly EquityReaderAnalystEstimateDistribution[] => {
    if (
      !isRecord(item) ||
      item.category !== "analyst-estimates" ||
      typeof item.title !== "string" ||
      !isRecord(item.metrics)
    ) {
      return [];
    }
    const { metrics } = item;
    return [
      {
        title: item.title,
        ...(typeof metrics.period === "string" ? { period: metrics.period } : {}),
        ...(typeof metrics.mean === "number" ? { mean: metrics.mean } : {}),
        ...(typeof metrics.median === "number" ? { median: metrics.median } : {}),
        ...(typeof metrics.high === "number" ? { high: metrics.high } : {}),
        ...(typeof metrics.low === "number" ? { low: metrics.low } : {}),
        ...(typeof metrics.count === "number" ? { count: metrics.count } : {}),
        sourceIds: stringArrayValue(item.sourceIds),
      },
    ];
  });
}

function projectedGaps(
  report: unknown,
  history: FundamentalHistoryArtifact | undefined,
  sourceGaps: readonly SourceGap[],
): {
  readonly material: readonly string[];
  readonly diagnostic: readonly string[];
  readonly predictionShortfalls: readonly string[];
} {
  const record = reportRecord(report);
  const reportGaps = Array.isArray(record?.dataGaps)
    ? record.dataGaps.filter((gap): gap is string => typeof gap === "string")
    : [];
  const gaps = [
    ...new Set([...reportGaps, ...(history === undefined ? [] : financialTrendGaps(history))]),
  ];
  const reportSymbol = typeof record?.symbol === "string" ? record.symbol : undefined;
  const material: string[] = [];
  const diagnostic: string[] = [];
  const predictionShortfalls: string[] = [];
  for (const gap of gaps) {
    if (gap.startsWith(PREDICTION_SHORTFALL_PREFIX)) {
      predictionShortfalls.push(gap);
    } else if (readGapTriage(gap, sourceGaps, reportSymbol) === "diagnostic") {
      diagnostic.push(gap);
    } else {
      material.push(gap);
    }
  }
  return { material, diagnostic, predictionShortfalls };
}

function isDimensionStatus(value: unknown): value is EquityAnalysisDimensionStatus {
  return (
    value === "complete" ||
    value === "partial" ||
    value === "blocked" ||
    value === "not-applicable" ||
    value === "not-assessed"
  );
}

function completenessProjection(report: unknown): {
  readonly financialCoreStatus?: EquityReaderFinancialCoreStatus;
  readonly appendix?: EquityReaderAppendixCompleteness;
} {
  const record = reportRecord(report);
  const completeness = record?.equityAnalysisCompleteness;
  const rawDimensions = isRecord(completeness) ? completeness.dimensions : undefined;
  if (
    !isRecord(completeness) ||
    completeness.version !== 1 ||
    (completeness.financialCoreStatus !== "complete" &&
      completeness.financialCoreStatus !== "partial" &&
      completeness.financialCoreStatus !== "blocked") ||
    (completeness.coverageLevel !== "comprehensive" &&
      completeness.coverageLevel !== "substantial" &&
      completeness.coverageLevel !== "limited") ||
    typeof completeness.asOf !== "string" ||
    !isRecord(rawDimensions)
  ) {
    return {};
  }
  const dimensions = COMPLETENESS_DIMENSION_LABELS.flatMap(
    ({ key, label }): readonly EquityReaderCompletenessDimension[] => {
      const dimension = rawDimensions[key];
      if (
        !isRecord(dimension) ||
        !isDimensionStatus(dimension.status) ||
        typeof dimension.asOf !== "string"
      ) {
        return [];
      }
      const reasonCodes = stringArrayValue(dimension.reasonCodes);
      const sourceIds = stringArrayValue(dimension.sourceIds);
      return [
        {
          key,
          label,
          status: dimension.status,
          reasonCodes,
          asOf: dimension.asOf,
          sourceIds,
        },
      ];
    },
  );
  if (dimensions.length !== COMPLETENESS_DIMENSION_LABELS.length) {
    return {};
  }
  return {
    financialCoreStatus: completeness.financialCoreStatus,
    appendix: {
      coverageLevel: completeness.coverageLevel,
      asOf: completeness.asOf,
      dimensions,
    },
  };
}

export function projectEquityReader(input: EquityReaderProjectionInput): EquityReaderProjection {
  const record = reportRecord(input.report);
  const generatedAt = typeof record?.generatedAt === "string" ? record.generatedAt : undefined;
  const gaps = projectedGaps(input.report, input.fundamentalHistory, input.sourceGaps ?? []);
  const projectedFinancialTrends = financialTrends(input.fundamentalHistory);
  const projectedBalanceSheet = balanceSheetHistory(input.financialStatements, generatedAt);
  const completeness = completenessProjection(input.report);
  return {
    defaultView: {
      ...(completeness.financialCoreStatus === undefined
        ? {}
        : { financialCoreStatus: completeness.financialCoreStatus }),
      ...(projectedFinancialTrends === undefined
        ? {}
        : { financialTrends: projectedFinancialTrends }),
      valuationContext: valuationContext(
        input.marketSnapshot,
        input.valuationWorkbench,
        input.peerImpliedRange,
      ),
      earningsConsensus: earningsConsensus(input.report),
      materialGaps: gaps.material,
    },
    appendix: {
      ...(completeness.appendix === undefined ? {} : { completeness: completeness.appendix }),
      ...(projectedBalanceSheet === undefined
        ? {}
        : { balanceSheetHistory: projectedBalanceSheet }),
      analystEstimateDistributions: analystEstimateDistributions(input.report),
      diagnosticGaps: gaps.diagnostic,
      predictionShortfalls: gaps.predictionShortfalls,
    },
  };
}

function hasPlainLanguageDescription(text: string): boolean {
  const outsideParentheses = text.replaceAll(/\([^()]*\)/gu, " ");
  const descriptiveWords = (outsideParentheses.match(/[A-Za-z][A-Za-z'-]*/gu) ?? []).filter(
    (word) =>
      !["business", "criteria", "supported", "mixed", "not", "insufficient", "data"].includes(
        word.toLowerCase(),
      ),
  );
  return descriptiveWords.length >= 2;
}

function knownSourceIds(report: CompanyDescriptionReport, sourceIds: unknown): readonly string[] {
  if (!Array.isArray(sourceIds)) {
    return [];
  }
  const known = new Set(
    Array.isArray(report.sources)
      ? report.sources.flatMap((source) =>
          isRecord(source) && typeof source.id === "string" ? [source.id] : [],
        )
      : [],
  );
  return sourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string" && known.has(sourceId),
  );
}

export function companyDescription(report: CompanyDescriptionReport): CompanyDescription {
  const extras = isRecord(report.extras) ? report.extras : undefined;
  const profile = isRecord(extras?.webSubjectProfile) ? extras.webSubjectProfile : undefined;
  if (profile !== undefined) {
    const candidates = [
      profile.subjectSummary,
      isRecord(profile.questions) ? profile.questions.whatItDoes : undefined,
    ];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.answer !== "string" || candidate.answer === "") {
        continue;
      }
      return {
        text: candidate.answer,
        sourceIds: knownSourceIds(report, candidate.sourceIds),
      };
    }
  }

  const framework = isRecord(extras?.businessFramework) ? extras.businessFramework : undefined;
  if (framework !== undefined && Array.isArray(framework.sections)) {
    const business = framework.sections.find(
      (section) => isRecord(section) && section.name === "Business",
    );
    if (isRecord(business)) {
      let rawText = "";
      if (typeof business.text === "string") {
        rawText = business.text;
      } else if (typeof business.summary === "string") {
        rawText = business.summary;
      }
      const posture = typeof business.posture === "string" ? business.posture : "";
      const prefix = `Business ${posture}`;
      const plainText = (
        rawText.startsWith(prefix) ? rawText.slice(prefix.length) : rawText
      ).trim();
      if (plainText !== "" && hasPlainLanguageDescription(rawText)) {
        return {
          text: plainText,
          sourceIds: knownSourceIds(report, business.sourceIds),
        };
      }
    }
  }

  return { text: NO_COMPANY_DESCRIPTION, sourceIds: [] };
}
