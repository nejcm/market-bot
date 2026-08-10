import {
  resolveMarketSnapshotPriceAsOf,
  researchReportEvidenceQuality,
  type MarketSnapshot,
  type ResearchReport,
  type Scenario,
  type SourceGap,
} from "../domain/types";
import type { CollectedSources } from "../sources/types";
import { projectEquityReader, type EquityReaderCompanyDescription } from "./equity-reader";
import { renderReverseDcfMarkdown } from "./reverse-dcf-markdown";
import { RESEARCH_ONLY_NOTE } from "./schema";
import { renderValuationWorkbenchMarkdown } from "./valuation-workbench-markdown";

export type MarkdownCollectedSources = Pick<
  CollectedSources,
  "financialStatements" | "fundamentalHistory" | "valuationWorkbench" | "reverseDcf"
> & { readonly sourceGaps?: readonly SourceGap[] };

export interface EquityMarkdownSections {
  readonly reportTitle: (report: ResearchReport) => string;
  readonly renderSources: (
    report: ResearchReport,
    additionalSourceIds?: readonly string[],
  ) => string;
  readonly renderCompletenessChips: (report: ResearchReport) => readonly string[];
  readonly renderCompanyDescription: (description: EquityReaderCompanyDescription) => string;
  readonly renderPriceAndMarketDate: (
    report: ResearchReport,
    marketSnapshot: MarketSnapshot | undefined,
  ) => string;
  readonly renderFinancialTrends: ReturnType<
    typeof equityProjectionRendererFactory
  >["financialTrends"];
  readonly renderValuationContext: ReturnType<
    typeof equityProjectionRendererFactory
  >["valuationContext"];
  readonly renderFindings: (title: string, findings: ResearchReport["keyFindings"]) => string;
  readonly renderCatalystCalendar: (report: ResearchReport) => string;
  readonly renderEarningsConsensus: ReturnType<
    typeof equityProjectionRendererFactory
  >["earningsConsensus"];
  readonly renderGapSection: (
    title: string,
    gaps: readonly string[],
    emptyMessage: string,
    symbol: string | undefined,
    triage: "material" | "diagnostic",
  ) => string;
  readonly renderAppendixSection: (markdown: string) => string;
  readonly renderCompletenessAppendix: ReturnType<
    typeof equityProjectionRendererFactory
  >["completeness"];
  readonly renderBalanceSheet: ReturnType<typeof equityProjectionRendererFactory>["balanceSheet"];
  readonly renderScenarios: (scenarios: readonly Scenario[]) => string;
  readonly renderBusinessFramework: (report: ResearchReport) => string;
  readonly renderWebSubjectProfile: (report: ResearchReport) => string;
  readonly renderAnalystDistributions: ReturnType<
    typeof equityProjectionRendererFactory
  >["analystDistributions"];
  readonly renderAnalystAndOwnershipContext: (report: ResearchReport) => string;
  readonly renderDiagnosticGapSummary: (count: number) => string;
  readonly renderEarningsSetup: (report: ResearchReport) => string;
  readonly renderHistoricalContext: (report: ResearchReport) => string;
  readonly renderSpotlights: (report: ResearchReport) => string;
  readonly renderPredictions: (predictions: ResearchReport["predictions"]) => string;
}

function equityProjectionRendererFactory() {
  const projection = projectEquityReader({ report: undefined });
  return {
    financialTrends: (
      _report: ResearchReport,
      _value: typeof projection.defaultView.financialTrends,
    ) => "",
    valuationContext: (
      _report: ResearchReport,
      _value: typeof projection.defaultView.valuationContext,
    ) => "",
    earningsConsensus: (
      _report: ResearchReport,
      _value: typeof projection.defaultView.earningsConsensus,
    ) => "",
    completeness: (_value: typeof projection.appendix.completeness) => "",
    balanceSheet: (
      _report: ResearchReport,
      _value: typeof projection.appendix.balanceSheetHistory,
    ) => "",
    analystDistributions: (
      _report: ResearchReport,
      _value: typeof projection.appendix.analystEstimateDistributions,
    ) => "",
  };
}

