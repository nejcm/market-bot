import type { RunSearchSection } from "./types";
import { renderClaimForMeasurableAs } from "../src/forecast/observable";

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

export interface PredictionScoreView {
  readonly predictionId: string;
  readonly resolved: boolean;
  readonly outcome?: "hit" | "miss";
  readonly observedAt?: string;
  readonly close0?: number;
  readonly closeN?: number;
  readonly changePct?: number;
  readonly pendingReason?: string;
}

export interface ScoredForecast extends PredictionView {
  readonly score?: PredictionScoreView;
}

export interface ForecastRollup {
  readonly total: number;
  readonly resolved: number;
  readonly hits: number;
  readonly misses: number;
  readonly pending: number;
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
      const storedClaim = readString(item, "claim");
      const measurableAs = readString(item, "measurableAs");
      const claim =
        measurableAs === undefined
          ? storedClaim
          : renderClaimForMeasurableAs(measurableAs, storedClaim);
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

export function predictionScores(
  score: Record<string, unknown> | undefined,
): readonly PredictionScoreView[] {
  const value = score?.scores;
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .flatMap((item) => {
      const predictionId = readString(item, "predictionId");
      if (predictionId === undefined) {
        return [];
      }

      const resolved = item.resolved === true;
      const rawOutcome = readString(item, "outcome");
      const outcome = rawOutcome === "hit" || rawOutcome === "miss" ? rawOutcome : undefined;
      const observedAt = readString(item, "observedAt");
      const evidence = isRecord(item.evidence) ? item.evidence : {};
      const close0 = readNumber(evidence, "close0");
      const closeN = readNumber(evidence, "closeN");
      const hasCloses = close0 !== undefined && closeN !== undefined;
      const changePct = hasCloses && close0 !== 0 ? ((closeN - close0) / close0) * 100 : undefined;
      const pendingReason = readString(evidence, "reason");
      return [
        {
          predictionId,
          resolved,
          ...(outcome !== undefined ? { outcome } : {}),
          ...(observedAt !== undefined ? { observedAt } : {}),
          ...(hasCloses ? { close0, closeN } : {}),
          ...(changePct !== undefined ? { changePct } : {}),
          ...(pendingReason !== undefined ? { pendingReason } : {}),
        },
      ];
    });
}

export function scoredForecasts(
  report: Record<string, unknown> | undefined,
  score: Record<string, unknown> | undefined,
): readonly ScoredForecast[] {
  const scoresById = new Map(
    predictionScores(score).map((item) => [item.predictionId, item] as const),
  );
  return predictions(report).map((prediction) => {
    const predictionScore = scoresById.get(prediction.id);
    return predictionScore === undefined ? prediction : { ...prediction, score: predictionScore };
  });
}

export function forecastRollup(items: readonly ScoredForecast[]): ForecastRollup {
  const resolvedItems = items.filter((item) => item.score?.resolved === true);
  const hits = resolvedItems.filter((item) => item.score?.outcome === "hit").length;
  const misses = resolvedItems.filter((item) => item.score?.outcome === "miss").length;
  return {
    total: items.length,
    resolved: resolvedItems.length,
    hits,
    misses,
    pending: items.length - resolvedItems.length,
  };
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
