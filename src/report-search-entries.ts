import type { AssetClass, JobType, Prediction, ResearchReport } from "./domain/types";
import { renderClaimForMeasurableAs } from "./forecast/observable";
import type { PredictionScore } from "./scoring/types";

export const REPORT_SEARCH_SECTIONS = [
  "summary",
  "keyFindings",
  "bullCase",
  "bearCase",
  "risks",
  "catalysts",
  "dataGaps",
  "predictions",
  "sources",
  "extendedEvidence",
  "openQuestions",
] as const;

export type ReportSearchSection = (typeof REPORT_SEARCH_SECTIONS)[number];
export type ReportSearchScope = "console" | "history";

export interface ReportSearchEntry {
  readonly runId: string;
  readonly generatedAt: string;
  readonly jobType: JobType;
  readonly assetClass: AssetClass;
  readonly symbol?: string;
  readonly section: ReportSearchSection;
  readonly label: string;
  readonly text: string;
  readonly keySuffix: string;
  readonly sequence: number;
  readonly sourceIds: readonly string[];
  readonly provider?: string;
  readonly sourceKind?: string;
  readonly predictionId?: string;
}

type FindingSection = "keyFindings" | "bullCase" | "bearCase" | "risks" | "catalysts";

export function predictionClaim(prediction: Prediction): string {
  return renderClaimForMeasurableAs(prediction.measurableAs, prediction.claim) ?? prediction.claim;
}

export function openQuestions(
  report: ResearchReport,
  scores: readonly PredictionScore[],
): readonly string[] {
  const resolved = new Set(
    scores.filter((score) => score.resolved).map((score) => score.predictionId),
  );
  return [
    ...report.dataGaps.map((gap) => `Data gap: ${gap}`),
    ...report.predictions
      .filter((prediction) => !resolved.has(prediction.id))
      .map((prediction) => `Unresolved prediction: ${predictionClaim(prediction)}`),
  ];
}

function indexedSearchKeySuffix(key: string, index: number): string {
  return `${key}:${String(index)}`;
}

function addEntry(
  entries: ReportSearchEntry[],
  report: ResearchReport,
  section: ReportSearchSection,
  label: string,
  text: string,
  keySuffix: string,
  sequence: number,
  sourceIds: readonly string[] = [],
  extras: Pick<
    Partial<ReportSearchEntry>,
    "provider" | "sourceKind" | "predictionId" | "symbol"
  > = {},
): void {
  if (text.trim() === "") {
    return;
  }
  const symbol = extras.symbol ?? report.symbol?.toUpperCase();
  entries.push({
    runId: report.runId,
    generatedAt: report.generatedAt,
    jobType: report.jobType,
    assetClass: report.assetClass,
    section,
    label,
    text,
    keySuffix,
    sequence,
    sourceIds,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(extras.provider !== undefined ? { provider: extras.provider } : {}),
    ...(extras.sourceKind !== undefined ? { sourceKind: extras.sourceKind } : {}),
    ...(extras.predictionId !== undefined ? { predictionId: extras.predictionId } : {}),
  });
}

function addFindingEntries(
  entries: ReportSearchEntry[],
  report: ResearchReport,
  section: FindingSection,
  label: string,
): void {
  for (const [index, finding] of report[section].entries()) {
    addEntry(
      entries,
      report,
      section,
      `${label} ${String(index + 1)}`,
      finding.text,
      String(index),
      index,
      finding.sourceIds,
    );
  }
}

function addDataGapEntries(entries: ReportSearchEntry[], report: ResearchReport): void {
  for (const [index, gap] of report.dataGaps.entries()) {
    addEntry(
      entries,
      report,
      "dataGaps",
      `Data gap ${String(index + 1)}`,
      gap,
      String(index),
      index,
    );
  }
}

function addPredictionEntries(
  entries: ReportSearchEntry[],
  report: ResearchReport,
  scope: ReportSearchScope,
): void {
  for (const [index, prediction] of report.predictions.entries()) {
    const label = scope === "console" ? `Observable forecast ${prediction.id}` : prediction.id;
    const claim = predictionClaim(prediction);
    const text = scope === "console" ? [claim, prediction.measurableAs].join(" ") : claim;
    addEntry(
      entries,
      report,
      "predictions",
      label,
      text,
      indexedSearchKeySuffix(prediction.id, index),
      index,
      prediction.sourceIds,
      { predictionId: prediction.id },
    );
  }
}

function addSourceEntries(
  entries: ReportSearchEntry[],
  report: ResearchReport,
  scope: ReportSearchScope,
): void {
  for (const [index, source] of report.sources.entries()) {
    const label = scope === "console" ? `Source ${source.id}` : source.id;
    const text =
      scope === "console"
        ? [
            source.title,
            source.publisher,
            source.provider,
            source.summary,
            source.snippet,
            source.url,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" ")
        : [source.title, source.summary, source.snippet].join(" ");
    addEntry(
      entries,
      report,
      "sources",
      label,
      text,
      indexedSearchKeySuffix(source.id, index),
      index,
      [source.id],
      {
        ...(source.provider !== undefined ? { provider: source.provider } : {}),
        sourceKind: source.kind,
        ...(source.symbol !== undefined ? { symbol: source.symbol.toUpperCase() } : {}),
      },
    );
  }
}

function metricsSearchText(metrics: Readonly<Record<string, number | string>> | undefined): string {
  if (metrics === undefined) {
    return "";
  }

  return Object.values(metrics).map(String).join(" ");
}

function addExtendedEvidenceEntries(entries: ReportSearchEntry[], report: ResearchReport): void {
  for (const [index, item] of (report.extendedEvidence?.items ?? []).entries()) {
    addEntry(
      entries,
      report,
      "extendedEvidence",
      item.title === "" ? `Extended evidence ${String(index + 1)}` : item.title,
      [item.category, item.title, item.summary, metricsSearchText(item.metrics)]
        .filter((part) => part !== "")
        .join(" "),
      String(index),
      index,
      item.sourceIds,
    );
  }
}

function addOpenQuestionEntries(
  entries: ReportSearchEntry[],
  report: ResearchReport,
  scores: readonly PredictionScore[],
): void {
  for (const [index, question] of openQuestions(report, scores).entries()) {
    addEntry(
      entries,
      report,
      "openQuestions",
      `Open question ${String(index + 1)}`,
      question,
      String(index),
      index,
    );
  }
}

export function buildReportSearchEntries(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  scope: ReportSearchScope,
): readonly ReportSearchEntry[] {
  const entries: ReportSearchEntry[] = [];
  addEntry(entries, report, "summary", "Summary", report.summary, "summary", 0);
  addFindingEntries(
    entries,
    report,
    "keyFindings",
    scope === "console" ? "Key finding" : "keyFindings",
  );
  addFindingEntries(entries, report, "bullCase", scope === "console" ? "Bull case" : "bullCase");
  addFindingEntries(entries, report, "bearCase", scope === "console" ? "Bear case" : "bearCase");
  addFindingEntries(entries, report, "risks", scope === "console" ? "Risk" : "risks");
  addFindingEntries(entries, report, "catalysts", scope === "console" ? "Catalyst" : "catalysts");
  if (scope === "history") {
    addDataGapEntries(entries, report);
  }
  addPredictionEntries(entries, report, scope);
  addSourceEntries(entries, report, scope);
  if (scope === "console") {
    addDataGapEntries(entries, report);
    addExtendedEvidenceEntries(entries, report);
  }
  if (scope === "history") {
    addOpenQuestionEntries(entries, report, scores);
  }
  return entries;
}