export function renderEquityMarkdownReport(
  report: ResearchReport,
  marketSnapshot: MarketSnapshot | undefined,
  collectedSources: MarkdownCollectedSources | undefined,
  sections: EquityMarkdownSections,
): string {
  const projection = projectEquityReader({
    report,
    ...(marketSnapshot === undefined ? {} : { marketSnapshot }),
    ...(collectedSources?.fundamentalHistory === undefined
      ? {}
      : { fundamentalHistory: collectedSources.fundamentalHistory }),
    ...(collectedSources?.financialStatements === undefined
      ? {}
      : { financialStatements: collectedSources.financialStatements }),
    ...(collectedSources?.valuationWorkbench === undefined
      ? {}
      : { valuationWorkbench: collectedSources.valuationWorkbench }),
    ...(collectedSources?.sourceGaps === undefined
      ? {}
      : { sourceGaps: collectedSources.sourceGaps }),
  });
  const diagnosticGapCount = projection.appendix.diagnosticGaps.length;
  const additionalSourceIds = [
    ...(marketSnapshot === undefined ? [] : [marketSnapshot.sourceId]),
    ...projection.defaultView.companyDescription.sourceIds,
    ...(projection.defaultView.financialTrends?.sourceIds ?? []),
    ...(projection.appendix.balanceSheetHistory?.sourceIds ?? []),
    ...projection.defaultView.valuationContext.sourceIds,
    ...projection.defaultView.earningsConsensus.flatMap((item) => item.sourceIds),
    ...projection.appendix.analystEstimateDistributions.flatMap((item) => item.sourceIds),
  ];
  const priceAsOf =
    (collectedSources?.valuationWorkbench?.peerComparison.status === "available"
      ? collectedSources.valuationWorkbench.peerComparison.valuationComps.target.priceAsOf
      : undefined) ??
    (marketSnapshot === undefined ? undefined : resolveMarketSnapshotPriceAsOf(marketSnapshot));

  return [
    `# ${sections.reportTitle(report)}`,
    "",
    RESEARCH_ONLY_NOTE,
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence Quality: ${researchReportEvidenceQuality(report)}`,
    ...(report.reportIntegrity === undefined
      ? []
      : [`Report Integrity: ${report.reportIntegrity}`]),
    ...(report.researchQuality === undefined
      ? []
      : [`Research Quality: ${report.researchQuality}`]),
    ...(report.researchQualityDriver === undefined
      ? []
      : [`Research Quality Driver: ${report.researchQualityDriver}`]),
    ...sections.renderCompletenessChips(report),
    "",
    sections.renderCompanyDescription(projection.defaultView.companyDescription),
    sections.renderPriceAndMarketDate(report, marketSnapshot),
    sections.renderFinancialTrends(report, projection.defaultView.financialTrends),
    sections.renderValuationContext(report, projection.defaultView.valuationContext),
    sections.renderFindings("Catalysts", report.catalysts),
    sections.renderCatalystCalendar(report),
    sections.renderFindings("Key Findings", report.keyFindings),
    sections.renderFindings("Risks", report.risks),
    sections.renderEarningsConsensus(report, projection.defaultView.earningsConsensus),
    sections.renderGapSection(
      "Material Data Gaps",
      projection.defaultView.materialGaps,
      "No material gaps identified.",
      report.symbol,
      "material",
    ),
    "## Appendix",
    "",
    "### Summary",
    "",
    report.summary,
    "",
    sections.renderAppendixSection(
      sections.renderCompletenessAppendix(projection.appendix.completeness),
    ),
    sections.renderBalanceSheet(report, projection.appendix.balanceSheetHistory),
    sections.renderAppendixSection(sections.renderFindings("Bull Case", report.bullCase)),
    sections.renderAppendixSection(sections.renderFindings("Bear Case", report.bearCase)),
    sections.renderAppendixSection(sections.renderScenarios(report.scenarios)),
    sections.renderAppendixSection(sections.renderBusinessFramework(report)),
    sections.renderAppendixSection(sections.renderWebSubjectProfile(report)),
    ...(projection.appendix.analystEstimateDistributions.length === 0
      ? []
      : [
          sections.renderAppendixSection(
            sections.renderAnalystDistributions(
              report,
              projection.appendix.analystEstimateDistributions,
            ),
          ),
        ]),
    sections.renderAppendixSection(sections.renderAnalystAndOwnershipContext(report)),
    sections.renderAppendixSection(sections.renderEarningsSetup(report)),
    sections.renderAppendixSection(sections.renderHistoricalContext(report)),
    sections.renderAppendixSection(sections.renderSpotlights(report)),
    sections.renderAppendixSection(sections.renderPredictions(report.predictions)),
    ...(diagnosticGapCount === 0
      ? []
      : [sections.renderAppendixSection(sections.renderDiagnosticGapSummary(diagnosticGapCount))]),
    "### Sources",
    "",
    sections.renderSources(report, additionalSourceIds),
    "",
    sections.renderAppendixSection(
      renderValuationWorkbenchMarkdown(collectedSources?.valuationWorkbench),
    ),
    sections.renderAppendixSection(
      renderReverseDcfMarkdown(collectedSources?.reverseDcf, priceAsOf),
    ),
  ]
    .join("\n")
    .replace(/\n*$/u, "\n");
}
