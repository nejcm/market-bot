import { formatLensValue } from "../../src/sources/extended-evidence/value-format";
import type {
  FinancialLensArtifact,
  FinancialLensMetric,
  FinancialLensName,
} from "../../src/sources/extended-evidence/financial-lens";
import { resolveMarketSnapshotPriceAsOf, type MarketSnapshot } from "../../src/domain/types";

export interface ValuationMetricTile {
  readonly label: string;
  readonly value: string;
}

export type FinancialLensStatTone = "strong" | "healthy" | "watch" | "weak" | "neutral";

export interface FinancialLensStatTile extends ValuationMetricTile {
  readonly key: string;
  readonly lens: FinancialLensName;
  readonly tone: FinancialLensStatTone;
  readonly assessment?: "Strong" | "Healthy" | "Watch" | "Weak";
  readonly caption?: string;
}

function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(0)}`;
}

function formatMultiple(value: number): string {
  return `${value.toFixed(1)}x`;
}

const VALUATION_METRIC_LABELS: Readonly<Record<string, string>> = {
  marketCap: "Market cap",
  enterpriseValue: "Enterprise value",
  annualizedRevenue: "Annualized revenue",
  evToAnnualizedRevenue: "EV / annualized revenue",
  revenuePeriodMonths: "Revenue period (months)",
  corePeerCount: "Core peers",
  peerMedianEvToAnnualizedRevenue: "Peer median EV / annualized revenue",
  peerP25EvToAnnualizedRevenue: "Peer P25 EV / annualized revenue",
  peerP75EvToAnnualizedRevenue: "Peer P75 EV / annualized revenue",
  valuationSupportability: "Supportability",
};

export function valuationMetricTiles(
  metrics: Readonly<Record<string, number | string>> | undefined,
): readonly ValuationMetricTile[] {
  if (metrics === undefined) {
    return [];
  }

  const keys = [
    "marketCap",
    "enterpriseValue",
    "annualizedRevenue",
    "evToAnnualizedRevenue",
    "revenuePeriodMonths",
    "corePeerCount",
    "peerMedianEvToAnnualizedRevenue",
    "peerP25EvToAnnualizedRevenue",
    "peerP75EvToAnnualizedRevenue",
    "valuationSupportability",
  ] as const;

  return keys.flatMap((key) => {
    const raw = metrics[key];
    const label = VALUATION_METRIC_LABELS[key] ?? key;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      if (
        key === "evToAnnualizedRevenue" ||
        key === "peerMedianEvToAnnualizedRevenue" ||
        key === "peerP25EvToAnnualizedRevenue" ||
        key === "peerP75EvToAnnualizedRevenue"
      ) {
        return [{ label, value: formatMultiple(raw) }];
      }
      if (key === "revenuePeriodMonths" || key === "corePeerCount") {
        return [{ label, value: String(raw) }];
      }
      return [{ label, value: formatUsdCompact(raw) }];
    }
    if (key === "valuationSupportability" && typeof raw === "string") {
      return [{ label, value: raw }];
    }
    return [];
  });
}

function formatPosture(value: string): string {
  return value.replaceAll("-", " ");
}

// Renders financial-lens tiles dynamically from the structured artifact's
// Lenses[].metrics[] (label/value/unit) instead of a hardcoded key list. For each
// Lens a posture tile is emitted first, then every metric the artifact carries,
// Formatted via the shared value-format module so server summary and client tiles
// Stay identical. Metrics absent from the artifact are absent from the grid
// (sparse for non-US, rich for US). See plan Q7 / revision 5.
export function financialLensMetricTiles(
  artifact?: FinancialLensArtifact,
): readonly ValuationMetricTile[] {
  if (artifact === undefined) {
    return [];
  }
  return artifact.lenses.flatMap((lens) => {
    const postureTile: ValuationMetricTile = {
      label: lens.name,
      value: formatPosture(lens.posture),
    };
    const metricTiles = lens.metrics.map((metric): ValuationMetricTile => {
      const value =
        typeof metric.value === "string"
          ? metric.value
          : formatLensValue(metric.value, metric.unit, metric.currency);
      return { label: metric.label, value };
    });
    return [postureTile, ...metricTiles];
  });
}

function assessment(
  value: number,
  strong: (input: number) => boolean,
  healthy: (input: number) => boolean,
  watch: (input: number) => boolean,
): Pick<FinancialLensStatTile, "tone" | "assessment"> {
  if (strong(value)) {
    return { tone: "strong", assessment: "Strong" };
  }
  if (healthy(value)) {
    return { tone: "healthy", assessment: "Healthy" };
  }
  if (watch(value)) {
    return { tone: "watch", assessment: "Watch" };
  }
  return { tone: "weak", assessment: "Weak" };
}

function assessFinancialLensMetric(
  metric: FinancialLensMetric,
): Pick<FinancialLensStatTile, "tone" | "assessment"> {
  const { key, value: rawValue } = metric;
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    if (key === "valuationSupportability") {
      if (rawValue === "supported") {
        return { tone: "strong", assessment: "Strong" };
      }
      if (rawValue === "screening-only") {
        return { tone: "watch", assessment: "Watch" };
      }
      if (rawValue === "not-supportable") {
        return { tone: "weak", assessment: "Weak" };
      }
    }
    return { tone: "neutral" };
  }

  switch (key) {
    case "grossMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.4,
        (v) => v >= 0.3,
        (v) => v >= 0.2,
      );
    }
    case "operatingMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.15,
        (v) => v >= 0.1,
        (v) => v >= 0.05,
      );
    }
    case "netMargin": {
      return assessment(
        rawValue,
        (v) => v >= 0.1,
        (v) => v >= 0.06,
        (v) => v >= 0.03,
      );
    }
    case "cashConversion": {
      return assessment(
        rawValue,
        (v) => v >= 1,
        (v) => v >= 0.75,
        (v) => v >= 0.5,
      );
    }
    case "revenueDeltaPercent":
    case "grossProfitDeltaPercent":
    case "operatingIncomeDeltaPercent":
    case "netIncomeDeltaPercent":
    case "dilutedEpsDeltaPercent":
    case "operatingCashFlowDeltaPercent": {
      return assessment(
        rawValue,
        (v) => v >= 10,
        (v) => v >= 3,
        (v) => v >= 0,
      );
    }
    case "debtToMarketCap":
    case "netDebtToMarketCap": {
      return assessment(
        rawValue,
        (v) => v <= 0.25,
        (v) => v <= 0.4,
        (v) => v <= 0.5,
      );
    }
    case "currentRatio": {
      return assessment(
        rawValue,
        (v) => v >= 1.5 && v <= 3,
        (v) => v >= 1.2 && v <= 4,
        (v) => v >= 1 && v <= 4,
      );
    }
    case "payoutRatio": {
      return assessment(
        rawValue,
        (v) => v >= 0 && v <= 0.6,
        (v) => v >= 0 && v <= 0.75,
        (v) => v >= 0 && v <= 0.8,
      );
    }
    case "rsi14": {
      return assessment(
        rawValue,
        (v) => v >= 40 && v <= 70,
        (v) => (v >= 30 && v < 40) || (v > 70 && v <= 80),
        (v) => (v >= 20 && v < 30) || (v > 80 && v <= 90),
      );
    }
    case "macdHistogram": {
      return assessment(
        rawValue,
        (v) => v >= 0,
        (v) => v > -0.25,
        (v) => v > -0.5,
      );
    }
    default: {
      return { tone: "neutral" };
    }
  }
}

function financialLensSourceLabel(sourceIds: readonly string[]): string | undefined {
  const hasSec = sourceIds.some((sourceId) => sourceId.includes("sec-edgar"));
  const hasYahoo = sourceIds.some((sourceId) => sourceId.includes("yahoo"));
  const hasVerifiedSnapshot = sourceIds.some((sourceId) =>
    sourceId.startsWith("verified-snapshot-"),
  );
  if (hasSec && hasYahoo) {
    return "SEC EDGAR + Yahoo quote";
  }
  if (hasSec) {
    return "SEC EDGAR";
  }
  if (hasYahoo) {
    return "Yahoo quote";
  }
  if (hasVerifiedSnapshot) {
    return "Verified market snapshot";
  }
  return undefined;
}

function financialLensMetricCaption(
  metric: FinancialLensMetric,
  marketSnapshots: readonly MarketSnapshot[],
): string | undefined {
  const source = financialLensSourceLabel(metric.sourceIds);
  if (source === undefined) {
    return undefined;
  }
  if (metric.periodEnd === undefined) {
    return source;
  }
  const date = metric.periodEnd.slice(0, 10);
  if (metric.periodMonths === undefined) {
    const marketSnapshot = marketSnapshots.find((snapshot) =>
      metric.sourceIds.includes(snapshot.sourceId),
    );
    if (marketSnapshot !== undefined) {
      const priceAsOf = resolveMarketSnapshotPriceAsOf(marketSnapshot);
      return `${source} · ${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
    }
    if (metric.sourceIds.some((sourceId) => sourceId.includes("yahoo"))) {
      return `${source} · fetch time ${metric.periodEnd}`;
    }
    return `${source} · observed ${date}`;
  }
  const period = metric.periodMonths === 12 ? "FY" : `${String(metric.periodMonths)}M`;
  return `${source} · ${period} period ended ${date}`;
}

export function financialLensStatTiles(
  artifact?: FinancialLensArtifact,
  marketSnapshots: readonly MarketSnapshot[] = [],
): readonly FinancialLensStatTile[] {
  if (artifact === undefined) {
    return [];
  }
  return artifact.lenses.flatMap((lens) =>
    lens.metrics.map((metric): FinancialLensStatTile => {
      const value =
        typeof metric.value === "string"
          ? metric.value
          : formatLensValue(metric.value, metric.unit, metric.currency);
      const caption = financialLensMetricCaption(metric, marketSnapshots);
      return {
        key: metric.key,
        lens: lens.name,
        label: metric.label,
        value,
        ...assessFinancialLensMetric(metric),
        ...(caption !== undefined ? { caption } : {}),
      };
    }),
  );
}
