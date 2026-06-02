import type { KeyFinding, Prediction, ResearchReport, Scenario } from "../domain/types";
import { RESEARCH_ONLY_NOTE } from "./schema";

interface AlphaSearchLead {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly price: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly instrumentKind: string;
  readonly redditRank: number;
  readonly redditDiscoveryScore: number;
  readonly mentionCount: number;
  readonly discussionStance: string;
  readonly sourceIds: readonly string[];
}

interface AlphaSearchRejectedCandidate {
  readonly symbol: string;
  readonly redditRank: number;
  readonly redditDiscoveryScore: number;
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

function sourceRefs(sourceIds: readonly string[]): string {
  return sourceIds.map((sourceId) => `[${sourceId}]`).join(" ");
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

function readAlphaSearchLeads(report: ResearchReport): readonly AlphaSearchLead[] {
  const leads = report.extras?.researchLeads;
  return Array.isArray(leads) ? (leads as readonly AlphaSearchLead[]) : [];
}

function readAlphaSearchRejectedCandidates(
  report: ResearchReport,
): readonly AlphaSearchRejectedCandidate[] {
  const rejected = report.extras?.rejectedCandidates;
  return Array.isArray(rejected) ? (rejected as readonly AlphaSearchRejectedCandidate[]) : [];
}

function renderAlphaSearchReport(report: ResearchReport): string {
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${gap}`).join("\n");
  const sources = report.sources.map((source) => `- [${source.id}] ${source.title}`).join("\n");
  const leads = readAlphaSearchLeads(report);
  const rejected = readAlphaSearchRejectedCandidates(report);
  const leadRows =
    leads.length === 0
      ? "- No Yahoo-validated research leads."
      : leads
          .map((lead) => {
            const name = lead.name === undefined ? "" : ` (${lead.name})`;
            const exchange = lead.exchange === undefined ? "" : `, ${lead.exchange}`;
            const marketCap =
              lead.marketCap === undefined ? "" : `, market cap ${String(lead.marketCap)}`;
            return `- **${lead.symbol}${name}:** Reddit rank ${String(lead.redditRank)}, score ${String(lead.redditDiscoveryScore)}, ${String(lead.mentionCount)} mention(s), ${lead.discussionStance} stance; Yahoo ${lead.instrumentKind}, $${String(lead.price)}, volume ${String(lead.volume)}${exchange}${marketCap}. ${sourceRefs(lead.sourceIds)}`;
          })
          .join("\n");
  const rejectedRows =
    rejected.length === 0
      ? "- No rejected candidates."
      : rejected
          .map(
            (candidate) =>
              `- **${candidate.symbol}:** Reddit rank ${String(candidate.redditRank)}, score ${String(candidate.redditDiscoveryScore)}; ${candidate.reason}. ${sourceRefs(candidate.sourceIds)}`,
          )
          .join("\n");

  return [
    "# equity Alpha Search Report",
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
