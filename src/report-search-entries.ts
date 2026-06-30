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
  "researchLeads",
  "rejectedCandidates",
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

// Sections a raw-record candidate can carry. `openQuestions` is layered on later by
// `buildReportSearchEntries` (it needs scores), so it is never a candidate section.
export type ReportSearchCandidateSection = Exclude<ReportSearchSection, "openQuestions">;

export interface ReportSearchCandidate {
  readonly section: ReportSearchCandidateSection;
  readonly label: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
  // Stable identity (prediction id / source id) known at build time.
  // The typed path can enrich without reverse-engineering it from the display label.
  readonly identityId?: string;
}

interface TextWithSources {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface ExtendedEvidenceItemView {
  readonly category: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly metrics?: Readonly<Record<string, number | string>>;
}

type FindingSection = "keyFindings" | "bullCase" | "bearCase" | "risks" | "catalysts";
type ReportSearchInputKey =
  | "summary"
  | FindingSection
  | "researchLeads"
  | "rejectedCandidates"
  | "dataGaps"
  | "predictions"
  | "sources"
  | "extendedEvidence";
type ReportSearchInput = Partial<Readonly<Record<ReportSearchInputKey, unknown>>>;

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

function readInputString(record: ReportSearchInput, key: ReportSearchInputKey): string | undefined {
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

export function textItems(
  report: ReportSearchInput | undefined,
  key: FindingSection,
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

export function stringArray(
  report: ReportSearchInput | undefined,
  key: "dataGaps",
): readonly string[] {
  const value = report?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function extendedEvidenceItems(
  report?: ReportSearchInput,
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

function pushCandidate(out: ReportSearchCandidate[], candidate: ReportSearchCandidate): void {
  if (candidate.text.trim() === "") {
    return;
  }
  out.push(candidate);
}

const CONSOLE_FINDING_LABELS: Record<FindingSection, string> = {
  keyFindings: "Key finding",
  bullCase: "Bull case",
  bearCase: "Bear case",
  risks: "Risk",
  catalysts: "Catalyst",
};

function findingLabel(section: FindingSection, scope: ReportSearchScope): string {
  return scope === "console" ? CONSOLE_FINDING_LABELS[section] : section;
}

function textItemCandidates(
  report: ReportSearchInput,
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
  report: ReportSearchInput,
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

      return [
        {
          section: "predictions",
          label,
          text,
          sourceIds: readSourceIds(item),
          ...(id !== undefined ? { identityId: id } : {}),
        },
      ];
    });
}

function sourceCandidates(
  report: ReportSearchInput,
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

      return [{ section: "sources", label, text, sourceIds: [id], identityId: id }];
    });
}

function dataGapCandidates(report: ReportSearchInput): readonly ReportSearchCandidate[] {
  return stringArray(report, "dataGaps").map((text, index) => ({
    section: "dataGaps",
    label: `Data gap ${String(index + 1)}`,
    text,
    sourceIds: [],
  }));
}

function extendedEvidenceCandidates(report: ReportSearchInput): readonly ReportSearchCandidate[] {
  return extendedEvidenceItems(report).map((item, index) => ({
    section: "extendedEvidence",
    label: item.title === "" ? `Extended evidence ${String(index + 1)}` : item.title,
    text: [item.category, item.title, item.summary, metricsSearchText(item.metrics)]
      .filter((part) => part !== "")
      .join(" "),
    sourceIds: item.sourceIds,
  }));
}

function extrasRecord(report: ReportSearchInput): Record<string, unknown> | undefined {
  const value = (report as Readonly<Record<string, unknown>>).extras;
  return isRecord(value) ? value : undefined;
}

function stringListText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").join(" ")
    : "";
}

function alphaResearchLeadCandidates(report: ReportSearchInput): readonly ReportSearchCandidate[] {
  const leads = extrasRecord(report)?.researchLeads;
  if (!Array.isArray(leads)) {
    return [];
  }
  return leads
    .filter((lead) => isRecord(lead))
    .flatMap((lead) => {
      const symbol = readString(lead, "symbol");
      if (symbol === undefined) {
        return [];
      }
      return [
        {
          section: "researchLeads" as const,
          label: `Research lead ${symbol}`,
          text: [
            symbol,
            readString(lead, "name"),
            readString(lead, "exchange"),
            stringListText(lead.discoverySources),
            readString(lead, "secCompanyName"),
          ]
            .filter((part): part is string => part !== undefined && part !== "")
            .join(" "),
          sourceIds: readSourceIds(lead),
          identityId: symbol.toUpperCase(),
        },
      ];
    });
}

