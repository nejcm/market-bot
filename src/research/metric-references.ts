import type { ResearchReport } from "../domain/report";
import { isRecord, nonEmptyStringArrayValue } from "../guards";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import { formatMetricValue } from "../sources/extended-evidence/value-format";
import type { ModelReportPayload } from "./report-assembly";
import type { CollectedSources } from "../sources/types";
import { collectedCodeAssembledExtraKeys } from "./extended-evidence-projections";

const REFERENCE = /<<\s*metric\s*:\s*([^<>{}]+)>>/giu;
const REFERENCE_START = /(?:<<|\{\{)\s*metric\s*:/iu;
const CLAIM_FIELDS = new Set(["text", "name", "description", "rationale"]);

function hasMetricReference(value: unknown): boolean {
  if (typeof value === "string") {
    return REFERENCE_START.test(value);
  }
  return Array.isArray(value)
    ? value.some(hasMetricReference)
    : isRecord(value) && Object.values(value).some(hasMetricReference);
}

function transformClaims(
  value: unknown,
  sections: readonly MetricSection[],
  resolve: boolean,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformClaims(item, sections, resolve));
  }
  if (!isRecord(value)) {
    return value;
  }
  const sourceIds = new Set(nonEmptyStringArrayValue(value.sourceIds));
  let referenced = false;
  const entries = Object.entries(value).map(([key, item]) => {
    if (typeof item !== "string" || !REFERENCE_START.test(item)) {
      return [key, transformClaims(item, sections, resolve)];
    }
    if (!CLAIM_FIELDS.has(key)) {
      throw new Error(`Metric reference is not allowed in ${key}; use a cited narrative claim`);
    }
    const text = item.replaceAll(REFERENCE, (token, captured: string) => {
      const reference = captured.trim();
      const dot = reference.lastIndexOf(".");
      if (dot <= 0 || dot === reference.length - 1) {
        throw new Error(`Malformed metric reference ${token}`);
      }
      const metric = sections
        .find(({ id }) => id === reference.slice(0, dot))
        ?.metrics.find(({ id }) => id === reference.slice(dot + 1));
      const formatted =
        metric?.status === "value"
          ? formatMetricValue(metric.value, metric.unit, metric.currency)
          : undefined;
      if (formatted === undefined || metric === undefined || metric.sourceIds.length === 0) {
        throw new Error(
          `Metric reference ${token} is unknown, unavailable, or unciteable; remove it or use an available metric reference`,
        );
      }
      referenced = true;
      metric.sourceIds.forEach((id) => sourceIds.add(id));
      return resolve ? formatted : token;
    });
    if (REFERENCE_START.test(text.replaceAll(REFERENCE, ""))) {
      throw new Error(`Malformed metric reference in ${key}`);
    }
    return [key, text];
  });
  return { ...Object.fromEntries(entries), ...(referenced ? { sourceIds: [...sourceIds] } : {}) };
}

function transformNarrative<T extends ModelReportPayload>(
  payload: T,
  sections: readonly MetricSection[],
  resolve: boolean,
): T {
  const extras = isRecord(payload.extras) ? payload.extras : {};
  const narrative = {
    summary: payload.summary,
    keyFindings: payload.keyFindings,
    bullCase: payload.bullCase,
    bearCase: payload.bearCase,
    risks: payload.risks,
    catalysts: payload.catalysts,
    scenarios: payload.scenarios,
    dataGaps: payload.dataGaps,
    extras: {
      businessFramework: extras.businessFramework,
      earningsSetup: extras.earningsSetup,
      spotlights: extras.spotlights,
    },
  };
  if (hasMetricReference([payload.summary, payload.dataGaps, payload.predictions])) {
    throw new Error(
      "Metric references require a cited narrative claim; summary, dataGaps and predictions cannot contain them",
    );
  }
  if (!hasMetricReference(narrative)) {
    return payload;
  }
  const transformed = transformClaims(narrative, sections, resolve) as typeof narrative;
  return { ...payload, ...transformed, extras: { ...extras, ...transformed.extras } };
}

export function citeMetricReferences(
  payload: ModelReportPayload,
  sections: readonly MetricSection[],
): ModelReportPayload {
  return transformNarrative(payload, sections, false);
}

export function resolveMetricReferences(
  report: ResearchReport,
  sections: readonly MetricSection[],
): ResearchReport {
  return transformNarrative(report, sections, true);
}

export function assertNoUnresolvedMetricReferences(
  report: ResearchReport,
  collectedSources: CollectedSources,
): void {
  const {
    sources: _sources,
    extendedEvidence: _extendedEvidence,
    extras,
    ...authoredAndDeterministic
  } = report;
  const collectedKeys = collectedCodeAssembledExtraKeys(collectedSources);
  const authoredExtras = Object.fromEntries(
    Object.entries(extras ?? {}).filter(([key]) => !collectedKeys.has(key)),
  );
  if (hasMetricReference([authoredAndDeterministic, authoredExtras])) {
    throw new Error(
      "Unresolved metric reference in assembled report; remove it or use a supported cited narrative claim",
    );
  }
}
