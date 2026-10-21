import type { ResearchReport } from "../domain/report";
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
const REFERENCE_START = /(?:<<|\{\{)\s*metric\s*:/iu;
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
  ): MetricResult => ({
    id,
    label,
    unit,
    basis,
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
  const label = metricPeriodLabel(metric.periodEnd, metric.periodMonths, sectionId, metric.inputs);
  return `${value} (${label.replace(/^[A-Z](?=[a-z])/u, (letter) => letter.toLowerCase())})`;
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

function hasMetricReference(value: unknown): boolean {
  if (typeof value === "string") {
    return REFERENCE_START.test(value);
  }
  return Array.isArray(value)
    ? value.some((item) => hasMetricReference(item))
    : isRecord(value) && Object.values(value).some((item) => hasMetricReference(item));
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
      const [reference = "", format, ...extra] = captured.split("|").map((part) => part.trim());
      const dot = reference.lastIndexOf(".");
      if (dot <= 0 || dot === reference.length - 1 || extra.length > 0 || format === "") {
        throw new Error(`Malformed metric reference ${token}`);
      }
      const sectionId = reference.slice(0, dot);
      const metric = sections
        .find(({ id }) => id === sectionId)
        ?.metrics.find(({ id }) => id === reference.slice(dot + 1));
      const rendered =
        metric?.status === "value"
          ? formatMetricValue(metric.value, metric.unit, metric.currency)
          : undefined;
      if (rendered === undefined || metric === undefined || metric.sourceIds.length === 0) {
        throw new Error(
          `Metric reference ${token} is unknown, unavailable, or unciteable; remove it or use an available metric reference`,
        );
      }
      const formatted =
        format === undefined
          ? rendered
          : withFormat(rendered, metric, sectionId, format.toLowerCase());
      if (formatted === undefined) {
        throw new Error(
          `Metric reference ${token} has an unsupported format; use |period only on a metric with a period, or the bare reference`,
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
