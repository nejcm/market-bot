import type { KeyFinding, Prediction, ResearchReport, Scenario } from "../domain/types";
import { RESEARCH_ONLY_NOTE } from "./schema";

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
  const value = report.extras?.extendedEvidence;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  const items = Array.isArray((value as { items?: unknown }).items)
    ? ((value as { items?: unknown[] }).items ?? [])
    : [];
  if (items.length === 0) {
    return "## Extended Evidence\n\n- No extended evidence items.\n";
  }
  const rows = items
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return;
      }
      const record = item as {
        title?: unknown;
        summary?: unknown;
        sourceIds?: unknown;
      };
      if (typeof record.title !== "string" || typeof record.summary !== "string") {
        return;
      }
      const refs = Array.isArray(record.sourceIds)
        ? sourceRefs(
            record.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string"),
          )
        : "";
      return `- **${record.title}:** ${record.summary}${refs === "" ? "" : ` ${refs}`}`;
    })
    .filter((row): row is string => row !== undefined);
  return `## Extended Evidence\n\n${rows.join("\n")}\n`;
}

export function renderMarkdownReport(report: ResearchReport): string {
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
