import { isInstrumentJobType, type MarketSnapshot, type ResearchReport } from "../domain/types";
import { isRecord } from "../guards";
import { compactNumber } from "./equity-reader-trends";
import type { EquityReaderAnalystEstimateDistribution } from "./equity-reader";
import { knownSourceIds, markdownText, sourceRefs } from "./markdown-primitives";
import { renderPriceProvenance } from "./markdown-equity-sections";

export function renderExtendedEvidence(
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

export function renderAnalystAndOwnershipContext(report: ResearchReport): string {
  return `${renderAnalystEstimateContext(report)}${renderInstitutionalOwnershipContext(report)}`;
}

function formatDistributionValue(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

export function renderAnalystEstimateDistributions(
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

export function renderHistoricalContext(report: ResearchReport): string {
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

export function renderSpotlights(report: ResearchReport): string {
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
