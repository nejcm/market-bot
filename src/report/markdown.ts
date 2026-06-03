import type { KeyFinding, Prediction, ResearchReport, Scenario } from "../domain/types";
import { RESEARCH_ONLY_NOTE } from "./schema";
import {
  readAlphaSearchLeads,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";

function sourceRefs(sourceIds: readonly string[]): string {
  return sourceIds.map((sourceId) => `[${sourceId}]`).join(" ");
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
      return `- [${pct}] (${pred.horizonTradingDays}d) ${pred.claim}${refs}`;
    })
    .join("\n");

  return `## Predictions\n\n${rows}\n`;
}

function renderExtendedEvidence(report: ResearchReport): string {
  if (report.jobType !== "ticker") {
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
      return `- **${item.title}:** ${item.summary}${refs === "" ? "" : ` ${refs}`}`;
    })
    .join("\n");
  return `## Extended Evidence\n\n${rows}\n`;
}

function renderAlphaSearchReport(report: ResearchReport): string {
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${markdownText(gap)}`).join("\n");
  const sources = report.sources
    .map((source) => `- [${markdownText(source.id)}] ${markdownText(source.title)}`)
    .join("\n");
  const leads = readAlphaSearchLeads(report.extras);
  const rejected = readAlphaSearchRejectedCandidates(report.extras);
  const leadRows =
    leads.length === 0
      ? "- No Yahoo-validated research leads."
      : leads
          .map((lead) => {
            const name = lead.name === undefined ? "" : ` (${markdownText(lead.name)})`;
            const social =
              lead.socialRank === undefined ||
              lead.socialMomentumScore === undefined ||
              lead.mentions === undefined ||
              lead.upvotes === undefined
                ? ""
                : `Social rank ${String(lead.socialRank)}, score ${String(lead.socialMomentumScore)}, ${String(lead.mentions)} mention(s), ${String(lead.upvotes)} upvote(s); `;
            const sec =
              lead.recentSecFilings === undefined || lead.recentSecFilings.length === 0
                ? ""
                : `SEC filings ${lead.recentSecFilings.map((filing) => `${markdownText(filing.form)} ${markdownText(filing.filingDate)}`).join(", ")}; `;
            return `- **${markdownText(lead.symbol)}${name}:** Sources ${lead.discoverySources.map(markdownText).join(", ")}; ${social}${sec}Yahoo listed stock on ${markdownText(lead.exchange)}, $${String(lead.price)}, volume ${String(lead.volume)}, market cap ${String(lead.marketCap)}. ${sourceRefs(lead.sourceIds)}`;
          })
          .join("\n");
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
    RESEARCH_ONLY_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${report.confidence}`,
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

export function renderMarkdownReport(report: ResearchReport): string {
  if (report.jobType === "alpha-search") {
    return renderAlphaSearchReport(report);
  }

  const title =
    report.jobType === "ticker"
      ? `${report.symbol} ${report.assetClass} Research View`
      : `${report.assetClass} ${report.jobType === "weekly" ? "Weekly" : "Daily"} Market Update`;
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${gap}`).join("\n");
  const sources = report.sources.map((source) => `- [${source.id}] ${source.title}`).join("\n");

  return [
    `# ${title}`,
    "",
    RESEARCH_ONLY_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${report.confidence}`,
    "",
    "## Summary",
    "",
    report.summary,
    "",
    renderFindings("Key Findings", report.keyFindings),
    renderFindings("Bull Case", report.bullCase),
    renderFindings("Bear Case", report.bearCase),
    renderFindings("Risks", report.risks),
    renderFindings("Catalysts", report.catalysts),
    renderScenarios(report.scenarios),
    renderExtendedEvidence(report),
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