function alphaRejectedCandidateCandidates(
  report: ReportSearchInput,
): readonly ReportSearchCandidate[] {
  const rejected = extrasRecord(report)?.rejectedCandidates;
  if (!Array.isArray(rejected)) {
    return [];
  }
  return rejected
    .filter((candidate) => isRecord(candidate))
    .flatMap((candidate) => {
      const symbol = readString(candidate, "symbol");
      const reason = readString(candidate, "reason");
      if (symbol === undefined || reason === undefined) {
        return [];
      }
      return [
        {
          section: "rejectedCandidates" as const,
          label: `Rejected candidate ${symbol}`,
          text: [
            symbol,
            reason,
            stringListText(candidate.discoverySources),
            readString(candidate, "secCompanyName"),
          ]
            .filter((part): part is string => part !== undefined && part !== "")
            .join(" "),
          sourceIds: readSourceIds(candidate),
          identityId: symbol.toUpperCase(),
        },
      ];
    });
}

export function reportSearchCandidates(
  report: ReportSearchInput,
  scope: ReportSearchScope,
): readonly ReportSearchCandidate[] {
  const out: ReportSearchCandidate[] = [];

  const summary = readInputString(report, "summary");
  if (summary !== undefined) {
    pushCandidate(out, { section: "summary", label: "Summary", text: summary, sourceIds: [] });
  }

  for (const section of ["keyFindings", "bullCase", "bearCase", "risks", "catalysts"] as const) {
    for (const candidate of textItemCandidates(report, section, scope)) {
      pushCandidate(out, candidate);
    }
  }

  for (const candidate of alphaResearchLeadCandidates(report)) {
    pushCandidate(out, candidate);
  }

  for (const candidate of alphaRejectedCandidateCandidates(report)) {
    pushCandidate(out, candidate);
  }

  if (scope === "history") {
    for (const candidate of dataGapCandidates(report)) {
      pushCandidate(out, candidate);
    }
  }

  for (const candidate of predictionCandidates(report, scope)) {
    pushCandidate(out, candidate);
  }

  for (const candidate of sourceCandidates(report, scope)) {
    pushCandidate(out, candidate);
  }

  if (scope === "console") {
    for (const candidate of dataGapCandidates(report)) {
      pushCandidate(out, candidate);
    }
    for (const candidate of extendedEvidenceCandidates(report)) {
      pushCandidate(out, candidate);
    }
  }

  return out;
}

function keySuffixFor(
  section: ReportSearchCandidateSection,
  sequence: number,
  identityId: string | undefined,
): string {
  if (section === "summary") {
    return "summary";
  }
  return identityId !== undefined ? `${identityId}:${String(sequence)}` : String(sequence);
}

interface CandidateEnrichment {
  readonly provider?: string;
  readonly sourceKind?: string;
  readonly predictionId?: string;
  readonly symbol?: string;
}

function sourceEnrichment(
  candidate: ReportSearchCandidate,
  sourceById: Map<string, Source>,
): CandidateEnrichment {
  if (candidate.identityId === undefined) {
    return {};
  }
  const source = sourceById.get(candidate.identityId);
  if (source === undefined) {
    return {};
  }
  return {
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    sourceKind: source.kind,
    ...(source.symbol !== undefined ? { symbol: source.symbol.toUpperCase() } : {}),
  };
}

function enrichCandidate(
  candidate: ReportSearchCandidate,
  sourceById: Map<string, Source>,
): CandidateEnrichment {
  if (candidate.section === "sources") {
    return sourceEnrichment(candidate, sourceById);
  }
  if (candidate.section === "predictions" && candidate.identityId !== undefined) {
    return { predictionId: candidate.identityId };
  }
  if (
    (candidate.section === "researchLeads" || candidate.section === "rejectedCandidates") &&
    candidate.identityId !== undefined
  ) {
    return { symbol: candidate.identityId };
  }
  return {};
}

export function buildReportSearchEntries(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  scope: ReportSearchScope,
): readonly ReportSearchEntry[] {
  const candidates = reportSearchCandidates(report, scope);

  const sourceById = new Map<string, Source>();
  for (const source of report.sources) {
    sourceById.set(source.id, source);
  }

  const reportSymbol = report.symbol?.toUpperCase();
  const sequenceBySection = new Map<ReportSearchSection, number>();
  const entries: ReportSearchEntry[] = [];

  for (const candidate of candidates) {
    // Sequence is the compacted ordinal after empty candidates are filtered.
    const sequence = sequenceBySection.get(candidate.section) ?? 0;
    sequenceBySection.set(candidate.section, sequence + 1);

    const enrichment = enrichCandidate(candidate, sourceById);
    const symbol = enrichment.symbol ?? reportSymbol;

    entries.push({
      runId: report.runId,
      generatedAt: report.generatedAt,
      jobType: report.jobType,
      assetClass: report.assetClass,
      section: candidate.section,
      label: candidate.label,
      text: candidate.text,
      keySuffix: keySuffixFor(candidate.section, sequence, candidate.identityId),
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
