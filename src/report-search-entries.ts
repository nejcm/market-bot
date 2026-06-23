import type { AssetClass, JobType, Prediction, ResearchReport, Source } from "./domain/types";
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

function metricsSearchText(metrics: Readonly<Record<string, number | string>> | undefined): string {
  if (metrics === undefined) {
    return "";
  }

  return Object.values(metrics).map(String).join(" ");
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

const OBSERVABLE_FORECAST_PREFIX = "Observable forecast ";

function predictionIdFromCandidate(
  candidate: ReportSearchCandidate,
  scope: ReportSearchScope,
): string | undefined {
  if (scope === "history") {
    return candidate.label;
  }
  return candidate.label.startsWith(OBSERVABLE_FORECAST_PREFIX)
    ? candidate.label.slice(OBSERVABLE_FORECAST_PREFIX.length)
    : undefined;
}

function keySuffixFor(
  section: ReportSearchSection,
  sequence: number,
  identityId: string | undefined,
): string {
  if (section === "summary") {
    return "summary";
  }
  return identityId !== undefined ? `${identityId}:${String(sequence)}` : String(sequence);
}

interface CandidateEnrichment {
  readonly identityId?: string;
  readonly provider?: string;
  readonly sourceKind?: string;
  readonly predictionId?: string;
  readonly symbol?: string;
}

function sourceEnrichment(
  candidate: ReportSearchCandidate,
  sourceById: Map<string, Source>,
): CandidateEnrichment {
  const [sourceId] = candidate.sourceIds;
  if (sourceId === undefined) {
    return {};
  }
  const source = sourceById.get(sourceId);
  if (source === undefined) {
    return { identityId: sourceId };
  }
  return {
    identityId: sourceId,
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    sourceKind: source.kind,
    ...(source.symbol !== undefined ? { symbol: source.symbol.toUpperCase() } : {}),
  };
}

function enrichCandidate(
  candidate: ReportSearchCandidate,
  scope: ReportSearchScope,
  sourceById: Map<string, Source>,
): CandidateEnrichment {
  if (candidate.section === "sources") {
    return sourceEnrichment(candidate, sourceById);
  }
  if (candidate.section === "predictions") {
    const predictionId = predictionIdFromCandidate(candidate, scope);
    if (predictionId === undefined) {
      return {};
    }
    return { identityId: predictionId, predictionId };
  }
  return {};
}

export function buildReportSearchEntries(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  scope: ReportSearchScope,
): readonly ReportSearchEntry[] {
  const candidates = reportSearchCandidates(report as unknown as Record<string, unknown>, scope);

  const sourceById = new Map<string, Source>();
  for (const source of report.sources) {
    sourceById.set(source.id, source);
  }

  const reportSymbol = report.symbol?.toUpperCase();
  const sequenceBySection = new Map<ReportSearchSection, number>();
  const entries: ReportSearchEntry[] = [];

  for (const candidate of candidates) {
    const sequence = sequenceBySection.get(candidate.section) ?? 0;
    sequenceBySection.set(candidate.section, sequence + 1);

    const enrichment = enrichCandidate(candidate, scope, sourceById);
    const symbol = enrichment.symbol ?? reportSymbol;

    entries.push({
      runId: report.runId,
      generatedAt: report.generatedAt,
      jobType: report.jobType,
      assetClass: report.assetClass,
      section: candidate.section,
      label: candidate.label,
      text: candidate.text,
      keySuffix: keySuffixFor(candidate.section, sequence, enrichment.identityId),
      sequence,
      sourceIds: candidate.sourceIds,
      ...(symbol !== undefined ? { symbol } : {}),
      ...(enrichment.provider !== undefined ? { provider: enrichment.provider } : {}),
      ...(enrichment.sourceKind !== undefined ? { sourceKind: enrichment.sourceKind } : {}),
      ...(enrichment.predictionId !== undefined ? { predictionId: enrichment.predictionId } : {}),
    });
  }

  if (scope === "history") {
    for (const [index, question] of openQuestions(report, scores).entries()) {
      entries.push({
        runId: report.runId,
        generatedAt: report.generatedAt,
        jobType: report.jobType,
        assetClass: report.assetClass,
        section: "openQuestions",
        label: `Open question ${String(index + 1)}`,
        text: question,
        keySuffix: String(index),
        sequence: index,
        sourceIds: [],
        ...(reportSymbol !== undefined ? { symbol: reportSymbol } : {}),
      });
    }
  }

  return entries;
}
