import {
  isInstrumentJobType,
  resolveMarketSnapshotPriceAsOf,
  researchReportEvidenceQuality,
  type EquityAnalysisDimensionStatus,
  type ExtendedEvidenceItem,
  type KeyFinding,
  type MarketSnapshot,
  type Prediction,
  type ResearchReport,
  type Scenario,
  type SourceGap,
} from "../domain/types";
import { renderClaimForMeasurableAs } from "../forecast/observable";
import { RESEARCH_ONLY_NOTE } from "./schema";
import {
  readAlphaSearchLeadDisplayLimit,
  readAlphaSearchLeads,
  readAlphaSearchProfileCoverage,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";
import { isRecord, readNumber } from "../guards";
import { readGapTriage, type GapTriage } from "./gap-triage";
import {
  readBusinessFrameworkExtra,
  readWebSubjectProfileExtra,
  webSubjectProfileQuestionKeys,
  type WebSubjectProfileAnswerValue,
  type WebSubjectProfileExtraValue,
  type WebSubjectProfileFactValue,
} from "./report-extras-contract";
import type { WebSubjectProfileQuestionKey } from "../web-evidence/contract";
import { predictionShortfallMaterialGaps } from "./prediction-shortfall";
import type { CollectedSources } from "../sources/types";
import { renderEquityMarkdownReport, type MarkdownCollectedSources } from "./equity-markdown";
import {
  compactNumber,
  projectEquityReader,
  type EquityReaderAnalystEstimateDistribution,
  type EquityReaderAppendixCompleteness,
  type EquityReaderBalanceSheetHistory,
  type EquityReaderCompanyDescription,
  type EquityReaderConsensusItem,
  type EquityReaderFinancialTrends,
  type EquityReaderMarketMultiple,
  type EquityReaderValuationContext,
} from "./equity-reader";

const RESEARCH_ONLY_ALPHA_SEARCH_NOTE =
  "Research-only note: This alpha-search report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes.";

function sourceRefs(sourceIds: readonly string[]): string {
  return sourceIds.map((sourceId) => `[${markdownText(sourceId)}]`).join(" ");
}

function markdownText(value: string): string {
  return value.replaceAll(/[\\[\]()*_#|<>]/gu, (char) => {
    if (char === "<") {
      return "&lt;";
    }
    if (char === ">") {
      return "&gt;";
    }
    return `${String.fromCodePoint(92)}${char}`;
  });
}

function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function renderGap(
  gap: string,
  reportSymbol?: string,
  placement?: GapTriage,
  sourceGaps: readonly SourceGap[] = [],
): string {
  const triage = placement ?? readGapTriage(gap, sourceGaps, reportSymbol);
  return `- **${triage === "material" ? "Material" : "Diagnostic"}:** ${markdownText(gap)}`;
}

function completenessStatusChip(status: EquityAnalysisDimensionStatus): string {
  if (status === "not-assessed") {
    return "`not assessed — inputs unavailable`";
  }
  return `\`${status.replaceAll("-", " ")}\``;
}

function renderEquityCompletenessChips(report: ResearchReport): readonly string[] {
  const completeness = report.equityAnalysisCompleteness;
  if (completeness === undefined) {
    return [];
  }
  return [
    `Analysis Completeness: financial core ${completenessStatusChip(completeness.financialCoreStatus)}`,
  ];
}

function renderCompletenessAppendix(
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

// Diverges from guards.readStringArray (record+key, undefined on miss) and
// Guards.stringArrayValue (filters mixed arrays): all-or-nothing over a raw value.
function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function knownSourceIds(report: ResearchReport, sourceIds: unknown): readonly string[] {
  const known = new Set(report.sources.map((source) => source.id));
  return readStringArray(sourceIds).filter((sourceId) => known.has(sourceId));
}

// Render policy. The extras readers keep the per-item valid entries of a mixed
// Array because the Research Console renders them, but markdown has always
// Treated any non-string member as making the whole array unusable.
function citedSourceIds(
  report: ResearchReport,
  row: { readonly sourceIds: readonly string[]; readonly sourceIdsComplete: boolean },
): readonly string[] {
  return row.sourceIdsComplete ? knownSourceIds(report, row.sourceIds) : [];
}

function collectReportSourceIds(
  report: ResearchReport,
  additionalSourceIds: readonly string[] = [],
): ReadonlySet<string> {
  const ids = new Set<string>();
  const add = (sourceIds: readonly string[]) => {
    for (const sourceId of sourceIds) {
      ids.add(sourceId);
    }
  };
  [report.keyFindings, report.bullCase, report.bearCase, report.risks, report.catalysts].forEach(
    (items) => items.forEach((item) => add(item.sourceIds)),
  );
  report.scenarios.forEach((scenario) => add(scenario.sourceIds));
  report.predictions.forEach((prediction) => add(prediction.sourceIds));
  report.extendedEvidence?.items.forEach((item) => add(item.sourceIds));
  readAlphaSearchLeads(report.extras).forEach((lead) => add(lead.sourceIds));
  readAlphaSearchRejectedCandidates(report.extras).forEach((candidate) => add(candidate.sourceIds));

  const historical = report.extras?.historicalContext;
  if (isRecord(historical)) {
    add(knownSourceIds(report, historical.sourceIds));
    if (Array.isArray(historical.items)) {
      historical.items.forEach((item) => {
        if (isRecord(item)) {
          add(knownSourceIds(report, item.sourceIds));
        }
      });
    }
  }
  const spotlights = report.extras?.spotlights;
  if (isRecord(spotlights) && Array.isArray(spotlights.items)) {
    spotlights.items.forEach((item) => {
      if (isRecord(item)) {
        add(knownSourceIds(report, item.sourceIds));
      }
    });
  }
  // Same typed values the renderers below use — one traversal contract, so a new
  // Field cannot appear in one place and silently lose its citations in the other.
  const framework = readBusinessFrameworkExtra(report.extras?.businessFramework);
  if (framework !== undefined) {
    add(citedSourceIds(report, framework));
    (framework.sections ?? []).forEach((section) => add(citedSourceIds(report, section)));
  }
  const profile = readWebSubjectProfileExtra(report.extras?.webSubjectProfile);
  if (profile !== undefined) {
    add(citedSourceIds(report, profile));
    // Every parsed row is cited, including one whose text is blank or missing —
    // Suppressing it is the renderer's decision, not this traversal's.
    Object.values(profile.questions ?? {}).forEach((question) =>
      add(citedSourceIds(report, question)),
    );
    [...profile.recentMaterialEvents, ...profile.factLedger].forEach((fact) =>
      add(citedSourceIds(report, fact)),
    );
  }
  add(knownSourceIds(report, additionalSourceIds));

  return ids;
}

function sourceInventoryLine(
  report: ResearchReport,
  uncitedCount: number,
  citedIds: ReadonlySet<string>,
): string {
  const counts = new Map<string, number>();
  report.sources
    .filter((source) => !citedIds.has(source.id))
    .forEach((source) => {
      const key = `${source.provider ?? "unknown"}/${source.kind}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  const inventory = [...counts.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${markdownText(key)}:${String(count)}`)
    .join(", ");
  return `- ${String(uncitedCount)} uncited normalized source(s) omitted from markdown (${inventory}). Full source arrays remain in report.json and console files.`;
}

function renderSources(
  report: ResearchReport,
  additionalSourceIds: readonly string[] = [],
): string {
  if (report.sources.length === 0) {
    return "- No sources.";
  }

  const citedIds = collectReportSourceIds(report, additionalSourceIds);
  const citedSources = report.sources.filter((source) => citedIds.has(source.id));
  const uncitedCount = report.sources.length - citedSources.length;
  const rows = citedSources.map(
    (source) => `- [${markdownText(source.id)}] ${markdownText(source.title)}`,
  );
  if (uncitedCount > 0) {
    rows.push(sourceInventoryLine(report, uncitedCount, citedIds));
  }
  return rows.length === 0 ? sourceInventoryLine(report, uncitedCount, citedIds) : rows.join("\n");
}

function renderFindings(title: string, findings: readonly KeyFinding[]): string {
  if (findings.length === 0) {
    return `## ${title}\n\n- No sourced items.\n`;
  }

  return `## ${title}\n\n${findings.map((finding) => `- ${finding.text} ${sourceRefs(finding.sourceIds)}`).join("\n")}\n`;
}

function renderScenarios(scenarios: readonly Scenario[]): string {
  if (scenarios.length === 0) {
    return "## Scenarios\n\n- No sourced scenarios.\n";
  }

  return `## Scenarios\n\n${scenarios.map((scenario) => `- **${scenario.name}:** ${scenario.description} ${sourceRefs(scenario.sourceIds)}`).join("\n")}\n`;
}

function renderPredictions(predictions: readonly Prediction[]): string {
  if (predictions.length === 0) {
    return "";
  }

  const rows = predictions
    .map((pred) => {
      const pct = `${String(Math.round(pred.probability * 100))}%`;
      const refs = pred.sourceIds.length > 0 ? ` ${sourceRefs(pred.sourceIds)}` : "";
      const claim = renderClaimForMeasurableAs(pred.measurableAs, pred.claim) ?? pred.claim;
      return `- [${pct}] (${pred.horizonTradingDays}d) ${claim}${refs}`;
    })
    .join("\n");

  return `## Predictions\n\n${rows}\n`;
}

function renderPriceProvenance(
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

function renderCompanyDescription(description: EquityReaderCompanyDescription): string {
  const refs = sourceRefs(description.sourceIds);
  return `## What the Company Does\n\n${description.status === "unavailable" ? "- " : ""}${markdownText(description.text)}${refs === "" ? "" : ` ${refs}`}\n`;
}

function quoteCurrency(snapshot: MarketSnapshot): string {
  return snapshot.identity?.quoteCurrency ?? "";
}

function renderPriceAndMarketDate(
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

function renderProjectedFinancialTrends(
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
    `Amounts${trends.reportingCurrency === undefined ? "" : ` in ${markdownText(trends.reportingCurrency)}`}. FCF is the reported operating-cash-flow less capex proxy.${refs === "" ? "" : ` ${refs}`}`,
    "",
    "Period | Revenue | Net income | Operating margin | FCF",
    "--- | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

function renderBalanceSheetAndShareCount(
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

function renderValuationContext(
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

function renderCompactEarningsAndConsensus(
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

function renderGapSection(
  title: string,
  gaps: readonly string[],
  emptyMessage: string,
  reportSymbol?: string,
  placement?: GapTriage,
): string {
  const rows =
    gaps.length === 0
      ? `- ${emptyMessage}`
      : gaps.map((gap) => renderGap(gap, reportSymbol, placement)).join("\n");
  return `## ${title}\n\n${rows}\n`;
}

function renderAppendixSection(markdown: string): string {
  return markdown.replaceAll(/^(#{2,5})(?= )/gmu, "#$1");
}

function renderDiagnosticGapSummary(count: number, disclosedGaps: readonly string[]): string {
  const noun = count === 1 ? "gap" : "gaps";
  const disclosures = disclosedGaps.map((gap) => renderGap(gap, undefined, "diagnostic"));
  const pointer =
    count > disclosedGaps.length
      ? [
          `- ${String(count)} diagnostic data ${noun}; see the Research Console Advanced view or report.json for details.`,
        ]
      : [];
  return `## Diagnostic Data Gaps\n\n${[...disclosures, ...pointer].join("\n")}\n`;
}

function renderExtendedEvidence(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  if (report.extendedEvidence === undefined) {
    return "";
  }
  const { items } = report.extendedEvidence;
  if (items.length === 0) {
    return "## Extended Evidence\n\n- No extended evidence items.\n";
  }
  const rows = items
    .map((item) => {
      const refs = sourceRefs(item.sourceIds);
      const summary = renderPriceProvenance(item.summary, item.sourceIds, marketSnapshot);
      return `- **${markdownText(item.title)}:** ${markdownText(summary)}${refs === "" ? "" : ` ${refs}`}`;
    })
    .join("\n");
  return `${renderAnalystAndOwnershipContext(report)}## Extended Evidence\n\n${rows}\n`;
}

function renderAnalystAndOwnershipContext(report: ResearchReport): string {
  return `${renderAnalystEstimateContext(report)}${renderInstitutionalOwnershipContext(report)}`;
}

function formatDistributionValue(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function renderAnalystEstimateDistributions(
  report: ResearchReport,
  distributions: readonly EquityReaderAnalystEstimateDistribution[],
): string {
  if (distributions.length === 0) {
    return "";
  }
  const rows = distributions.flatMap((distribution) => {
    const refs = sourceRefs(knownSourceIds(report, distribution.sourceIds));
    return [
      `### ${markdownText(distribution.title)}${refs === "" ? "" : ` ${refs}`}`,
      "",
      ...(distribution.period === undefined
        ? []
        : [`Period: ${markdownText(distribution.period)}`, ""]),
      "Mean | Median | High | Low | Count",
      "---: | ---: | ---: | ---: | ---:",
      [
        formatDistributionValue(distribution.mean),
        formatDistributionValue(distribution.median),
        formatDistributionValue(distribution.high),
        formatDistributionValue(distribution.low),
        distribution.count === undefined ? "—" : String(distribution.count),
      ].join(" | "),
      "",
    ];
  });
  return ["## Analyst Estimate Distributions", "", ...rows].join("\n");
}

function renderAnalystEstimateContext(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const items =
    report.extendedEvidence?.items.filter((item) => item.category === "analyst-estimate-context") ??
    [];
  const rows = items.flatMap((item) => {
    const { metrics } = item;
    if (metrics === undefined) {
      return [];
    }
    const { mean, median, high, low, count } = metrics;
    const distribution = [
      ["Mean", mean],
      ["Median", median],
      ["High", high],
      ["Low", low],
      ["Count", count],
    ].flatMap(([label, value]) =>
      typeof value === "number" ? [`- **${String(label)}:** ${String(value)}`] : [],
    );
    if (distribution.length === 0) {
      return [];
    }
    const refs = sourceRefs(item.sourceIds);
    return [`${markdownText(item.summary)}${refs === "" ? "" : ` ${refs}`}`, ...distribution];
  });
  return rows.length === 0 ? "" : `## External Analyst Estimate Context\n\n${rows.join("\n")}\n`;
}

function renderInstitutionalOwnershipContext(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const items =
    report.extendedEvidence?.items.filter((item) => item.category === "institutional-ownership") ??
    [];
  const rows = items.flatMap((item) => {
    const { metrics } = item;
    if (metrics === undefined) {
      return [];
    }
    const values = [
      ["Institutional holders", metrics.holderCount],
      ["Reported shares", metrics.reportedShares],
      ["Reported ownership percent", metrics.reportedOwnershipPercent],
      ["Insider transactions", metrics.transactionCount],
      ["Purchases", metrics.purchaseCount],
      ["Sales", metrics.saleCount],
      ["Net share change", metrics.netShareChange],
    ].flatMap(([label, value]) =>
      typeof value === "number" ? [`- **${String(label)}:** ${String(value)}`] : [],
    );
    if (values.length === 0) {
      return [];
    }
    const refs = sourceRefs(item.sourceIds);
    return [`${markdownText(item.summary)}${refs === "" ? "" : ` ${refs}`}`, ...values];
  });
  return rows.length === 0 ? "" : `## External Ownership Context\n\n${rows.join("\n")}\n`;
}

function renderHistoricalContext(report: ResearchReport): string {
  const extra = report.extras?.historicalContext;
  if (!isRecord(extra)) {
    return "";
  }
  const lines: string[] = [];
  if (typeof extra.summary === "string" && extra.summary !== "") {
    const refs = sourceRefs(knownSourceIds(report, extra.sourceIds));
    lines.push(`${markdownText(extra.summary)}${refs === "" ? "" : ` ${refs}`}`);
  }
  if (Array.isArray(extra.items)) {
    for (const item of extra.items) {
      if (!isRecord(item) || typeof item.text !== "string") {
        continue;
      }
      const refs = sourceRefs(knownSourceIds(report, item.sourceIds));
      if (refs === "") {
        continue;
      }
      lines.push(`- ${markdownText(item.text)} ${refs}`);
    }
  }
  if (Array.isArray(extra.gaps)) {
    for (const gap of extra.gaps) {
      if (typeof gap === "string" && gap !== "") {
        lines.push(`- ${markdownText(gap)}`);
      }
    }
  }
  return lines.length === 0 ? "" : `## Historical Context\n\n${lines.join("\n")}\n`;
}

function renderSpotlights(report: ResearchReport): string {
  const extra = report.extras?.spotlights;
  if (!isRecord(extra) || !Array.isArray(extra.items)) {
    return "";
  }
  const allowedResearchSymbols =
    report.jobType === "research" &&
    isRecord(report.extras?.depthProfile) &&
    Array.isArray(report.extras.depthProfile.predictionSubjects)
      ? new Set(
          report.extras.depthProfile.predictionSubjects.flatMap((subject) =>
            typeof subject === "string" ? [subject.toUpperCase()] : [],
          ),
        )
      : undefined;
  const rows = extra.items.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { symbol, rationale: rawRationale, text, sourceIds } = item;
    if (typeof symbol !== "string") {
      return [];
    }
    let rationale = "";
    if (typeof rawRationale === "string") {
      rationale = rawRationale;
    } else if (typeof text === "string") {
      rationale = text;
    }
    const refs = sourceRefs(knownSourceIds(report, sourceIds));
    if (allowedResearchSymbols !== undefined && !allowedResearchSymbols.has(symbol.toUpperCase())) {
      return [];
    }
    if (rationale === "" || refs === "") {
      return [];
    }
    return [`- **${markdownText(symbol)}:** ${markdownText(rationale)} ${refs}`];
  });
  return rows.length === 0 ? "" : `## Market Spotlights\n\n${rows.join("\n")}\n`;
}

function deltaRegimeLine(delta: Record<string, unknown>): string {
  const current =
    typeof delta.currentRegime === "string" ? delta.currentRegime : "insufficient-data";
  const prior = typeof delta.priorRegime === "string" ? delta.priorRegime : undefined;
  if (delta.regimeChanged === true && prior !== undefined) {
    const flipped = readStringArray(delta.flippedDrivers);
    const suffix = flipped.length === 0 ? "" : ` (flipped drivers: ${flipped.join(", ")})`;
    return `Regime: ${markdownText(prior)} → ${markdownText(current)}${suffix}.`;
  }
  return `Regime: ${markdownText(current)} (unchanged since last run).`;
}

function deltaMoverLine(delta: Record<string, unknown>): string {
  const entered = readStringArray(delta.moversEntered).map((symbol) => markdownText(symbol));
  const exited = readStringArray(delta.moversExited).map((symbol) => markdownText(symbol));
  if (entered.length === 0 && exited.length === 0) {
    return "Ranked mover set unchanged since last run.";
  }
  return `Movers entered: ${entered.length === 0 ? "none" : entered.join(", ")}; exited: ${exited.length === 0 ? "none" : exited.join(", ")}.`;
}

function deltaResolvedLines(delta: Record<string, unknown>): readonly string[] {
  const resolved = Array.isArray(delta.resolvedSince) ? delta.resolvedSince : [];
  const rows = resolved.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const { claim, runId, outcome } = item;
    const probability = readNumber(item, "probability");
    if (
      typeof claim !== "string" ||
      typeof runId !== "string" ||
      (outcome !== "hit" && outcome !== "miss") ||
      probability === undefined
    ) {
      return [];
    }
    const pct = String(Math.round(probability * 100));
    return [`- [${outcome}] p=${pct}% ${markdownText(claim)} (run ${markdownText(runId)})`];
  });
  return rows.length === 0 ? [] : ["", "Predictions resolved since last run:", ...rows];
}

// Market Update Delta — deterministic "what changed since the last comparable run".
// Pure render of report.extras.marketUpdateDelta; market-update jobs only. Research-only.
function renderMarketUpdateDelta(report: ResearchReport): string {
  if (
    report.jobType !== "market-overview" &&
    report.jobType !== "daily" &&
    report.jobType !== "weekly"
  ) {
    return "";
  }
  const delta = report.extras?.marketUpdateDelta;
  if (!isRecord(delta)) {
    return "";
  }
  const bucket = reportMarketUpdateBucket(report);
  const heading = `## What Changed Since Last ${bucket} Market Overview`;
  if (delta.hasBaseline !== true) {
    return `${heading}\n\nNo prior comparable market-overview run to compare — this is the first.\n`;
  }
  const lines = [deltaRegimeLine(delta), deltaMoverLine(delta), ...deltaResolvedLines(delta)];
  return `${heading}\n\n${lines.join("\n")}\n`;
}

function reportMarketUpdateBucket(report: ResearchReport): string {
  if (typeof report.extras?.marketUpdateHorizonBucket === "string") {
    return report.extras.marketUpdateHorizonBucket;
  }
  return report.jobType === "weekly" ? "11-15d" : "2-5d";
}

function renderAlphaSearchCoverage(report: ResearchReport): string {
  const coverage = readAlphaSearchProfileCoverage(report.extras);
  if (coverage === undefined) {
    return "";
  }
  return [
    "## Profile Coverage",
    "",
    `Displayed leads: ${String(coverage.displayedLeadCount)}`,
    `Candidate profiles with fundamentals: ${String(coverage.candidateProfilesWithFundamentals)}`,
    `Fundamental gaps: ${String(coverage.fundamentalGapCount)}`,
    `Unmapped SEC filings: ${String(coverage.unmappedSecFilingCount)} pre-ticker filing(s) disclosed separately, not mapped-lead enrichment failures.`,
    "",
  ].join("\n");
}

function renderCatalystCalendar(report: ResearchReport): string {
  const calendar = report.extras?.catalystCalendar;
  if (!isRecord(calendar) || !Array.isArray(calendar.items) || calendar.items.length === 0) {
    return "";
  }
  const rows = calendar.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string") {
      return [];
    }
    const date = typeof item.date === "string" ? `${item.date}: ` : "";
    const status = typeof item.sourceStatus === "string" ? ` (${item.sourceStatus})` : "";
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
      : [];
    return [`- ${date}${markdownText(item.label)}${status}${sourceRefs(sourceIds)}`];
  });
  return rows.length === 0 ? "" : ["## Catalyst Calendar", "", ...rows, ""].join("\n");
}

function socialDriverText(lead: {
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly mentions?: number;
  readonly upvotes?: number;
  readonly mentionDelta24h?: number;
  readonly rankImprovement?: number;
  readonly upvotesPerMention?: number;
}): string {
  if (
    lead.socialRank === undefined ||
    lead.socialMomentumScore === undefined ||
    lead.mentions === undefined ||
    lead.upvotes === undefined
  ) {
    return "";
  }
  const drivers = [
    `rank ${String(lead.socialRank)}`,
    `score ${String(lead.socialMomentumScore)}`,
    `${String(lead.mentions)} mention(s)`,
    `${String(lead.upvotes)} upvote(s)`,
    ...(lead.mentionDelta24h !== undefined
      ? [`24h mention delta ${String(lead.mentionDelta24h)}`]
      : []),
    ...(lead.rankImprovement !== undefined
      ? [`rank improvement ${String(lead.rankImprovement)}`]
      : []),
    ...(lead.upvotesPerMention !== undefined
      ? [`upvotes/mention ${String(lead.upvotesPerMention)}`]
      : []),
  ];
  return `Social ${drivers.join(", ")}; `;
}

function renderAlphaSearchReport(report: ResearchReport): string {
  const materialGaps = predictionShortfallMaterialGaps(report.predictionShortfall, report.dataGaps);
  const gaps =
    materialGaps.length === 0
      ? "- No material gaps identified."
      : materialGaps.map((gap) => renderGap(gap)).join("\n");
  const sources = renderSources(report);
  const leads = readAlphaSearchLeads(report.extras);
  const rawLeadLimit = readAlphaSearchLeadDisplayLimit(report.extras);
  const leadLimit =
    rawLeadLimit !== undefined && Number.isInteger(rawLeadLimit) && rawLeadLimit >= 0
      ? rawLeadLimit
      : leads.length;
  const rejected = readAlphaSearchRejectedCandidates(report.extras);
  const coverage = renderAlphaSearchCoverage(report);
  const leadRows =
    leads.length === 0
      ? "- No Yahoo-validated research leads."
      : [
          ...leads.slice(0, leadLimit).map((lead) => {
            const name = lead.name === undefined ? "" : ` (${markdownText(lead.name)})`;
            const social = socialDriverText(lead);
            const sec =
              lead.recentSecFilings === undefined || lead.recentSecFilings.length === 0
                ? ""
                : `SEC filings ${lead.recentSecFilings.map((filing) => `${markdownText(filing.form)} ${markdownText(filing.filingDate)}`).join(", ")}; `;
            return `- **${markdownText(lead.symbol)}${name}:** Sources ${lead.discoverySources.map(markdownText).join(", ")}; ${social}${sec}Yahoo listed stock on ${markdownText(lead.exchange)}, $${String(lead.price)}, volume ${String(lead.volume)}, market cap ${String(lead.marketCap)}. ${sourceRefs(lead.sourceIds)}`;
          }),
          ...(leads.length > leadLimit
            ? [
                `- ...plus ${String(leads.length - leadLimit)} more evaluated lead(s) recorded in normalized/research-leads.json.`,
              ]
            : []),
        ].join("\n");
  const rejectedRows =
    rejected.length === 0
      ? "- No rejected candidates."
      : rejected
          .map(
            (candidate) =>
              `- **${markdownText(candidate.symbol)}:** Sources ${candidate.discoverySources.map(markdownText).join(", ")}${candidate.socialRank === undefined || candidate.socialMomentumScore === undefined ? "" : `; Social rank ${String(candidate.socialRank)}, score ${String(candidate.socialMomentumScore)}`}; ${markdownText(candidate.reason)}. ${sourceRefs(candidate.sourceIds)}`,
          )
          .join("\n");

  return [
    `# ${report.assetClass} Alpha Search Report`,
    "",
    RESEARCH_ONLY_ALPHA_SEARCH_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${researchReportEvidenceQuality(report)}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    "## Research Leads",
    "",
    leadRows,
    "",
    "## Rejected Candidates",
    "",
    rejectedRows,
    "",
    ...(coverage === "" ? [] : [coverage]),
    "## Data Gaps",
    "",
    gaps,
    "",
    "## Sources",
    "",
    sources,
    "",
  ].join("\n");
}

function renderBusinessFramework(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const framework = readBusinessFrameworkExtra(report.extras?.businessFramework);
  // A framework without a `sections` array has no section to render — distinct
  // From one whose sections parsed to none, which still gets the header.
  if (framework?.sections === undefined) {
    return "";
  }
  const rows = framework.sections.flatMap((section) => {
    const { name } = section;
    // A nameless section is unrenderable, but its sources are still cited by
    // CollectReportSourceIds — which is why the reader keeps the row.
    if (name === undefined) {
      return [];
    }
    // Render policy, not parsing: the equity reader already covers these three.
    if (
      report.jobType === "equity" &&
      report.assetClass === "equity" &&
      ["business", "phase", "growth"].includes(name.trim().toLowerCase())
    ) {
      return [];
    }
    const posture =
      name !== "Phase" && section.posture !== undefined
        ? ` (${markdownText(section.posture)})`
        : "";
    const text = section.text ?? section.summary ?? "";
    if (text === "") {
      return [];
    }
    const refs = sourceRefs(citedSourceIds(report, section));
    return [
      `- **${markdownText(name)}**${posture}: ${markdownText(text)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  // Render policy: gap codes are dropped, only the text is shown.
  const gaps = framework.gaps.map(
    (gap) => `- ${markdownText(typeof gap === "string" ? gap : gap.text)}`,
  );
  return [
    "## Business Framework",
    "",
    `Phase: ${markdownText(framework.phase ?? "insufficient-data")}`,
    "",
    ...rows,
    ...(gaps.length > 0 ? ["", "### Framework Data Gaps", "", ...gaps] : []),
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

// Title Case labels are markdown-specific; only the key order is shared, via
// The contract's webSubjectProfileQuestionKeys. Exhaustiveness is compiler-enforced.
const WEB_SUBJECT_PROFILE_LABELS: Readonly<Record<WebSubjectProfileQuestionKey, string>> = {
  whatItDoes: "What It Does",
  howItMakesMoney: "How It Makes Money",
  customers: "Customers",
  geography: "Geography",
  purchaseRecurrence: "Purchase Recurrence",
  pricingPower: "Pricing Power",
  recessionCyclicality: "Recession Cyclicality",
  managementTrackRecord: "Management Track Record",
  capitalAllocation: "Capital Allocation",
  companyKpis: "Company-specific KPIs",
  riskFactors: "Disclosed Risk Factors",
  valueAccrual: "Value Accrual",
  supplyIssuance: "Supply And Issuance",
  usageAdoption: "Usage And Adoption",
  governanceBuilders: "Governance And Builders",
  competitionMoat: "Competition And Moat",
  keyRisks: "Key Risks",
  whatItIs: "What It Is",
  whyNow: "Why Now",
  beneficiaries: "Beneficiaries",
  headwinds: "Headwinds",
  keyDebates: "Key Debates",
  howItPlaysOut: "How It Plays Out",
};

function filingBasisEntry(metrics: Readonly<Record<string, number | string>>): string | undefined {
  const { form } = metrics;
  if (form !== "10-K" && form !== "10-Q") {
    return undefined;
  }
  const filingDate = typeof metrics.filingDate === "string" ? metrics.filingDate : undefined;
  const reportDate = typeof metrics.reportDate === "string" ? metrics.reportDate : undefined;
  if (form === "10-K") {
    const filed = filingDate !== undefined ? ` filed ${filingDate}` : "";
    const period = reportDate !== undefined ? ` (period ${reportDate})` : "";
    return `10-K${filed}${period}`;
  }
  if (reportDate !== undefined) {
    return `10-Q for period ${reportDate}`;
  }
  return filingDate !== undefined ? `10-Q filed ${filingDate}` : "10-Q";
}

const PROFILE_NON_ANSWER_RE =
  /(^|\b)(not\s+(disclosed|quantified|available|provided|broken\s+out)|undisclosed|no\s+(disclosure|quantified\s+disclosure)|does\s+not\s+disclose|is\s+not\s+broken\s+out|are\s+not\s+broken\s+out)\b/iu;

function substantiveAnswerSourceIds(
  value: WebSubjectProfileAnswerValue | undefined,
): readonly string[] {
  const answer = value?.answer?.trim() ?? "";
  if (answer === "" || PROFILE_NON_ANSWER_RE.test(answer) || value?.sourceIdsComplete !== true) {
    return [];
  }
  return value.sourceIds;
}

function profileAnswerSourceIds(profile: WebSubjectProfileExtraValue): ReadonlySet<string> {
  return new Set([
    ...substantiveAnswerSourceIds(profile.subjectSummary),
    ...Object.values(profile.questions ?? {}).flatMap((question) =>
      substantiveAnswerSourceIds(question),
    ),
  ]);
}

// Renders the SEC filing basis/verification line for company profiles from the
// 10-K/10-Q filing items actually cited by the accepted profile, plus a
// Disclosure when only the annual 10-K is cited.
function companyFilingBasisLine(
  report: ResearchReport,
  profile: WebSubjectProfileExtraValue,
): string | undefined {
  const answerSourceIds = profileAnswerSourceIds(profile);
  if (answerSourceIds.size === 0) {
    return undefined;
  }
  const items = (report.extendedEvidence?.items ?? []).filter(
    (item) =>
      item.category === "sec-edgar" &&
      item.sourceIds.some((sourceId) => answerSourceIds.has(sourceId)),
  );
  const entries = items.flatMap((item) =>
    item.metrics !== undefined ? [filingBasisEntry(item.metrics)] : [],
  );
  const forms = new Set(
    items.flatMap((item) => {
      const form = item.metrics?.form;
      return form === "10-K" || form === "10-Q" ? [form] : [];
    }),
  );
  const parts = entries.filter((entry): entry is string => entry !== undefined);
  if (parts.length === 0) {
    return undefined;
  }
  const disclosure =
    forms.has("10-K") && !forms.has("10-Q") ? " Current-year 10-Q unavailable." : "";
  return `**Basis:** ${parts.join("; ")}.${disclosure}`;
}

function renderWebSubjectProfile(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType) && report.jobType !== "research") {
    return "";
  }
  const profile = readWebSubjectProfileExtra(report.extras?.webSubjectProfile);
  // No `questions` record at all means no profile section, unlike an empty one.
  if (profile?.questions === undefined) {
    return "";
  }
  const { questions, subjectSummary } = profile;
  const subjectKind = profile.subjectKind ?? "company";
  // The wrapper falls back to the company key order for unknown kinds, so
  // Identity against the company order == "company or unknown kind".
  const questionKeys = webSubjectProfileQuestionKeys(subjectKind);
  const usesCompanyLabels = questionKeys === webSubjectProfileQuestionKeys("company");
  const trimEquityReaderDuplicates =
    report.jobType === "equity" && report.assetClass === "equity" && usesCompanyLabels;
  // An empty answer still renders here — the empty-profile producer path emits
  // One — but is suppressed per question below.
  const summary =
    !trimEquityReaderDuplicates && subjectSummary?.answer !== undefined
      ? [
          `${markdownText(subjectSummary.answer)}${sourceRefs(
            citedSourceIds(report, subjectSummary),
          )}`,
        ]
      : [];
  const rows = questionKeys.flatMap((key) => {
    const answer = questions[key];
    if (answer?.answer === undefined || answer.answer === "") {
      return [];
    }
    const refs = sourceRefs(citedSourceIds(report, answer));
    return [
      `- **${WEB_SUBJECT_PROFILE_LABELS[key]}:** ${markdownText(answer.answer)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  const factRows = (rowsIn: readonly WebSubjectProfileFactValue[]): readonly string[] =>
    rowsIn.flatMap((row) => {
      if (row.claim === undefined) {
        return [];
      }
      const refs = sourceRefs(citedSourceIds(report, row));
      return [`- ${markdownText(row.claim)}${refs === "" ? "" : ` ${refs}`}`];
    });
  const events = factRows(profile.recentMaterialEvents);
  const facts = trimEquityReaderDuplicates ? [] : factRows(profile.factLedger);
  const gaps = (profile.openGapsComplete ? profile.openGaps : []).map(
    (gap) => `- ${markdownText(gap)}`,
  );
  if (rows.length === 0 && events.length === 0 && facts.length === 0 && gaps.length === 0) {
    return "";
  }
  const basis = subjectKind === "company" ? companyFilingBasisLine(report, profile) : undefined;
  return [
    "## Web Subject Profile",
    "",
    ...summary,
    ...(summary.length > 0 ? [""] : []),
    ...(basis !== undefined ? [basis, ""] : []),
    ...rows,
    ...(events.length > 0 ? ["", "### Recent Material Events", "", ...events] : []),
    ...(facts.length > 0 ? ["", "### Fact Ledger", "", ...facts] : []),
    ...(gaps.length > 0 ? ["", "### Profile Gaps", "", ...gaps] : []),
    "",
  ].join("\n");
}

function renderEarningsSetup(report: ResearchReport): string {
  if (!isInstrumentJobType(report.jobType)) {
    return "";
  }
  const setup = report.extras?.earningsSetup;
  if (!isRecord(setup) || !isRecord(setup.event)) {
    return "";
  }
  const { event } = setup;
  const symbol = typeof event.symbol === "string" ? event.symbol : "";
  const date = typeof event.date === "string" ? event.date : "";
  const timing = typeof event.timing === "string" ? event.timing : "unknown";
  const eventDateStatus = event.eventDateStatus ?? event.dateStatus;
  const isProviderEstimated = eventDateStatus === "provider-estimated";
  const confirmationSourceId =
    isRecord(event.dateConfirmation) && typeof event.dateConfirmation.sourceId === "string"
      ? event.dateConfirmation.sourceId
      : undefined;
  let certaintyLabel = "";
  if (isProviderEstimated) {
    certaintyLabel = " — date provider-estimated (Finnhub), unconfirmed";
  } else if (eventDateStatus === "issuer-confirmed") {
    certaintyLabel = ` — date issuer-confirmed${confirmationSourceId === undefined ? "" : ` [${markdownText(confirmationSourceId)}]`}`;
  } else if (eventDateStatus === "exchange-confirmed") {
    certaintyLabel = ` — date exchange-confirmed${confirmationSourceId === undefined ? "" : ` [${markdownText(confirmationSourceId)}]`}`;
  }
  const lines = [
    "## Earnings Setup",
    "",
    `**Event:** ${markdownText(symbol)} earnings on ${date} (timing: ${timing})${certaintyLabel}`,
  ];

  if (typeof event.epsEstimate === "number") {
    lines.push(
      `**EPS estimate:** ${String(event.epsEstimate)} — single-provider snapshot (Finnhub)`,
    );
  }
  if (typeof event.revenueEstimate === "number") {
    lines.push(
      `**Revenue estimate:** ${event.revenueEstimate.toLocaleString("en-US")} — single-provider snapshot (Finnhub)`,
    );
  }

  if (isRecord(setup.impliedMove)) {
    const move = setup.impliedMove;
    const pct =
      typeof move.impliedMovePct === "number" ? (move.impliedMovePct * 100).toFixed(1) : "?";
    const strike = typeof move.strike === "number" ? String(move.strike) : "?";
    const expiration = typeof move.expiration === "string" ? move.expiration : "?";
    lines.push(`**Implied move:** ±${pct}% (ATM strike ${strike}, expiration ${expiration})`);
  }

  const sectionNames = {
    expectationBar: "Expectation Bar",
    qualityLandmines: "Quality Landmines",
    guidanceCredibility: "Guidance Credibility",
  } as const;
  for (const key of ["expectationBar", "qualityLandmines", "guidanceCredibility"] as const) {
    const sectionName = sectionNames[key];
    const bullets = (setup as Record<string, unknown>)[key];
    if (!Array.isArray(bullets) || bullets.length === 0) {
      continue;
    }
    lines.push("", `### ${sectionName}`, "");
    for (const bullet of bullets) {
      if (isRecord(bullet) && typeof bullet.text === "string") {
        const sids = Array.isArray(bullet.sourceIds)
          ? bullet.sourceIds.filter((sid): sid is string => typeof sid === "string")
          : [];
        lines.push(`- ${markdownText(bullet.text)}${sourceRefs(sids)}`);
      }
    }
  }

  const gaps = readStringArray(setup.gaps);
  if (gaps.length > 0) {
    lines.push("", "### Earnings Setup Gaps", "");
    for (const gap of gaps) {
      lines.push(`- ${markdownText(gap)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderExtendedEvidenceSections(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
): readonly string[] {
  return [
    renderBusinessFramework(report),
    renderWebSubjectProfile(report),
    renderExtendedEvidence(report, marketSnapshot),
    renderEarningsSetup(report),
  ];
}

function reportTitle(report: ResearchReport): string {
  if (isInstrumentJobType(report.jobType)) {
    return `${report.symbol} ${report.assetClass} Research View`;
  }
  if (report.jobType === "research") {
    return `${report.assetClass} Thematic Research View`;
  }
  return `${report.assetClass} Market Overview`;
}

export function renderMarkdownReport(
  report: ResearchReport,
  marketSnapshot?: MarketSnapshot,
  collectedSources?: MarkdownCollectedSources,
): string {
  if (report.jobType === "alpha-search") {
    return renderAlphaSearchReport(report);
  }

  if (report.jobType === "equity" && report.assetClass === "equity") {
    return renderEquityMarkdownReport(report, marketSnapshot, collectedSources, {
      reportTitle,
      renderSources,
      renderCompletenessChips: renderEquityCompletenessChips,
      renderCompanyDescription,
      renderPriceAndMarketDate,
      renderFinancialTrends: renderProjectedFinancialTrends,
      renderValuationContext,
      renderFindings,
      renderCatalystCalendar,
      renderEarningsConsensus: renderCompactEarningsAndConsensus,
      renderGapSection,
      renderAppendixSection,
      renderCompletenessAppendix,
      renderBalanceSheet: renderBalanceSheetAndShareCount,
      renderScenarios,
      renderBusinessFramework,
      renderWebSubjectProfile,
      renderAnalystDistributions: renderAnalystEstimateDistributions,
      renderAnalystAndOwnershipContext,
      renderDiagnosticGapSummary,
      renderEarningsSetup,
      renderHistoricalContext,
      renderSpotlights,
      renderPredictions,
    });
  }

  const title = reportTitle(report);
  const materialGaps = predictionShortfallMaterialGaps(report.predictionShortfall, report.dataGaps);
  const gaps =
    materialGaps.length === 0
      ? "- No material gaps identified."
      : materialGaps
          .map((gap) => renderGap(gap, report.symbol, undefined, collectedSources?.sourceGaps))
          .join("\n");
  const sources = renderSources(report);

  return [
    `# ${title}`,
    "",
    RESEARCH_ONLY_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${researchReportEvidenceQuality(report)}`,
    ...(report.reportIntegrity !== undefined
      ? [`Report Integrity: ${report.reportIntegrity}`]
      : []),
    ...(report.researchQuality !== undefined
      ? [`Research Quality: ${report.researchQuality}`]
      : []),
    ...(report.researchQualityDriver !== undefined
      ? [`Research Quality Driver: ${report.researchQualityDriver}`]
      : []),
    ...renderEquityCompletenessChips(report),
    "",
    "## Summary",
    "",
    report.summary,
    "",
    renderMarketUpdateDelta(report),
    renderFindings("Key Findings", report.keyFindings),
    renderFindings("Bull Case", report.bullCase),
    renderFindings("Bear Case", report.bearCase),
    renderFindings("Risks", report.risks),
    renderFindings("Catalysts", report.catalysts),
    renderCatalystCalendar(report),
    renderScenarios(report.scenarios),
    ...renderExtendedEvidenceSections(report, marketSnapshot),
    renderHistoricalContext(report),
    renderSpotlights(report),
    renderPredictions(report.predictions),
    "## Data Gaps",
    "",
    gaps,
    "",
    "## Sources",
    "",
    sources,
    "",
  ].join("\n");
}
