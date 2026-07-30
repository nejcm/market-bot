import {
  isInstrumentJobType,
  resolveMarketSnapshotPriceAsOf,
  researchReportEvidenceQuality,
  type EquityAnalysisDimensionStatus,
  type KeyFinding,
  type MarketSnapshot,
  type Prediction,
  type ResearchReport,
  type Scenario,
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
import { classifyGap } from "./gap-triage";
import type { CollectedSources } from "../sources/types";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeries,
} from "../sources/extended-evidence/fundamental-history";
import type { FinancialStatementSeries } from "../sources/extended-evidence/financial-statements-contract";
import { renderValuationWorkbenchMarkdown } from "./valuation-workbench-markdown";
import { renderReverseDcfMarkdown } from "./reverse-dcf-markdown";

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

function renderGap(gap: string, reportSymbol?: string): string {
  const triage = classifyGap(gap, reportSymbol);
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
  const dimensions = [
    ["Primary financials", completeness.dimensions.primaryFinancials],
    ["Valuation", completeness.dimensions.valuation],
    ["Expectations", completeness.dimensions.expectations],
    ["Capital & ownership", completeness.dimensions.capitalOwnership],
    ["Operating KPIs", completeness.dimensions.operatingKpis],
  ] as const;
  return [
    `Analysis Completeness: financial core ${completenessStatusChip(completeness.financialCoreStatus)} · coverage \`${completeness.coverageLevel}\``,
    `Dimension Status: ${dimensions
      .map(([label, dimension]) => `${label} ${completenessStatusChip(dimension.status)}`)
      .join(" · ")}`,
  ];
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
  const framework = report.extras?.businessFramework;
  if (isRecord(framework)) {
    add(knownSourceIds(report, framework.sourceIds));
    if (Array.isArray(framework.sections)) {
      framework.sections.forEach((section) => {
        if (isRecord(section)) {
          add(knownSourceIds(report, section.sourceIds));
        }
      });
    }
  }
  const profile = report.extras?.webSubjectProfile;
  if (isRecord(profile)) {
    add(knownSourceIds(report, profile.sourceIds));
    if (isRecord(profile.questions)) {
      Object.values(profile.questions).forEach((question) => {
        if (isRecord(question)) {
          add(knownSourceIds(report, question.sourceIds));
        }
      });
    }
    for (const key of ["recentMaterialEvents", "factLedger"] as const) {
      const facts = profile[key];
      if (Array.isArray(facts)) {
        facts.forEach((fact) => {
          if (isRecord(fact)) {
            add(knownSourceIds(report, fact.sourceIds));
          }
        });
      }
    }
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

function renderCompanyDescription(report: ResearchReport): string {
  const profile = report.extras?.webSubjectProfile;
  if (isRecord(profile)) {
    const candidates = [
      profile.subjectSummary,
      isRecord(profile.questions) ? profile.questions.whatItDoes : undefined,
    ];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.answer !== "string" || candidate.answer === "") {
        continue;
      }
      const refs = sourceRefs(knownSourceIds(report, candidate.sourceIds));
      return `## What the Company Does\n\n${markdownText(candidate.answer)}${refs === "" ? "" : ` ${refs}`}\n`;
    }
  }

  const framework = report.extras?.businessFramework;
  if (isRecord(framework) && Array.isArray(framework.sections)) {
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
        const refs = sourceRefs(knownSourceIds(report, business.sourceIds));
        return `## What the Company Does\n\n${markdownText(plainText)}${refs === "" ? "" : ` ${refs}`}\n`;
      }
    }
  }

  return "## What the Company Does\n\n- No cited plain-language company description is available.\n";
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

