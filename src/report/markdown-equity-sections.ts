import {
  resolveMarketSnapshotPriceAsOf,
  type EquityAnalysisDimensionStatus,
  type ExtendedEvidenceItem,
  type MarketSnapshot,
  type ResearchReport,
} from "../domain/types";
import { readNumber } from "../guards";
import type { CollectedSources } from "../sources/types";
import {
  projectEquityReader,
  type EquityReaderAppendixCompleteness,
  type EquityReaderCompanyDescription,
  type EquityReaderConsensusItem,
  type EquityReaderMarketMultiple,
  type EquityReaderValuationContext,
} from "./equity-reader";
import type { EquityReaderBalanceSheetHistory } from "./equity-reader-statements";
import { compactNumber, type EquityReaderFinancialTrends } from "./equity-reader-trends";
import { formatTrendAmount, knownSourceIds, markdownText, sourceRefs } from "./markdown-primitives";

function completenessStatusChip(status: EquityAnalysisDimensionStatus): string {
  if (status === "not-assessed") {
    return "`not assessed — inputs unavailable`";
  }
  return `\`${status.replaceAll("-", " ")}\``;
}

export function renderEquityCompletenessChips(report: ResearchReport): readonly string[] {
  const completeness = report.equityAnalysisCompleteness;
  if (completeness === undefined) {
    return [];
  }
  return [
    `Analysis Completeness: financial core ${completenessStatusChip(completeness.financialCoreStatus)}`,
  ];
}

export function renderCompletenessAppendix(
  completeness: EquityReaderAppendixCompleteness | undefined,
): string {
  if (completeness === undefined) {
    return "";
  }
  const dimensions = completeness.dimensions
    .map((dimension) => `${dimension.label} ${completenessStatusChip(dimension.status)}`)
    .join(" · ");
  return [
    "## Analysis Completeness",
    "",
    `Coverage: \`${completeness.coverageLevel}\``,
    `Dimension Status: ${dimensions}`,
    "",
  ].join("\n");
}

export function renderPriceProvenance(
  summary: string,
  sourceIds: readonly string[],
  marketSnapshot: MarketSnapshot | undefined,
): string {
  if (marketSnapshot === undefined || !sourceIds.includes(marketSnapshot.sourceId)) {
    return summary;
  }
  const priceAsOf = resolveMarketSnapshotPriceAsOf(marketSnapshot);
  const label = `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
  const fetchDate = marketSnapshot.observedAt.slice(0, 10);
  return summary
    .replaceAll(`market cap as of ${fetchDate}`, `market cap ${label}`)
    .replaceAll(`market cap (quote ${fetchDate})`, `market cap (${label})`);
}

export function renderCompanyDescription(description: EquityReaderCompanyDescription): string {
  const refs = sourceRefs(description.sourceIds);
  return `## What the Company Does\n\n${description.status === "unavailable" ? "- " : ""}${markdownText(description.text)}${refs === "" ? "" : ` ${refs}`}\n`;
}

function quoteCurrency(snapshot: MarketSnapshot): string {
  return snapshot.identity?.quoteCurrency ?? "";
}

export function renderPriceAndMarketDate(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
): string {
  if (marketSnapshot === undefined) {
    return "## Price and Market Date\n\n- No current normalized price is available.\n";
  }
  const currency = quoteCurrency(marketSnapshot);
  const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
    marketSnapshot.price,
  );
  const priceAsOf = resolveMarketSnapshotPriceAsOf(marketSnapshot);
  const label = `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
  const summary = `Observed price: ${price}${currency === "" ? "" : ` ${currency}`}; price as of ${label}.`;
  const refs = sourceRefs(knownSourceIds(report, [marketSnapshot.sourceId]));
  return `## Price and Market Date\n\n${summary}${refs === "" ? "" : ` ${refs}`}\n`;
}

export function renderFinancialTrends(
  report: ResearchReport,
  sources: Pick<CollectedSources, "fundamentalHistory"> | undefined,
): string {
  const projection = projectEquityReader({
    report,
    ...(sources?.fundamentalHistory === undefined
      ? {}
      : { fundamentalHistory: sources.fundamentalHistory }),
  });
  return renderProjectedFinancialTrends(report, projection.defaultView.financialTrends);
}

