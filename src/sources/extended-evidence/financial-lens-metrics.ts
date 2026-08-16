import type { InstrumentCommand } from "../../cli/args";
import { DAY_MS } from "../../config/shared";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
} from "../../domain/types";
import {
  canonicalFinancialLensDerivedMetric,
  type CanonicalDerivedMetricKey,
  type SecFactMetricKey,
  type SecMetricKey,
} from "./financial-lens-canonical";
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
export function readRawStringMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): string | undefined {
  const value = metrics?.[key];
  return typeof value === "string" ? value : undefined;
}

// Typed accessors for the sec-edgar item only: its keys are the compile-time union
// Written by financial-lens-canonical.ts and sec-edgar.ts.
// Untyped readers above stay string-keyed: valuation and Yahoo keys come elsewhere.
export function readSecMetric(
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

export function ratio(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  return numerator !== undefined && denominator !== undefined && denominator !== 0
    ? numerator / denominator
    : undefined;
}

function crossPeriodRatioLabel(
  label: string,
  item: ExtendedEvidenceItem | undefined,
  numeratorKey: SecFactMetricKey,
  denominatorKey: SecFactMetricKey,
  denominatorLabel: string,
): string {
  const numeratorEnd = readSecStringMetric(item?.metrics, `${numeratorKey}PeriodEnd`);
  const denominatorEnd = readSecStringMetric(item?.metrics, `${denominatorKey}PeriodEnd`);
  return numeratorEnd !== undefined &&
    denominatorEnd !== undefined &&
    numeratorEnd !== denominatorEnd
    ? `${label} (${denominatorLabel} at ${denominatorEnd})`
    : label;
}

export function selectedRatioLabel(
  label: string,
  item: ExtendedEvidenceItem | undefined,
  selectedKey: CanonicalDerivedMetricKey,
  numeratorKey: SecFactMetricKey,
  denominatorKey: SecFactMetricKey,
  denominatorLabel: string,
): string {
  return canonicalFinancialLensDerivedMetric(item, selectedKey) === undefined
    ? crossPeriodRatioLabel(label, item, numeratorKey, denominatorKey, denominatorLabel)
    : label;
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

// Annualizes a flow-fact value by its own reporting-period length (months),
// Matching valuation.ts revenue annualization. Undefined period -> already
// Annual (factor 1); period > 0 -> 12/period. Used for ROE/ROA/PCF so a 9-month
// 10-Q netIncome is scaled to a year before dividing by an instant balance, and
// Crucially uses netIncome's own periodMonths, not revenue's. See plan revision 2.
export function annualize(
  value: number | undefined,
  periodMonths: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const factor = periodMonths !== undefined && periodMonths > 0 ? 12 / periodMonths : 1;
  return value * factor;
}

export function positive(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}

export function atOrBelow(value: number | undefined, threshold: number): boolean | undefined {
  return value === undefined ? undefined : value <= threshold;
}

export function postureFrom(
  values: readonly (boolean | undefined)[],
  requiredCount = 1,
): FinancialLensPosture {
  const known = values.filter((value): value is boolean => value !== undefined);
  if (known.length < requiredCount || known.length === 0) {
    return "insufficient-data";
  }
  const supported = known.filter(Boolean).length;
  if (supported === known.length) {
    return "criteria-supported";
  }
  if (supported === 0) {
    return "criteria-not-supported";
  }
  return "criteria-mixed";
}

export function metric(
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

export function selectedDerivedPeriod(
  item: ExtendedEvidenceItem | undefined,
  key: CanonicalDerivedMetricKey,
  fallbackKey: SecFactMetricKey,
): Pick<FinancialLensMetric, "periodEnd" | "periodMonths"> {
  const selected = canonicalFinancialLensDerivedMetric(item, key);
  return selected === undefined
    ? secPeriod(item, fallbackKey)
    : {
        periodEnd: selected.periodEnd,
        ...(selected.periodMonths !== undefined ? { periodMonths: selected.periodMonths } : {}),
      };
}

export function observedPeriod(
  observedAt: string | undefined,
): Pick<FinancialLensMetric, "periodEnd"> {
  return observedAt === undefined ? {} : { periodEnd: observedAt };
}

export function valuationDateBasisMetric(
  valuationItem: ExtendedEvidenceItem | undefined,
): readonly FinancialLensMetric[] {
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
  const quoteDate = quoteObservedAt.slice(0, 10);
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
    `EV mixes market cap (quote ${quoteDate}) with cash/debt (balance sheet ${balanceSheetPeriodEnd})`,
    "text",
    valuationItem?.sourceIds ?? [],
    { periodEnd: balanceSheetPeriodEnd },
  );
}

export function percentChange(value: number | undefined): boolean | undefined {
  return value === undefined ? undefined : value > 0;
}
