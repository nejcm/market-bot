import type {
  ModelInputSanitizationAggregate,
  ModelInputSanitizationAggregateEntry,
} from "../domain/types";
import {
  aggregateModelInputSanitization,
  sanitizeModelInputField,
} from "../sources/model-input-sanitizer";
import type { HistoricalContextReader, HistoricalResearchContext } from "./historical-context";

export interface SanitizedHistoricalContextProjection {
  readonly context: HistoricalResearchContext;
  readonly modelInputSanitization: ModelInputSanitizationAggregate;
}

export interface SanitizedHistoricalContextReader {
  readonly load: (
    input: Parameters<HistoricalContextReader["load"]>[0],
  ) => Promise<SanitizedHistoricalContextProjection>;
  // Passed through unsanitized: feeds deterministic analytics, never model prompts.
  readonly findForecastPersistenceBaseline: HistoricalContextReader["findForecastPersistenceBaseline"];
}

function sanitizeHistoricalProse(
  value: string,
  entries: ModelInputSanitizationAggregateEntry[],
): string {
  const result = sanitizeModelInputField(value, {
    provider: "historical-artifact",
    ingress: "historical-context",
    profile: "legacy-history",
    fieldRole: "prose",
  });
  entries.push(result.entry);
  return result.text ?? "";
}

function sanitizeHistoricalUnknown(
  value: unknown,
  entries: ModelInputSanitizationAggregateEntry[],
): unknown {
  if (typeof value === "string") {
    return sanitizeHistoricalProse(value, entries);
  }
  if (Array.isArray(value)) {
    return value.map((nested) => sanitizeHistoricalUnknown(nested, entries));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sanitizeHistoricalUnknown(nested, entries),
      ]),
    );
  }
  return value;
}

export function sanitizeHistoricalContextProjection(
  context: HistoricalResearchContext,
): SanitizedHistoricalContextProjection {
  const entries: ModelInputSanitizationAggregateEntry[] = [];
  return {
    context: {
      ...context,
      runs: context.runs.map((run) => ({
        ...run,
        summary: sanitizeHistoricalProse(run.summary, entries),
        keyFindings: run.keyFindings.flatMap((finding) => {
          const text = sanitizeHistoricalProse(finding.text, entries);
          return text === "" ? [] : [{ ...finding, text }];
        }),
        risks: run.risks.flatMap((finding) => {
          const text = sanitizeHistoricalProse(finding.text, entries);
          return text === "" ? [] : [{ ...finding, text }];
        }),
        catalysts: run.catalysts.flatMap((finding) => {
          const text = sanitizeHistoricalProse(finding.text, entries);
          return text === "" ? [] : [{ ...finding, text }];
        }),
        dataGaps: run.dataGaps
          .map((value) => sanitizeHistoricalProse(value, entries))
          .filter((value) => value !== ""),
        predictions: run.predictions.map((prediction) => ({
          ...prediction,
          claim: sanitizeHistoricalProse(prediction.claim, entries),
        })),
        ...(run.keyExtras !== undefined
          ? {
              keyExtras: sanitizeHistoricalUnknown(run.keyExtras, entries) as Record<
                string,
                unknown
              >,
            }
          : {}),
      })),
      gaps: context.gaps
        .map((value) => sanitizeHistoricalProse(value, entries))
        .filter((value) => value !== ""),
    },
    modelInputSanitization: aggregateModelInputSanitization(entries),
  };
}

export function createSanitizedHistoricalContextReader(
  reader: HistoricalContextReader,
): SanitizedHistoricalContextReader {
  return {
    load: async (input) => sanitizeHistoricalContextProjection(await reader.load(input)),
    findForecastPersistenceBaseline: reader.findForecastPersistenceBaseline,
  };
}
