import {
  isInstrumentJobType,
  researchReportEvidenceQuality,
  type MarketSnapshot,
  type ResearchReport,
} from "../domain/types";
import { RESEARCH_ONLY_NOTE } from "./schema";
import { predictionShortfallMaterialGaps } from "./prediction-shortfall";
import { renderEquityMarkdownReport, type MarkdownCollectedSources } from "./equity-markdown";
import {
  renderAppendixSection,
  renderDiagnosticGapSummary,
  renderFindings,
  renderGap,
  renderGapSection,
  renderPredictions,
  renderScenarios,
  renderSources,
} from "./markdown-primitives";
import {
  renderBalanceSheetAndShareCount,
  renderCompactEarningsAndConsensus,
  renderCompanyDescription,
  renderCompletenessAppendix,
  renderEquityCompletenessChips,
  renderPriceAndMarketDate,
  renderProjectedFinancialTrends,
  renderValuationContext,
} from "./markdown-equity-sections";
import {
  renderAnalystAndOwnershipContext,
  renderAnalystEstimateDistributions,
  renderExtendedEvidence,
  renderHistoricalContext,
  renderSpotlights,
} from "./markdown-evidence-sections";
import {
  renderBusinessFramework,
  renderEarningsSetup,
  renderWebSubjectProfile,
} from "./markdown-profile-sections";
import {
  renderAlphaSearchReport,
  renderCatalystCalendar,
  renderMarketUpdateDelta,
} from "./markdown-market-update";

export { renderFinancialTrends } from "./markdown-equity-sections";

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