function compactNumber(value: number): string {
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

function historyPoint(
  series: FundamentalHistorySeries,
  periodEnd: string,
  kind: "annual" | "ttm",
): FundamentalHistoryPoint | undefined {
  if (kind === "ttm") {
    return series.ttm?.periodEnd === periodEnd ? series.ttm : undefined;
  }
  return series.annual.find((point) => point.periodEnd === periodEnd);
}

interface TrendPeriod {
  readonly kind: "annual" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

interface StatementPeriod {
  readonly kind: "annual" | "interim";
  readonly periodEnd: string;
  readonly filedAt: string;
}

function periodLabel(period: TrendPeriod | StatementPeriod): string {
  if (period.kind === "ttm") {
    return `TTM (${period.periodEnd}; filed ${period.filedAt})`;
  }
  return `${period.kind === "annual" ? "FY" : "Interim"} ending ${period.periodEnd} (filed ${period.filedAt})`;
}

function trendPeriods(history: FundamentalHistoryArtifact): readonly TrendPeriod[] {
  const annual = new Map<string, TrendPeriod>();
  for (const series of Object.values(history.series)) {
    for (const point of series.annual) {
      const existing = annual.get(point.periodEnd);
      if (existing === undefined || point.filedAt < existing.filedAt) {
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
  for (const series of Object.values(history.series)) {
    const point = series.ttm;
    if (point === undefined) {
      continue;
    }
    if (
      ttm === undefined ||
      point.periodEnd > ttm.periodEnd ||
      (point.periodEnd === ttm.periodEnd && point.filedAt < ttm.filedAt)
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

function historyValue(
  history: FundamentalHistoryArtifact,
  key: keyof FundamentalHistoryArtifact["series"],
  period: TrendPeriod,
): number | undefined {
  return historyPoint(history.series[key], period.periodEnd, period.kind)?.value;
}

function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function formatTrendPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function renderFinancialTrends(
  report: ResearchReport,
  sources: Pick<CollectedSources, "fundamentalHistory"> | undefined,
): string {
  const history = sources?.fundamentalHistory;
  if (history === undefined) {
    return "## Financial Trends\n\n- Three-to-five-year and TTM history is unavailable.\n";
  }
  const periods = trendPeriods(history);
  if (periods.length === 0) {
    return "## Financial Trends\n\n- Three-to-five-year and TTM history is unavailable.\n";
  }
  const rows = periods.map((period) => {
    const netIncome = historyValue(history, "netIncome", period);
    const operatingMargin = historyValue(history, "operatingMargin", period);
    return [
      periodLabel(period),
      formatTrendAmount(historyValue(history, "revenue", period)),
      formatTrendAmount(netIncome),
      formatTrendPercent(operatingMargin),
      formatTrendAmount(historyValue(history, "freeCashFlowProxy", period)),
    ].join(" | ");
  });
  const currency =
    history.series.revenue.ttm?.currency ?? history.series.revenue.annual.at(-1)?.currency;
  const refs = sourceRefs(knownSourceIds(report, [history.sourceId]));
  return [
    "## Financial Trends",
    "",
    `Amounts${currency === undefined ? "" : ` in ${markdownText(currency)}`}. FCF is the reported operating-cash-flow less capex proxy.${refs === "" ? "" : ` ${refs}`}`,
    "",
    "Period | Revenue | Net income | Operating margin | FCF",
    "--- | ---: | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

function statementPeriods(
  financialStatements: NonNullable<CollectedSources["financialStatements"]>,
): readonly StatementPeriod[] {
  const { cash, debt } = financialStatements.statements.balanceSheet;
  const { dilutedShares } = financialStatements.statements.perShare;
  const periods = new Map<string, StatementPeriod>();
  for (const series of [cash, debt, dilutedShares]) {
    for (const kind of ["annual", "interim"] as const) {
      for (const fact of series[kind]) {
        const existing = periods.get(fact.periodEnd);
        if (
          existing === undefined ||
          (kind === "annual" && existing.kind === "interim") ||
          (kind === existing.kind && fact.filedAt < existing.filedAt)
        ) {
          periods.set(fact.periodEnd, {
            kind,
            periodEnd: fact.periodEnd,
            filedAt: fact.filedAt,
          });
        }
      }
    }
  }
  return [...periods.values()]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .slice(-5);
}

function statementValue(series: FinancialStatementSeries, periodEnd: string): number | undefined {
  return (
    series.annual.find((fact) => fact.periodEnd === periodEnd)?.value ??
    series.interim.find((fact) => fact.periodEnd === periodEnd)?.value
  );
}

function renderBalanceSheetAndShareCount(
  report: ResearchReport,
  sources: Pick<CollectedSources, "financialStatements"> | undefined,
): string {
  const financialStatements = sources?.financialStatements;
  if (financialStatements === undefined) {
    return "### Balance Sheet and Share Count\n\n- Balance-sheet and diluted-share history is unavailable.\n";
  }
  const periods = statementPeriods(financialStatements);
  if (periods.length === 0) {
    return "### Balance Sheet and Share Count\n\n- Balance-sheet and diluted-share history is unavailable.\n";
  }
  const { cash, debt } = financialStatements.statements.balanceSheet;
  const { dilutedShares } = financialStatements.statements.perShare;
  const rows = periods.map((period) =>
    [
      periodLabel(period),
      formatTrendAmount(statementValue(cash, period.periodEnd)),
      formatTrendAmount(statementValue(debt, period.periodEnd)),
      formatTrendAmount(statementValue(dilutedShares, period.periodEnd)),
    ].join(" | "),
  );
  const refs = sourceRefs(knownSourceIds(report, [financialStatements.sourceId]));
  return [
    "### Balance Sheet and Share Count",
    "",
    `Cash and debt amounts${financialStatements.reportingCurrency === undefined ? "" : ` in ${markdownText(financialStatements.reportingCurrency)}`}; diluted shares are weighted-average shares.${refs === "" ? "" : ` ${refs}`}`,
    "",
    "Period | Cash | Debt | Diluted shares",
    "--- | ---: | ---: | ---:",
    ...rows,
    "",
  ].join("\n");
}

function renderValuationContext(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
  sources: Pick<CollectedSources, "valuationWorkbench"> | undefined,
): string {
  const comparison = sources?.valuationWorkbench?.peerComparison;
  if (comparison?.status === "available") {
    const { valuationComps } = comparison;
    const { impliedPriceRange: range, target } = valuationComps;
    if (range?.status === "derived") {
      const { priceAsOf } = target;
      const date =
        priceAsOf === undefined
          ? target.quoteObservedAt
          : `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
      let position = "above";
      if (range.position === "within-range") {
        position = "within";
      } else if (range.position === "below-range") {
        position = "below";
      }
      return `## Valuation Context\n\nThe observed quote is ${position} the peer-implied price reference range of ${range.low.toFixed(2)}–${range.high.toFixed(2)} ${range.inputs.quoteCurrency}${date === undefined ? "" : ` as of ${date}`}; this is valuation context, not a target price.\n`;
    }
  }
  const fundamentals = marketSnapshot?.fundamentals;
  const metrics = [
    ...(fundamentals?.trailingPE === undefined
      ? []
      : [`trailing P/E ${fundamentals.trailingPE.toFixed(2)}x`]),
    ...(fundamentals?.forwardPE === undefined
      ? []
      : [`forward P/E ${fundamentals.forwardPE.toFixed(2)}x`]),
    ...(fundamentals?.priceToBook === undefined
      ? []
      : [`price/book ${fundamentals.priceToBook.toFixed(2)}x`]),
  ];
  const refs =
    marketSnapshot === undefined
      ? ""
      : sourceRefs(knownSourceIds(report, [marketSnapshot.sourceId]));
  const context =
    metrics.length === 0
      ? "No peer-derived reference range or normalized market multiple is available"
      : `Observed market multiples are ${metrics.join(", ")}`;
  return `## Valuation Context\n\n${context}; this is valuation context, not a target price.${refs === "" ? "" : ` ${refs}`}\n`;
}

function renderCompactEarningsAndConsensus(report: ResearchReport): string {
  const rows: string[] = [];
  const setup = report.extras?.earningsSetup;
  if (isRecord(setup) && isRecord(setup.event)) {
    const { event } = setup;
    const symbol = typeof event.symbol === "string" ? event.symbol : report.symbol;
    const date = typeof event.date === "string" ? event.date : undefined;
    const timing = typeof event.timing === "string" ? event.timing : "unknown";
    const status = event.eventDateStatus ?? event.dateStatus;
    const refs = sourceRefs(knownSourceIds(report, event.sourceIds));
    if (date !== undefined) {
      rows.push(
        `- **Upcoming earnings:** ${markdownText(symbol ?? "")} on ${date} (${timing}; ${typeof status === "string" ? status : "confirmation unavailable"})${refs === "" ? "" : ` ${refs}`}`,
      );
    }
    if (typeof event.epsEstimate === "number") {
      rows.push(`- **EPS consensus:** ${String(event.epsEstimate)} (single-provider snapshot)`);
    }
    if (typeof event.revenueEstimate === "number") {
      rows.push(
        `- **Revenue consensus:** ${compactNumber(event.revenueEstimate)} (single-provider snapshot)`,
      );
    }
  }
  const consensusItems =
    report.extendedEvidence?.items.filter((item) => item.category === "analyst-estimates") ?? [];
  for (const item of consensusItems) {
    const mean = item.metrics?.mean;
    if (typeof mean !== "number") {
      continue;
    }
    const period = item.metrics?.period;
    const count = item.metrics?.count;
    const refs = sourceRefs(item.sourceIds);
    rows.push(
      `- **${markdownText(item.title)}:** mean ${compactNumber(mean)}${typeof period === "string" ? ` for ${period}` : ""}${typeof count === "number" ? ` (${String(count)} estimates)` : ""}${refs === "" ? "" : ` ${refs}`}`,
    );
  }
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
): string {
  const rows =
    gaps.length === 0
      ? `- ${emptyMessage}`
      : gaps.map((gap) => renderGap(gap, reportSymbol)).join("\n");
  return `## ${title}\n\n${rows}\n`;
}

function renderAppendixSection(markdown: string): string {
  return markdown.replaceAll(/^(#{2,5})(?= )/gmu, "#$1");
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
  return `${renderAnalystEstimateContext(report)}${renderInstitutionalOwnershipContext(report)}## Extended Evidence\n\n${rows}\n`;
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
  return report.jobType === "weekly" ? "11-15d" : "1-5d";
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
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => renderGap(gap)).join("\n");
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
  const framework = report.extras?.businessFramework;
  if (!isRecord(framework) || !Array.isArray(framework.sections)) {
    return "";
  }
  const phase = typeof framework.phase === "string" ? framework.phase : "insufficient-data";
  const rows = framework.sections.flatMap((section) => {
    if (!isRecord(section) || typeof section.name !== "string") {
      return [];
    }
    const posture =
      section.name !== "Phase" && typeof section.posture === "string"
        ? ` (${markdownText(section.posture)})`
        : "";
    let text = "";
    const { text: sectionText, summary } = section;
    if (typeof sectionText === "string") {
      text = sectionText;
    } else if (typeof summary === "string") {
      text = summary;
    }
    if (text === "") {
      return [];
    }
    const refs = sourceRefs(knownSourceIds(report, section.sourceIds));
    return [
      `- **${markdownText(section.name)}**${posture}: ${markdownText(text)}${refs === "" ? "" : ` ${refs}`}`,
    ];
  });
  const gaps = readFrameworkGapTexts(framework.gaps).map((gap) => `- ${markdownText(gap)}`);
  return [
    "## Business Framework",
    "",
    `Phase: ${markdownText(phase)}`,
    "",
    ...rows,
    ...(gaps.length > 0 ? ["", "### Framework Data Gaps", "", ...gaps] : []),
    "",
  ].join("\n");
}

function readFrameworkGapTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((gap) => {
    if (typeof gap === "string") {
      return [gap];
    }
    return isRecord(gap) && typeof gap.text === "string" ? [gap.text] : [];
  });
}

const WEB_SUBJECT_PROFILE_LABELS: Record<string, readonly [string, string][]> = {
  company: [
    ["whatItDoes", "What It Does"],
    ["howItMakesMoney", "How It Makes Money"],
    ["customers", "Customers"],
    ["geography", "Geography"],
    ["purchaseRecurrence", "Purchase Recurrence"],
    ["pricingPower", "Pricing Power"],
    ["recessionCyclicality", "Recession Cyclicality"],
    ["managementTrackRecord", "Management Track Record"],
    ["capitalAllocation", "Capital Allocation"],
    ["companyKpis", "Company-specific KPIs"],
    ["riskFactors", "Disclosed Risk Factors"],
  ],
  "crypto-asset": [
    ["whatItDoes", "What It Does"],
    ["valueAccrual", "Value Accrual"],
    ["supplyIssuance", "Supply And Issuance"],
    ["usageAdoption", "Usage And Adoption"],
    ["governanceBuilders", "Governance And Builders"],
    ["competitionMoat", "Competition And Moat"],
    ["keyRisks", "Key Risks"],
  ],
  theme: [
    ["whatItIs", "What It Is"],
    ["whyNow", "Why Now"],
    ["beneficiaries", "Beneficiaries"],
    ["headwinds", "Headwinds"],
    ["keyDebates", "Key Debates"],
    ["howItPlaysOut", "How It Plays Out"],
  ],
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

function substantiveAnswerSourceIds(value: unknown): readonly string[] {
  if (!isRecord(value) || typeof value.answer !== "string") {
    return [];
  }
  const answer = value.answer.trim();
  return answer === "" || PROFILE_NON_ANSWER_RE.test(answer)
    ? []
    : readStringArray(value.sourceIds);
}

function profileAnswerSourceIds(profile: Record<string, unknown>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const sourceId of substantiveAnswerSourceIds(profile.subjectSummary)) {
    ids.add(sourceId);
  }
  const questions = isRecord(profile.questions) ? profile.questions : {};
  for (const question of Object.values(questions)) {
    for (const sourceId of substantiveAnswerSourceIds(question)) {
      ids.add(sourceId);
    }
  }
  return ids;
}

// Renders the SEC filing basis/verification line for company profiles from the
// 10-K/10-Q filing items actually cited by the accepted profile, plus a
// Disclosure when only the annual 10-K is cited.
function companyFilingBasisLine(
  report: ResearchReport,
  profile: Record<string, unknown>,
): string | undefined {
  const citedSourceIds = profileAnswerSourceIds(profile);
  if (citedSourceIds.size === 0) {
    return undefined;
  }
  const items = (report.extendedEvidence?.items ?? []).filter(
    (item) =>
      item.category === "sec-edgar" &&
      item.sourceIds.some((sourceId) => citedSourceIds.has(sourceId)),
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
  const profile = report.extras?.webSubjectProfile;
  if (!isRecord(profile) || !isRecord(profile.questions)) {
    return "";
  }
  const { questions } = profile;
  const subjectKind = typeof profile.subjectKind === "string" ? profile.subjectKind : "company";
  const labels =
    WEB_SUBJECT_PROFILE_LABELS[subjectKind] ?? WEB_SUBJECT_PROFILE_LABELS.company ?? [];
  const subjectSummary = isRecord(profile.subjectSummary) ? profile.subjectSummary : undefined;
  const summary =
    subjectSummary !== undefined && typeof subjectSummary.answer === "string"
      ? [
          `${markdownText(subjectSummary.answer)}${sourceRefs(
            knownSourceIds(report, subjectSummary.sourceIds),
          )}`,
        ]
      : [];
  const rows = labels.flatMap(([key, label]) => {
    const answer = questions[key];
    if (!isRecord(answer) || typeof answer.answer !== "string" || answer.answer === "") {
      return [];
    }
    const refs = sourceRefs(knownSourceIds(report, answer.sourceIds));
    return [`- **${label}:** ${markdownText(answer.answer)}${refs === "" ? "" : ` ${refs}`}`];
  });
  const events = Array.isArray(profile.recentMaterialEvents)
    ? profile.recentMaterialEvents.flatMap((event) => {
        if (!isRecord(event) || typeof event.claim !== "string") {
          return [];
        }
        const refs = sourceRefs(knownSourceIds(report, event.sourceIds));
        return [`- ${markdownText(event.claim)}${refs === "" ? "" : ` ${refs}`}`];
      })
    : [];
  const facts = Array.isArray(profile.factLedger)
    ? profile.factLedger.flatMap((fact) => {
        if (!isRecord(fact) || typeof fact.claim !== "string") {
          return [];
        }
        const refs = sourceRefs(knownSourceIds(report, fact.sourceIds));
        return [`- ${markdownText(fact.claim)}${refs === "" ? "" : ` ${refs}`}`];
      })
    : [];
  const gaps = readStringArray(profile.openGaps).map((gap) => `- ${markdownText(gap)}`);
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
  collectedSources?: Pick<
    CollectedSources,
    "financialStatements" | "fundamentalHistory" | "valuationWorkbench" | "reverseDcf"
  >,
): string {
  if (report.jobType === "alpha-search") {
    return renderAlphaSearchReport(report);
  }

  if (report.jobType === "equity" && report.assetClass === "equity") {
    return renderEquityMarkdownReport(report, marketSnapshot, collectedSources);
  }

  const title = reportTitle(report);
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => renderGap(gap)).join("\n");
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

function renderEquityMarkdownReport(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
  collectedSources:
    | Pick<
        CollectedSources,
        "financialStatements" | "fundamentalHistory" | "valuationWorkbench" | "reverseDcf"
      >
    | undefined,
): string {
  const title = reportTitle(report);
  const materialGaps = report.dataGaps.filter(
    (gap) => classifyGap(gap, report.symbol) === "material",
  );
  const diagnosticGaps = report.dataGaps.filter(
    (gap) => classifyGap(gap, report.symbol) === "diagnostic",
  );
  const additionalSourceIds = [
    ...(marketSnapshot === undefined ? [] : [marketSnapshot.sourceId]),
    ...(collectedSources?.fundamentalHistory === undefined ||
    trendPeriods(collectedSources.fundamentalHistory).length === 0
      ? []
      : [collectedSources.fundamentalHistory.sourceId]),
    ...(collectedSources?.financialStatements === undefined ||
    statementPeriods(collectedSources.financialStatements).length === 0
      ? []
      : [collectedSources.financialStatements.sourceId]),
  ];
  const sources = renderSources(report, additionalSourceIds);
  const valuationPriceAsOf =
    collectedSources?.valuationWorkbench?.peerComparison.status === "available"
      ? collectedSources.valuationWorkbench.peerComparison.valuationComps.target.priceAsOf
      : undefined;
  const priceAsOf =
    valuationPriceAsOf ??
    (marketSnapshot === undefined ? undefined : resolveMarketSnapshotPriceAsOf(marketSnapshot));

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
    renderCompanyDescription(report),
    renderPriceAndMarketDate(report, marketSnapshot),
    renderFinancialTrends(report, collectedSources),
    renderValuationContext(report, marketSnapshot, collectedSources),
    renderFindings("Catalysts", report.catalysts),
    renderCatalystCalendar(report),
    renderFindings("Key Findings", report.keyFindings),
    renderFindings("Risks", report.risks),
    renderCompactEarningsAndConsensus(report),
    renderGapSection(
      "Material Data Gaps",
      materialGaps,
      "No material gaps identified.",
      report.symbol,
    ),
    "## Appendix",
    "",
    "### Summary",
    "",
    report.summary,
    "",
    renderBalanceSheetAndShareCount(report, collectedSources),
    renderAppendixSection(renderFindings("Bull Case", report.bullCase)),
    renderAppendixSection(renderFindings("Bear Case", report.bearCase)),
    renderAppendixSection(renderScenarios(report.scenarios)),
    renderAppendixSection(renderBusinessFramework(report)),
    renderAppendixSection(renderWebSubjectProfile(report)),
    renderAppendixSection(renderExtendedEvidence(report, marketSnapshot)),
    renderAppendixSection(renderEarningsSetup(report)),
    renderAppendixSection(renderHistoricalContext(report)),
    renderAppendixSection(renderSpotlights(report)),
    renderAppendixSection(renderPredictions(report.predictions)),
    ...(diagnosticGaps.length === 0
      ? []
      : [
          renderAppendixSection(
            renderGapSection(
              "Diagnostic Data Gaps",
              diagnosticGaps,
              "No diagnostic gaps identified.",
              report.symbol,
            ),
          ),
        ]),
    "### Sources",
    "",
    sources,
    "",
    renderAppendixSection(renderValuationWorkbenchMarkdown(collectedSources?.valuationWorkbench)),
    renderAppendixSection(renderReverseDcfMarkdown(collectedSources?.reverseDcf, priceAsOf)),
  ].join("\n");
}
