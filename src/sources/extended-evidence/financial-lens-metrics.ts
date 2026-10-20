import type { InstrumentCommand } from "../../cli/args";
import { DAY_MS } from "../../config/shared";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../domain/evidence";
import {
  marketCapQuotePhrase,
  type MarketSnapshot,
  type MarketSnapshotPriceAsOf,
} from "../../domain/market-data";
import type { SourceGap } from "../../domain/sources";
import { type SecFactMetricKey, type SecMetricKey } from "./financial-lens-canonical";
import { MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS } from "./valuation-comps";
import { readNumberMetric } from "./utils";
import { formatPeRatio, type LensValueUnit } from "./value-format";

export type FinancialLensName = "Quality" | "Growth" | "Financial Strength" | "Value" | "Momentum";

export type FinancialLensPosture =
  | "criteria-supported"
  | "criteria-mixed"
  | "criteria-not-supported"
  | "insufficient-data";

export interface FinancialLensMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  // "ratio-percent": value is a ratio (0.42 → 42%). "whole-percent": value already in percent (12 → 12%).
  // "currency": monetary value in `currency` (defaults to USD); GBp is a Yahoo pence pseudo-code.
  readonly unit: LensValueUnit;
  readonly sourceIds: readonly string[];
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

export interface FinancialLens {
  readonly name: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly metrics: readonly FinancialLensMetric[];
  readonly sourceIds: readonly string[];
  readonly currentStatus?: "current" | "partial";
  readonly currentStatusReasonCodes?: readonly string[];
}

export interface FinancialLensArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly lenses: readonly FinancialLens[];
  readonly sourceIds: readonly string[];
}

export interface FinancialLensResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: FinancialLensArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

const SEC_KEYS: readonly SecFactMetricKey[] = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "cash",
  "debt",
  "currentAssets",
  "currentLiabilities",
] as const;

// No trim guard, unlike utils.readStringMetric: SEC period-end strings pass through verbatim.
function readRawStringMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): string | undefined {
  const value = metrics?.[key];
  return typeof value === "string" ? value : undefined;
}

function readSecMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: SecMetricKey,
): number | undefined {
  return readNumberMetric(metrics, key);
}

function readSecStringMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: SecMetricKey,
): string | undefined {
  return readRawStringMetric(metrics, key);
}

export function secScope(
  item: ExtendedEvidenceItem | undefined,
  key: SecFactMetricKey,
): string | undefined {
  return readSecStringMetric(item?.metrics, `${key}Scope`);
}

export function tickerSnapshot(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
): MarketSnapshot | undefined {
  const symbol = command.symbol.toUpperCase();
  return marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

export function itemByCategory(
  extendedEvidence: ExtendedEvidence | undefined,
  category: ExtendedEvidenceItem["category"],
): ExtendedEvidenceItem | undefined {
  return extendedEvidence?.items.find((item) => item.category === category);
}

export function secFundamentalItem(
  extendedEvidence: ExtendedEvidence | undefined,
): ExtendedEvidenceItem | undefined {
  const items = extendedEvidence?.items.filter((item) => item.category === "sec-edgar") ?? [];
  return items.find((item) =>
    SEC_KEYS.some((key) => readSecMetric(item.metrics, key) !== undefined),
  );
}

// A P/E is "clean" (shown as a numeric multiple) only when it is a finite, positive
// Ratio over positive earnings. Negative or non-computable P/Es render as annotated
// Text via formatPeRatio instead of a bare multiple. See PE_NEGATIVE_CAVEAT rationale.
export function peIsClean(pe: number | undefined, eps: number | undefined): boolean {
  return (
    pe !== undefined && Number.isFinite(pe) && pe > 0 && eps !== 0 && (eps === undefined || eps > 0)
  );
}

// Metric value for a P/E cell: the bare number when clean (rendered as a multiple),
// Otherwise the annotated formatPeRatio text (negative value + caveat, or N/M), and
// Undefined when absent so the metric is omitted entirely.
export function peMetricValue(
  pe: number | undefined,
  eps: number | undefined,
  clean: boolean,
): number | string | undefined {
  if (pe === undefined) {
    return undefined;
  }
  return clean ? pe : formatPeRatio(pe, eps);
}

function metric(
  key: string,
  label: string,
  value: number | string | undefined,
  unit: FinancialLensMetric["unit"],
  sourceIds: readonly string[],
  metadata: Pick<FinancialLensMetric, "currency" | "periodEnd" | "periodMonths"> = {},
): readonly FinancialLensMetric[] {
  return value === undefined ? [] : [{ key, label, value, unit, sourceIds, ...metadata }];
}

export function secPeriod(
  item: ExtendedEvidenceItem | undefined,
  key: SecFactMetricKey,
): Pick<FinancialLensMetric, "periodEnd" | "periodMonths"> {
  const periodEnd = readSecStringMetric(item?.metrics, `${key}PeriodEnd`);
  const periodMonths = readSecMetric(item?.metrics, `${key}PeriodMonths`);
  return {
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    ...(periodMonths !== undefined ? { periodMonths } : {}),
  };
}

export function valuationDateBasisMetric(
  valuationItem: ExtendedEvidenceItem | undefined,
): readonly FinancialLensMetric[] {
  const quoteTimeUtc = readRawStringMetric(valuationItem?.metrics, "quoteTimeUtc");
  const quoteObservedAt = readRawStringMetric(valuationItem?.metrics, "quoteObservedAt");
  const cashPeriodEnd = readRawStringMetric(valuationItem?.metrics, "cashPeriodEnd");
  const debtPeriodEnd = readRawStringMetric(valuationItem?.metrics, "debtPeriodEnd");
  const balanceSheetPeriodEnd =
    cashPeriodEnd === debtPeriodEnd
      ? cashPeriodEnd
      : [cashPeriodEnd, debtPeriodEnd]
          .filter((value): value is string => value !== undefined)
          .toSorted()[0];
  if (quoteObservedAt === undefined || balanceSheetPeriodEnd === undefined) {
    return [];
  }
  const priceAsOf: MarketSnapshotPriceAsOf =
    quoteTimeUtc === undefined
      ? { kind: "fetch-time-only", instant: quoteObservedAt }
      : { kind: "quote-time", instant: quoteTimeUtc };
  const quoteDate = priceAsOf.instant.slice(0, 10);
  const divergenceDays =
    Math.abs(Date.parse(quoteDate) - Date.parse(balanceSheetPeriodEnd)) / DAY_MS;
  if (
    !Number.isFinite(divergenceDays) ||
    divergenceDays <= MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS
  ) {
    return [];
  }
  return metric(
    "evDateBasis",
    "EV date basis",
    `EV mixes ${marketCapQuotePhrase(priceAsOf)} with cash/debt (balance sheet ${balanceSheetPeriodEnd})`,
    "text",
    valuationItem?.sourceIds ?? [],
    { periodEnd: balanceSheetPeriodEnd },
  );
}