export function renderProjectedFinancialTrends(
  report: ResearchReport,
  trends: EquityReaderFinancialTrends | undefined,
): string {
  if (trends === undefined) {
    return "## Financial Trends\n\n- Three-to-five-year and TTM history is unavailable.\n";
  }
  const rows = trends.rows.map((row) =>
    [row.period, row.revenue, row.netIncome, row.operatingMargin, row.freeCashFlow].join(" | "),
  );
  const refs = sourceRefs(knownSourceIds(report, trends.sourceIds));
  return [
    "## Financial Trends",
    "",
    `Amounts${trends.reportingCurrency === undefined ? "" : ` in ${markdownText(trends.reportingCurrency)}`}. FCF, where applicable, is the reported operating-cash-flow less capex proxy.${refs === "" ? "" : ` ${refs}`}`,
    "",
    "Period | Revenue | Net income | Operating margin | FCF",
    "--- | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

export function renderBalanceSheetAndShareCount(
  report: ResearchReport,
  history: EquityReaderBalanceSheetHistory | undefined,
): string {
  if (history === undefined) {
    return "### Balance Sheet and Share Count\n\n- Balance-sheet and diluted-share history is unavailable.\n";
  }
  const rows = history.rows.map((row) =>
    [
      row.period,
      formatTrendAmount(row.cash?.value),
      formatTrendAmount(row.debt?.value),
      formatTrendAmount(row.dilutedShares?.value),
    ].join(" | "),
  );
  const refs = sourceRefs(knownSourceIds(report, history.sourceIds));
  return [
    "### Balance Sheet and Share Count",
    "",
    `Cash and debt amounts${history.reportingCurrency === undefined ? "" : ` in ${markdownText(history.reportingCurrency)}`}; diluted shares are weighted-average shares.${refs === "" ? "" : ` ${refs}`}`,
    "",
    "Period | Cash | Debt | Diluted shares",
    "--- | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

export function renderValuationContext(
  report: ResearchReport,
  valuation: EquityReaderValuationContext,
): string {
  if (valuation.kind === "peer-range" && valuation.status === "derived") {
    const { range, priceAsOf } = valuation;
    let position = "above";
    if (range.position === "within-range") {
      position = "within";
    } else if (range.position === "below-range") {
      position = "below";
    }
    const date =
      priceAsOf === undefined
        ? undefined
        : `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
    const refs = sourceRefs(knownSourceIds(report, valuation.sourceIds));
    const compactMetrics = renderCompactValuationMetrics(report);
    return [
      "## Valuation Context",
      "",
      `The observed quote is ${position} the peer-implied price reference range of ${range.low.toFixed(2)}–${range.high.toFixed(2)} ${range.inputs.quoteCurrency}${date === undefined ? "" : ` as of ${date}`}; this is valuation context, not a target price.${refs === "" ? "" : ` ${refs}`}`,
      ...(compactMetrics.length === 0 ? [] : ["", ...compactMetrics]),
      "",
    ].join("\n");
  }
  let metrics: readonly EquityReaderMarketMultiple[] = [];
  let sourceIds: readonly string[] = [];
  if (valuation.kind === "market-multiples") {
    ({ metrics, sourceIds } = valuation);
  } else if (valuation.kind === "peer-range") {
    ({ fallbackMetrics: metrics, fallbackSourceIds: sourceIds } = valuation);
  }
  const renderedMetrics = metrics.map((metric) => {
    let label = "price/book";
    if (metric.key === "trailingPE") {
      label = "trailing P/E";
    } else if (metric.key === "forwardPE") {
      label = "forward P/E";
    }
    return `${label} ${metric.value.toFixed(2)}x`;
  });
  const refs = sourceRefs(knownSourceIds(report, sourceIds));
  const includePriceToBook = !metrics.some((metric) => metric.key === "priceToBook");
  const compactMetrics = renderCompactValuationMetrics(report, includePriceToBook);
  const compactPriceToBookAvailable =
    includePriceToBook &&
    firstEvidenceMetric(
      (report.extendedEvidence?.items ?? []).filter(
        (item) => item.category === "yahoo-fundamentals",
      ),
      "priceToBook",
    ) !== undefined;
  let context = `Observed market multiples are ${renderedMetrics.join(", ")}`;
  if (renderedMetrics.length === 0) {
    context = compactPriceToBookAvailable
      ? "No peer-derived reference range is available"
      : "No peer-derived reference range or normalized market multiple is available";
  }
  return [
    "## Valuation Context",
    "",
    `${context}; this is valuation context, not a target price.${refs === "" ? "" : ` ${refs}`}`,
    ...(compactMetrics.length === 0 ? [] : ["", ...compactMetrics]),
    "",
  ].join("\n");
}

function renderConsensusItem(report: ResearchReport, item: EquityReaderConsensusItem): string {
  const refs = sourceRefs(knownSourceIds(report, item.sourceIds));
  const citation = refs === "" ? "" : ` ${refs}`;
  if (item.kind === "earnings-date") {
    return `- **Upcoming earnings:** ${markdownText(item.symbol)} on ${item.date} (${item.timing}; ${item.status})${citation}`;
  }
  if (item.kind === "eps-consensus") {
    return `- **EPS consensus:** ${String(item.value)} (single-provider snapshot)${citation}`;
  }
  if (item.kind === "revenue-consensus") {
    return `- **Revenue consensus:** ${compactNumber(item.value)} (single-provider snapshot)${citation}`;
  }
  return `- **${markdownText(item.title)}:** mean ${compactNumber(item.mean)}${item.period === undefined ? "" : ` for ${item.period}`}${item.count === undefined ? "" : ` (${String(item.count)} estimates)`}${citation}`;
}

export function renderCompactEarningsAndConsensus(
  report: ResearchReport,
  items: readonly EquityReaderConsensusItem[],
): string {
  const rows = items.map((item) => renderConsensusItem(report, item));
  return [
    "## Upcoming Earnings and Consensus",
    "",
    ...(rows.length === 0 ? ["- No upcoming earnings or consensus snapshot is available."] : rows),
    "",
  ].join("\n");
}

function firstEvidenceMetric(
  items: readonly ExtendedEvidenceItem[],
  key: string,
): { readonly item: ExtendedEvidenceItem; readonly value: number } | undefined {
  for (const item of items) {
    const value = readNumber(item.metrics ?? {}, key);
    if (value !== undefined) {
      return { item, value };
    }
  }
  return undefined;
}

function renderCompactValuationMetrics(
  report: ResearchReport,
  includePriceToBook = true,
): readonly string[] {
  if (report.jobType !== "equity" || report.assetClass !== "equity") {
    return [];
  }
  const items = report.extendedEvidence?.items ?? [];
  const options = items.filter((item) => item.category === "options-iv");
  const plainIv = firstEvidenceMetric(options, "medianIv");
  const ivBuckets = [
    ["medianIv30Dte", "30-day"],
    ["medianIv7Dte", "7-day"],
    ["medianIv60Dte", "60-day"],
    ["medianIv90Dte", "90-day"],
  ] as const;
  const [bucketedIv] = ivBuckets.flatMap(([key, tenor]) => {
    const match = firstEvidenceMetric(options, key);
    return match === undefined ? [] : [{ ...match, tenor }];
  });
  const iv = plainIv ?? bucketedIv;
  const fundamentals = items.filter((item) => item.category === "yahoo-fundamentals");
  const priceToBook = firstEvidenceMetric(fundamentals, "priceToBook");
  const epsTtm = firstEvidenceMetric(fundamentals, "epsTrailingTwelveMonths");
  const values = [
    ...(iv === undefined
      ? []
      : [
          `${"tenor" in iv ? `${iv.tenor} ` : "near-term "}options implied volatility ${iv.value.toFixed(3)}`,
        ]),
    ...(!includePriceToBook || priceToBook === undefined
      ? []
      : [`price/book ${priceToBook.value.toFixed(2)}x`]),
    ...(epsTtm === undefined ? [] : [`EPS TTM ${epsTtm.value.toFixed(2)}`]),
  ];
  if (values.length === 0) {
    return [];
  }
  const sourceIds = [
    ...(iv?.item.sourceIds ?? []),
    ...(includePriceToBook ? (priceToBook?.item.sourceIds ?? []) : []),
    ...(epsTtm?.item.sourceIds ?? []),
  ];
  const refs = sourceRefs(knownSourceIds(report, [...new Set(sourceIds)]));
  return [`- **Observed metrics:** ${values.join(", ")}${refs === "" ? "" : ` ${refs}`}`];
}
