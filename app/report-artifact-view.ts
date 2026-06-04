import type { RunSearchSection } from "./types";

export interface TextWithSources {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export interface ScenarioView {
  readonly name: string;
  readonly description: string;
  readonly sourceIds: readonly string[];
}

export interface PredictionView {
  readonly id: string;
  readonly claim: string;
  readonly kind?: string;
  readonly probability?: number;
  readonly horizonTradingDays?: number;
  readonly sourceIds: readonly string[];
}

export interface SourceView {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly provider?: string;
  readonly url?: string;
}

export interface ReportSearchCandidate {
  readonly section: RunSearchSection;
  readonly label: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readHttpUrl(record: Record<string, unknown>, key: string): string | undefined {
  const value = readString(record, key);
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function readSourceIds(record: Record<string, unknown>): readonly string[] {
  const { sourceIds } = record;
  return Array.isArray(sourceIds)
    ? sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
    : [];
}

export function textItems(
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

export function scenarios(report: Record<string, unknown> | undefined): readonly ScenarioView[] {
  const value = report?.scenarios;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const name = readString(item, "name");
      const description = readString(item, "description");
      return name === undefined || description === undefined
        ? []
        : [{ name, description, sourceIds: readSourceIds(item) }];
    });
}

export function predictions(
  report: Record<string, unknown> | undefined,
): readonly PredictionView[] {
  const value = report?.predictions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const claim = readString(item, "claim");
      const kind = readString(item, "kind");
      const probability = readNumber(item, "probability");
      const horizonTradingDays = readNumber(item, "horizonTradingDays");
      return id === undefined || claim === undefined
        ? []
        : [
            {
              id,
              claim,
              ...(kind !== undefined ? { kind } : {}),
              ...(probability !== undefined ? { probability } : {}),
              ...(horizonTradingDays !== undefined ? { horizonTradingDays } : {}),
              sourceIds: readSourceIds(item),
            },
          ];
    });
}

export function sources(report: Record<string, unknown> | undefined): readonly SourceView[] {
  const value = report?.sources;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const id = readString(item, "id");
      const title = readString(item, "title");
      const kind = readString(item, "kind");
      const provider = readString(item, "provider");
      const url = readHttpUrl(item, "url");
      return id === undefined || title === undefined
        ? []
        : [
            {
              id,
              title,
              ...(kind !== undefined ? { kind } : {}),
              ...(provider !== undefined ? { provider } : {}),
              ...(url !== undefined ? { url } : {}),
            },
          ];
    });
}

export function stringArray(
  report: Record<string, unknown> | undefined,
  key: string,
): readonly string[] {
  const value = report?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function textItemCandidates(
  report: Record<string, unknown>,
  key: RunSearchSection,
  label: string,
): readonly ReportSearchCandidate[] {
  return textItems(report, key).map((item, index) => ({
    section: key,
    label: `${label} ${String(index + 1)}`,
    text: item.text,
    sourceIds: item.sourceIds,
  }));
}

function predictionCandidates(report: Record<string, unknown>): readonly ReportSearchCandidate[] {
  const value = report.predictions;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const claim = readString(item, "claim");
      const id = readString(item, "id");
      const measurableAs = readString(item, "measurableAs");
      if (claim === undefined) {
        return [];
      }

      return [
        {
          section: "predictions",
          label: id === undefined ? "Observable forecast" : `Observable forecast ${id}`,
          text: [claim, measurableAs]
            .filter((part): part is string => part !== undefined)
            .join(" "),
          sourceIds: readSourceIds(item),
        },
      ];
    });
}

function sourceCandidates(report: Record<string, unknown>): readonly ReportSearchCandidate[] {
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

      const text = [
        title,
        readString(item, "publisher"),
        readString(item, "provider"),
        readString(item, "summary"),
        readString(item, "snippet"),
        readString(item, "url"),
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");

      return [{ section: "sources", label: `Source ${id}`, text, sourceIds: [id] }];
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

export function reportSearchCandidates(
  report: Record<string, unknown>,
): readonly ReportSearchCandidate[] {
  const summary = readString(report, "summary");
  const summaryCandidates: readonly ReportSearchCandidate[] =
    summary === undefined
      ? []
      : [{ section: "summary", label: "Summary", text: summary, sourceIds: [] }];

  return [
    ...summaryCandidates,
    ...textItemCandidates(report, "keyFindings", "Key finding"),
    ...textItemCandidates(report, "bullCase", "Bull case"),
    ...textItemCandidates(report, "bearCase", "Bear case"),
    ...textItemCandidates(report, "risks", "Risk"),
    ...textItemCandidates(report, "catalysts", "Catalyst"),
    ...predictionCandidates(report),
    ...sourceCandidates(report),
    ...dataGapCandidates(report),
  ];
}
