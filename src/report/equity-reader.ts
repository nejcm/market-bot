import { isRecord } from "../guards";
import { readEquityAnalysisCompleteness } from "../domain/equity-analysis-completeness";
import type {
  EquityAnalysisDimensionStatus,
  MarketSnapshot,
  MarketSnapshotPriceAsOf,
  SourceGap,
} from "../domain/types";
import type { FinancialStatementsArtifact } from "../sources/extended-evidence/financial-statements-contract";
import type { FundamentalHistoryArtifact } from "../sources/extended-evidence/fundamental-history";
import { depositoryIssuerSic } from "../sources/extended-evidence/industry-classification";
import type { PeerImpliedRange } from "../sources/extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "../sources/extended-evidence/valuation-workbench-contract";
import {
  balanceSheetHistory,
  financialPosition,
  type EquityReaderBalanceSheetHistory,
  type EquityReaderFinancialPosition,
} from "./equity-reader-statements";
import {
  financialTrendGaps,
  financialTrends,
  type EquityReaderFinancialTrends,
} from "./equity-reader-trends";
import { readGapTriage } from "./gap-triage";
import {
  normalizePredictionShortfall,
  predictionShortfallMaterialGap,
} from "./prediction-shortfall";

export interface EquityReaderMarketMultiple {
  readonly key: "trailingPE" | "forwardPE" | "priceToBook";
  readonly value: number;
}

export type EquityReaderCompanyDescription =
  | {
      readonly status: "available";
      readonly text: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly text: "No cited plain-language company description is available.";
      readonly sourceIds: readonly [];
    };

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
    readonly companyDescription: EquityReaderCompanyDescription;
    readonly financialCoreStatus?: EquityReaderFinancialCoreStatus;
    readonly financialTrends?: EquityReaderFinancialTrends;
    readonly financialPosition?: EquityReaderFinancialPosition;
    readonly valuationContext: EquityReaderValuationContext;
    readonly earningsConsensus: readonly EquityReaderConsensusItem[];
    readonly materialGaps: readonly string[];
  };
  readonly appendix: {
    readonly completeness?: EquityReaderAppendixCompleteness;
    readonly balanceSheetHistory?: EquityReaderBalanceSheetHistory;
    readonly analystEstimateDistributions: readonly EquityReaderAnalystEstimateDistribution[];
    readonly diagnosticGaps: readonly string[];
  };
}

const COMPLETENESS_DIMENSION_LABELS: readonly {
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

const NO_COMPANY_DESCRIPTION = "No cited plain-language company description is available.";

function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
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
} {
  const record = reportRecord(report);
  const reportGaps = Array.isArray(record?.dataGaps)
    ? record.dataGaps.filter((gap): gap is string => typeof gap === "string")
    : [];
  const normalizedShortfall = normalizePredictionShortfall(record?.predictionShortfall, reportGaps);
  const gaps = [
    ...new Set([
      ...normalizedShortfall.dataGaps,
      ...(history === undefined ? [] : financialTrendGaps(history)),
    ]),
  ];
  const reportSymbol = typeof record?.symbol === "string" ? record.symbol : undefined;
  const material: string[] = [];
  const diagnostic: string[] = [];
  for (const gap of gaps) {
    if (readGapTriage(gap, sourceGaps, reportSymbol) === "diagnostic") {
      diagnostic.push(gap);
    } else {
      material.push(gap);
    }
  }
  if (normalizedShortfall.predictionShortfall !== undefined) {
    material.push(predictionShortfallMaterialGap(normalizedShortfall.predictionShortfall));
  }
  return { material, diagnostic };
}

function completenessProjection(report: unknown): {
  readonly financialCoreStatus?: EquityReaderFinancialCoreStatus;
  readonly appendix?: EquityReaderAppendixCompleteness;
} {
  const record = reportRecord(report);
  const completeness = readEquityAnalysisCompleteness(record?.equityAnalysisCompleteness);
  if (completeness === undefined) {
    return {};
  }
  const dimensions = COMPLETENESS_DIMENSION_LABELS.map(({ key, label }) => {
    const dimension = completeness.dimensions[key];
    return {
      key,
      label,
      status: dimension.status,
      reasonCodes: dimension.reasonCodes,
      asOf: dimension.asOf,
      sourceIds: dimension.sourceIds,
    };
  });
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
  const projectedFinancialTrends = financialTrends(
    input.fundamentalHistory,
    depositoryIssuerSic(record?.extendedEvidence) !== undefined,
  );
  const projectedFinancialPosition = financialPosition(input.financialStatements, generatedAt);
  const projectedBalanceSheet = balanceSheetHistory(input.financialStatements, generatedAt);
  const completeness = completenessProjection(input.report);
  return {
    defaultView: {
      companyDescription: companyDescription(record ?? {}),
      ...(completeness.financialCoreStatus === undefined
        ? {}
        : { financialCoreStatus: completeness.financialCoreStatus }),
      ...(projectedFinancialTrends === undefined
        ? {}
        : { financialTrends: projectedFinancialTrends }),
      ...(projectedFinancialPosition === undefined
        ? {}
        : { financialPosition: projectedFinancialPosition }),
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

function companyDescription(report: CompanyDescriptionReport): EquityReaderCompanyDescription {
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
        status: "available",
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
          status: "available",
          text: plainText,
          sourceIds: knownSourceIds(report, business.sourceIds),
        };
      }
    }
  }

  return { status: "unavailable", text: NO_COMPANY_DESCRIPTION, sourceIds: [] };
}
