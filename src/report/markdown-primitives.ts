import type { KeyFinding, Prediction, ResearchReport, Scenario, SourceGap } from "../domain/types";
import { renderClaimForMeasurableAs } from "../forecast/observable";
import {
  readAlphaSearchLeads,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";
import { isRecord } from "../guards";
import { readGapTriage, type GapTriage } from "./gap-triage";
import { readBusinessFrameworkExtra, readWebSubjectProfileExtra } from "./report-extras-contract";
import { compactNumber } from "./equity-reader-trends";

export function sourceRefs(sourceIds: readonly string[]): string {
  return sourceIds.map((sourceId) => `[${markdownText(sourceId)}]`).join(" ");
}

export function markdownText(value: string): string {
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

export function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

export function renderGap(
  gap: string,
  reportSymbol?: string,
  placement?: GapTriage,
  sourceGaps: readonly SourceGap[] = [],
): string {
  const triage = placement ?? readGapTriage(gap, sourceGaps, reportSymbol);
  return `- **${triage === "material" ? "Material" : "Diagnostic"}:** ${markdownText(gap)}`;
}

// Diverges from guards.readStringArray (record+key, undefined on miss) and
// Guards.stringArrayValue (filters mixed arrays): all-or-nothing over a raw value.
export function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function knownSourceIds(report: ResearchReport, sourceIds: unknown): readonly string[] {
  const known = new Set(report.sources.map((source) => source.id));
  return readStringArray(sourceIds).filter((sourceId) => known.has(sourceId));
}

// Render policy. The extras readers keep the per-item valid entries of a mixed
// Array because the Research Console renders them, but markdown has always
// Treated any non-string member as making the whole array unusable.
export function citedSourceIds(
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

export function renderSources(
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

export function renderFindings(title: string, findings: readonly KeyFinding[]): string {
  if (findings.length === 0) {
    return `## ${title}\n\n- No sourced items.\n`;
  }

  return `## ${title}\n\n${findings.map((finding) => `- ${finding.text} ${sourceRefs(finding.sourceIds)}`).join("\n")}\n`;
}

export function renderScenarios(scenarios: readonly Scenario[]): string {
  if (scenarios.length === 0) {
    return "## Scenarios\n\n- No sourced scenarios.\n";
  }

  return `## Scenarios\n\n${scenarios.map((scenario) => `- **${scenario.name}:** ${scenario.description} ${sourceRefs(scenario.sourceIds)}`).join("\n")}\n`;
}

export function renderPredictions(predictions: readonly Prediction[]): string {
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

export function renderGapSection(
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

export function renderAppendixSection(markdown: string): string {
  return markdown.replaceAll(/^(#{2,5})(?= )/gmu, "#$1");
}

export function renderDiagnosticGapSummary(
  count: number,
  disclosedGaps: readonly string[],
): string {
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
