import { researchReportEvidenceQuality, type ResearchReport } from "../domain/types";
import {
  readAlphaSearchLeadDisplayLimit,
  readAlphaSearchLeads,
  readAlphaSearchProfileCoverage,
  readAlphaSearchRejectedCandidates,
} from "../alpha-search/report-extras";
import { isRecord, readNumber } from "../guards";
import { predictionShortfallMaterialGaps } from "./prediction-shortfall";
import {
  markdownText,
  readStringArray,
  renderGap,
  renderSources,
  sourceRefs,
} from "./markdown-primitives";

const RESEARCH_ONLY_ALPHA_SEARCH_NOTE =
  "Research-only note: This alpha-search report is for market research only and does not provide investment advice, trade recommendations, position sizing, execution instructions, or portfolio changes.";

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
export function renderMarketUpdateDelta(report: ResearchReport): string {
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

export function renderCatalystCalendar(report: ResearchReport): string {
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

export function renderAlphaSearchReport(report: ResearchReport): string {
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
