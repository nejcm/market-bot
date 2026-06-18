import type { KeyFinding, Prediction, ResearchReport, Scenario } from "../domain/types";
import { renderClaimForMeasurableAs } from "../forecast/observable";
import { RESEARCH_ONLY_NOTE } from "./schema";
import {
  readAlphaSearchLeads,
  readAlphaSearchProfileCoverage,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";
import { isRecord } from "../sources/guards";

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

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function knownSourceIds(report: ResearchReport, sourceIds: unknown): readonly string[] {
  const known = new Set(report.sources.map((source) => source.id));
  return readStringArray(sourceIds).filter((sourceId) => known.has(sourceId));
}

function collectReportSourceIds(report: ResearchReport): ReadonlySet<string> {
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

function renderSources(report: ResearchReport): string {
  if (report.sources.length === 0) {
    return "- No sources.";
  }

  const citedIds = collectReportSourceIds(report);
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
      return `- **${markdownText(item.title)}:** ${markdownText(item.summary)}${refs === "" ? "" : ` ${refs}`}`;
    })
    .join("\n");
  return `## Extended Evidence\n\n${rows}\n`;
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

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    const probability = readNumberField(item, "probability");
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
      : report.dataGaps.map((gap) => `- ${markdownText(gap)}`).join("\n");
  const sources = renderSources(report);
  const leads = readAlphaSearchLeads(report.extras);
  const rejected = readAlphaSearchRejectedCandidates(report.extras);
  const coverage = renderAlphaSearchCoverage(report);
  const leadRows =
    leads.length === 0
      ? "- No Yahoo-validated research leads."
      : leads
          .map((lead) => {
            const name = lead.name === undefined ? "" : ` (${markdownText(lead.name)})`;
            const social = socialDriverText(lead);
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
    RESEARCH_ONLY_ALPHA_SEARCH_NOTE,
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

function reportTitle(report: ResearchReport): string {
  if (report.jobType === "ticker") {
    return `${report.symbol} ${report.assetClass} Research View`;
  }
  if (report.jobType === "research") {
    return `${report.assetClass} Thematic Research View`;
  }
  return `${report.assetClass} Market Overview`;
}

export function renderMarkdownReport(report: ResearchReport): string {
  if (report.jobType === "alpha-search") {
    return renderAlphaSearchReport(report);
  }

  const title = reportTitle(report);
  const gaps =
    report.dataGaps.length === 0
      ? "- No material gaps identified."
      : report.dataGaps.map((gap) => `- ${markdownText(gap)}`).join("\n");
  const sources = renderSources(report);

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
    renderMarketUpdateDelta(report),
    renderFindings("Key Findings", report.keyFindings),
    renderFindings("Bull Case", report.bullCase),
    renderFindings("Bear Case", report.bearCase),
    renderFindings("Risks", report.risks),
    renderFindings("Catalysts", report.catalysts),
    renderCatalystCalendar(report),
    renderScenarios(report.scenarios),
    renderExtendedEvidence(report),
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
