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

export interface ReportSearchCandidate {
  readonly section: ReportSearchSection;
  readonly label: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface TextWithSources {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface ExtendedEvidenceItemView {
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly metrics?: Readonly<Record<string, number | string>>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readSourceIds(record: Record<string, unknown>): readonly string[] {
  const { sourceIds } = record;
  return Array.isArray(sourceIds)
    ? sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
    : [];
}

function readMetrics(
  record: Record<string, unknown>,
): Readonly<Record<string, number | string>> | undefined {
  const { metrics } = record;
  if (!isRecord(metrics)) {
    return undefined;
  }

  const parsed: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      parsed[key] = value;
      continue;
    }
    if (typeof value === "string" && value !== "") {
      parsed[key] = value;
    }
  }

  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function textItems(
  report: Record<string, unknown> | undefined,
  key: string,
): readonly TextWithSources[] {
  const value = report?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const text = readString(item, "text");
      return text === undefined ? [] : [{ text, sourceIds: readSourceIds(item) }];
    });
}

function stringArray(report: Record<string, unknown> | undefined, key: string): readonly string[] {
  const value = report?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function extendedEvidenceItems(
  report?: Record<string, unknown>,
): readonly ExtendedEvidenceItemView[] {
  const block = report?.extendedEvidence;
  if (!isRecord(block)) {
    return [];
  }

  const value = block.items;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const category = readString(item, "category");
      const title = readString(item, "title");
      const summary = readString(item, "summary");
      if (category === undefined || title === undefined || summary === undefined) {
        return [];
      }

      const metrics = readMetrics(item);
      return [
        {
          category,
          title,
          summary,
          sourceIds: readSourceIds(item),
          ...(metrics !== undefined ? { metrics } : {}),
        },
      ];
    });
}

function pushCandidate(
  out: ReportSearchCandidate[],
  section: ReportSearchSection,
  label: string,
  text: string,
  sourceIds: readonly string[],
): void {
  if (text.trim() === "") {
    return;
  }
  out.push({ section, label, text, sourceIds });
}

function findingLabel(section: FindingSection, scope: ReportSearchScope): string {
  if (scope === "console") {
    const consoleLabels: Record<FindingSection, string> = {
      keyFindings: "Key finding",
      bullCase: "Bull case",
      bearCase: "Bear case",
      risks: "Risk",
      catalysts: "Catalyst",
    };
    return consoleLabels[section];
  }
  return section;
}

function textItemCandidates(
  report: Record<string, unknown>,
  section: FindingSection,
  scope: ReportSearchScope,
): readonly ReportSearchCandidate[] {
  const base = findingLabel(section, scope);
  return textItems(report, section).map((item, index) => ({
    section,
    label: `${base} ${String(index + 1)}`,
    text: item.text,
    sourceIds: item.sourceIds,
  }));
}

function predictionLabel(scope: ReportSearchScope, id: string | undefined): string | undefined {
  if (scope === "history") {
    return id;
  }
  return id === undefined ? "Observable forecast" : `Observable forecast ${id}`;
}

function predictionCandidates(
  report: Record<string, unknown>,
  scope: ReportSearchScope,
): readonly ReportSearchCandidate[] {
  const value = report.predictions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const measurableAs = readString(item, "measurableAs");
      const storedClaim = readString(item, "claim");
      const claim =
        measurableAs === undefined
          ? storedClaim
          : renderClaimForMeasurableAs(measurableAs, storedClaim);
      if (claim === undefined) {
        return [];
      }

      const label = predictionLabel(scope, id);
      if (label === undefined) {
        return [];
      }

      const text =
        scope === "console"
          ? [claim, measurableAs].filter((part): part is string => part !== undefined).join(" ")
          : claim;

      return [{ section: "predictions", label, text, sourceIds: readSourceIds(item) }];
    });
}

function sourceCandidates(
  report: Record<string, unknown>,
  scope: ReportSearchScope,
): readonly ReportSearchCandidate[] {
  const value = report.sources;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const title = readString(item, "title");
      if (id === undefined || title === undefined) {
        return [];
      }

      const label = scope === "console" ? `Source ${id}` : id;
      const text =
        scope === "console"
          ? [
              title,
              readString(item, "publisher"),
              readString(item, "provider"),
              readString(item, "summary"),
              readString(item, "snippet"),
              readString(item, "url"),
            ]
              .filter((part): part is string => part !== undefined)
              .join(" ")
          : [title, readString(item, "summary"), readString(item, "snippet")].join(" ");

      return [{ section: "sources", label, text, sourceIds: [id] }];
    });
}

function dataGapCandidates(report: Record<string, unknown>): readonly ReportSearchCandidate[] {
  return stringArray(report, "dataGaps").map((text, index) => ({
    section: "dataGaps",
    label: `Data gap ${String(index + 1)}`,
    text,
    sourceIds: [],
  }));
}

function extendedEvidenceCandidates(
  report: Record<string, unknown>,
): readonly ReportSearchCandidate[] {
  return extendedEvidenceItems(report).map((item, index) => ({
    section: "extendedEvidence",
    label: item.title === "" ? `Extended evidence ${String(index + 1)}` : item.title,
    text: [item.category, item.title, item.summary, metricsSearchText(item.metrics)]
      .filter((part) => part !== "")
      .join(" "),
    sourceIds: item.sourceIds,
  }));
}

export function reportSearchCandidates(
  report: Record<string, unknown>,
  scope: ReportSearchScope,
): readonly ReportSearchCandidate[] {
  const out: ReportSearchCandidate[] = [];

  const summary = readString(report, "summary");
  if (summary !== undefined) {
    pushCandidate(out, "summary", "Summary", summary, []);
  }

  for (const section of ["keyFindings", "bullCase", "bearCase", "risks", "catalysts"] as const) {
    for (const candidate of textItemCandidates(report, section, scope)) {
      pushCandidate(out, section, candidate.label, candidate.text, candidate.sourceIds);
    }
  }

  if (scope === "history") {
    for (const candidate of dataGapCandidates(report)) {
      pushCandidate(out, "dataGaps", candidate.label, candidate.text, candidate.sourceIds);
    }
  }

  for (const candidate of predictionCandidates(report, scope)) {
    pushCandidate(out, "predictions", candidate.label, candidate.text, candidate.sourceIds);
  }

  for (const candidate of sourceCandidates(report, scope)) {
    pushCandidate(out, "sources", candidate.label, candidate.text, candidate.sourceIds);
  }

  if (scope === "console") {
    for (const candidate of dataGapCandidates(report)) {
      pushCandidate(out, "dataGaps", candidate.label, candidate.text, candidate.sourceIds);
    }
    for (const candidate of extendedEvidenceCandidates(report)) {
      pushCandidate(out, "extendedEvidence", candidate.label, candidate.text, candidate.sourceIds);
    }
  }

  return out;
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
