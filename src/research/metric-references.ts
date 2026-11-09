import type { RenderedMetric, ResearchReport } from "../domain/report";
import { isRecord, nonEmptyStringArrayValue } from "../guards";
import type { MetricResult, MetricSection } from "../sources/extended-evidence/metric-engine";
import {
  formatMetricValue,
  metricPeriodLabel,
  type LensValueUnit,
} from "../sources/extended-evidence/value-format";
import { verifiedMarketSnapshotSourceId } from "../sources/verified-market-snapshot";
import type { ModelReportPayload } from "./report-assembly";
import type { CollectedSources } from "../sources/types";
import { collectedCodeAssembledExtraKeys } from "./extended-evidence-projections";

const REFERENCE = /<<\s*metric\s*:\s*([^<>{}]+)>>/giu;
// Any << or >> left in authored prose is placeholder residue (unprefixed, nested, unclosed).
const REFERENCE_START = /(?:<<|\{\{)\s*metric\s*:|<<|>>/iu;
const RESIDUE_START = new RegExp(REFERENCE_START.source, "giu");
const UNPREFIXED = /<<([^<>{}]*)>>/gu;
const CLAIM_FIELDS = new Set(["text", "name", "description", "rationale"]);
const SESSION_SECTION = "market-session";
const PRICE_INDICATORS = new Set([
  "ema10",
  "sma50",
  "sma200",
  "bollUpper",
  "bollMiddle",
  "bollLower",
  "atr14",
]);
const INDICATOR_LABELS: Readonly<Record<string, string>> = {
  ema10: "EMA10",
  sma50: "SMA50",
  sma200: "SMA200",
  rsi14: "RSI14",
  macd: "MACD",
  macdSignal: "MACD signal",
  macdHistogram: "MACD histogram",
  bollUpper: "Bollinger upper band",
  bollMiddle: "Bollinger middle band",
  bollLower: "Bollinger lower band",
  atr14: "ATR14",
};

// Reference-only rows from the Verified Market Snapshot; they never join report.extras.metricSections.
function marketSessionSection(collected: CollectedSources): MetricSection | undefined {
  const snapshot = collected.verifiedMarketSnapshot;
  if (snapshot === undefined) {
    return undefined;
  }
  const { symbol, latestSessionDate, ohlcv, recentCloses } = snapshot;
  const currency =
    collected.priceHistory?.find((row) => row.symbol === symbol)?.currency ??
    collected.metricSections
      ?.flatMap(({ metrics }) => metrics.flatMap(({ inputs }) => inputs))
      .find((row) => row.artifact === "priceHistory" && row.symbol === symbol)?.currency;
  const priceUnit: LensValueUnit = currency === undefined ? "number" : "currency-per-share";
  const session = `${symbol} daily bar for session ${latestSessionDate}${snapshot.latestSessionStatus === "unverified" ? " (latest session unverified)" : ""}`;
  const row = (
    id: string,
    label: string,
    unit: LensValueUnit,
    value: number,
    basis: string,
    periodEnd = latestSessionDate,
    change?: MetricResult["change"],
  ): MetricResult => ({
    id,
    label,
    unit,
    basis,
    ...(change !== undefined ? { change } : {}),
    status: "value",
    value,
    ...(unit === "currency-per-share" && currency !== undefined ? { currency } : {}),
    periodEnd,
    inputs: [],
    sourceIds: [verifiedMarketSnapshotSourceId(symbol)],
  });
  const prior = recentCloses.at(-1)?.date === ohlcv.date ? recentCloses.at(-2) : undefined;
  const metrics = [
    row("close", "Session close", priceUnit, ohlcv.close, session),
    row("open", "Session open", priceUnit, ohlcv.open, session),
    row("high", "Session high", priceUnit, ohlcv.high, session),
    row("low", "Session low", priceUnit, ohlcv.low, session),
    ...(prior === undefined || prior.close === 0
      ? []
      : [
          row(
            "previousClose",
            "Prior session close",
            priceUnit,
            prior.close,
            `${symbol} daily close for session ${prior.date}`,
            prior.date,
          ),
          row(
            "sessionChangePercent",
            "Session change",
            "whole-percent",
            (ohlcv.close / prior.close - 1) * 100,
            `${session} close vs ${prior.date} close`,
            latestSessionDate,
            { over: "vs prior close" },
          ),
        ]),
    ...Object.entries(snapshot.indicators).flatMap(([key, value]) =>
      value === null || !Number.isFinite(value)
        ? []
        : [
            row(
              key,
              INDICATOR_LABELS[key] ?? key,
              PRICE_INDICATORS.has(key) ? priceUnit : "number",
              value,
              `${symbol} bar-close indicator through session ${latestSessionDate}`,
            ),
          ],
    ),
  ];
  return { id: SESSION_SECTION, title: "Latest market session", metrics };
}

// The referenceable catalog: collected Metric Sections plus the market-session rows.
export function referenceMetricSections(collected: CollectedSources): readonly MetricSection[] {
  const session = marketSessionSection(collected);
  return [...(collected.metricSections ?? []), ...(session === undefined ? [] : [session])];
}

function withFormat(
  value: string,
  metric: MetricResult,
  sectionId: string,
  format: string,
): string | undefined {
  if (format !== "period" || metric.periodEnd === undefined) {
    return undefined;
  }
  const label = metricPeriodLabel(
    metric.periodEnd,
    metric.periodMonths,
    sectionId,
    metric.inputs,
    metric.priceAsOf,
  );
  return `${value} (${label.replace(/^[A-Z](?=[a-z])/u, (letter) => letter.toLowerCase())})`;
}

function withChange(value: string | undefined, metric: MetricResult): string | undefined {
  if (value === undefined || metric.change === undefined) {
    return value;
  }
  return `${/^[-+]/u.test(value) ? "" : "+"}${value} ${metric.change.over}`;
}

// Prose with every well-formed reference removed, and how many there were.
export function splitMetricReferences(text: string): {
  readonly prose: string;
  readonly references: number;
} {
  return {
    prose: text.replaceAll(REFERENCE, " "),
    references: [...text.matchAll(REFERENCE)].length,
  };
}

function metricReferencePath(value: unknown, path = ""): string | undefined {
  if (typeof value === "string") {
    return REFERENCE_START.test(value) ? path : undefined;
  }
  const children = Array.isArray(value)
    ? value.map((item, index) => [`${path}[${index}]`, item] as const)
    : isRecord(value)
      ? Object.entries(value).map(
          ([key, item]) => [path === "" ? key : `${path}.${key}`, item] as const,
        )
      : [];
  for (const [childPath, item] of children) {
    const found = metricReferencePath(item, childPath);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function hasMetricReference(value: unknown): boolean {
  return metricReferencePath(value) !== undefined;
}

// Exact catalog ids missing only the `metric:` prefix; anything else stays malformed.
function withMetricPrefix(
  text: string,
  sections: readonly MetricSection[],
  written: Map<string, string>,
): string {
  return text.replaceAll(UNPREFIXED, (token, inner: string) => {
    const bar = inner.indexOf("|");
    const reference = (bar === -1 ? inner : inner.slice(0, bar)).trim();
    const dot = reference.lastIndexOf(".");
    const known =
      dot > 0 &&
      sections.some(
        ({ id, metrics }) =>
          id === reference.slice(0, dot) &&
          metrics.some((metric) => metric.id === reference.slice(dot + 1)),
      );
    if (!known) {
      return token;
    }
    const prefixed = `<<metric:${reference}${bar === -1 ? "" : inner.slice(bar)}>>`;
    written.set(prefixed, token);
    return prefixed;
  });
}

function transformClaims(
  value: unknown,
  sections: readonly MetricSection[],
  resolve: boolean,
  errors: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformClaims(item, sections, resolve, errors));
  }
  if (!isRecord(value)) {
    return value;
  }
  const citedIds = new Set(nonEmptyStringArrayValue(value.sourceIds));
  const sourceIds = new Set(citedIds);
  const renderedMetrics: RenderedMetric[] = [];
  let referenced = false;
  const entries = Object.entries(value).map(([key, item]) => {
    if (typeof item !== "string" || !REFERENCE_START.test(item)) {
      return [key, transformClaims(item, sections, resolve, errors)];
    }
    if (!CLAIM_FIELDS.has(key)) {
      errors.push(`Metric reference is not allowed in ${key}; use a cited narrative claim`);
      return [key, item];
    }
    const written = new Map<string, string>();
    let shift = 0;
    const text = withMetricPrefix(item, sections, written).replaceAll(
      REFERENCE,
      (prefixed, captured: string, offset: number) => {
        const token = written.get(prefixed) ?? prefixed;
        const [reference = "", format, ...extra] = captured.split("|").map((part) => part.trim());
        const dot = reference.lastIndexOf(".");
        if (dot <= 0 || dot === reference.length - 1 || extra.length > 0 || format === "") {
          errors.push(`Malformed metric reference ${token}`);
          return prefixed;
        }
        const sectionId = reference.slice(0, dot);
        const sectionMetrics = sections.find(({ id }) => id === sectionId)?.metrics ?? [];
        const metric = sectionMetrics.find(({ id }) => id === reference.slice(dot + 1));
        const rendered =
          metric?.status === "value"
            ? withChange(formatMetricValue(metric.value, metric.unit, metric.currency), metric)
            : undefined;
        if (rendered === undefined || metric === undefined || metric.sourceIds.length === 0) {
          const longer =
            metric === undefined
              ? sectionMetrics
                  .filter(
                    (row) =>
                      row.id.startsWith(`${reference.slice(dot + 1)}-`) &&
                      row.status === "value" &&
                      row.sourceIds.length > 0,
                  )
                  .map((row) => `<<metric:${sectionId}.${row.id}>>`)
              : [];
          errors.push(
            longer.length === 0
              ? `Metric reference ${token} is unknown, unavailable, or unciteable; remove it or use an available metric reference`
              : `Metric reference ${token} is unknown, unavailable, or unciteable; it names no metric, but these do: ${longer.join(", ")}`,
          );
          return prefixed;
        }
        const formatted =
          format === undefined
            ? rendered
            : withFormat(rendered, metric, sectionId, format.toLowerCase());
        if (formatted === undefined) {
          errors.push(
            `Metric reference ${token} has an unsupported format; use |period only on a metric with a period, or the bare reference`,
          );
          return prefixed;
        }
        referenced = true;
        metric.sourceIds.forEach((id) => sourceIds.add(id));
        if (!resolve) {
          return prefixed;
        }
        renderedMetrics.push({ field: key, start: offset + shift, text: formatted });
        shift += formatted.length - prefixed.length;
        return formatted;
      },
    );
    const rest = text.replaceAll(REFERENCE, " ");
    let end = 0;
    for (const { index } of rest.matchAll(RESIDUE_START)) {
      if (index >= end) {
        const leftover = /^<<[^<>]*>>|^\S*?>>|^\S*/u.exec(rest.slice(index))?.[0] ?? "";
        end = index + leftover.length;
        errors.push(
          `Malformed metric reference ${leftover} in ${key}; write it as <<metric:section.metric>> or <<metric:section.metric|period>> from the catalog, or remove it`,
        );
      }
    }
    return [key, text];
  });
  if (!referenced) {
    return Object.fromEntries(entries);
  }
  const metricSourceIds = [
    ...new Set([
      ...nonEmptyStringArrayValue(value.metricSourceIds),
      ...[...sourceIds].filter((id) => !citedIds.has(id)),
    ]),
  ];
  return {
    ...Object.fromEntries(entries),
    sourceIds: [...sourceIds],
    ...(metricSourceIds.length === 0 ? {} : { metricSourceIds }),
    ...(renderedMetrics.length === 0 ? {} : { renderedMetrics }),
  };
}

function transformNarrative<T extends ModelReportPayload>(
  payload: T,
  sections: readonly MetricSection[],
  resolve: boolean,
): T {
  const extras = isRecord(payload.extras) ? payload.extras : {};
  const narrative = {
    keyFindings: payload.keyFindings,
    bullCase: payload.bullCase,
    bearCase: payload.bearCase,
    risks: payload.risks,
    catalysts: payload.catalysts,
    scenarios: payload.scenarios,
    extras: {
      businessFramework: extras.businessFramework,
      earningsSetup: extras.earningsSetup,
      spotlights: extras.spotlights,
    },
  };
  const errors = hasMetricReference([payload.summary, payload.dataGaps, payload.predictions])
    ? [
        "Metric references require a cited narrative claim; summary, dataGaps and predictions cannot contain them",
      ]
    : [];
  if (!hasMetricReference(narrative)) {
    if (errors.length > 0) {
      throw new Error(errors[0]);
    }
    return payload;
  }
  const transformed = transformClaims(narrative, sections, resolve, errors) as typeof narrative;
  if (errors.length > 0) {
    throw new Error([...new Set(errors)].join("; "));
  }
  return { ...payload, ...transformed, extras: { ...extras, ...transformed.extras } };
}

const CODE_PROVENANCE_FIELDS = new Set(["metricSourceIds", "renderedMetrics"]);

function withoutCodeProvenance(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutCodeProvenance);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CODE_PROVENANCE_FIELDS.has(key))
      .map(([key, item]) => [key, withoutCodeProvenance(item)]),
  );
}

// Only code may set metricSourceIds and renderedMetrics: a draft's own copies would forge the exemption.
export function citeMetricReferences(
  payload: ModelReportPayload,
  sections: readonly MetricSection[],
): ModelReportPayload {
  return transformNarrative(withoutCodeProvenance(payload) as ModelReportPayload, sections, false);
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
  const path = metricReferencePath({ ...authoredAndDeterministic, extras: authoredExtras });
  if (path !== undefined) {
    throw new Error(
      `Unresolved metric reference in assembled report at ${path}; remove it or use a supported cited narrative claim`,
    );
  }
}
