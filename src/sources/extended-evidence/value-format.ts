// Shared value/currency formatting for the financial-lens summary formatter
// (server) and the console tile renderer (client) so the two cannot drift.
// Sits alongside percent-format.ts which holds the percent conventions.

import { clampRoundedZero, formatRatioPercent, formatWholePercent } from "./percent-format";

export type LensValueUnit =
  | "ratio"
  | "ratio-percent"
  | "whole-percent"
  | "currency"
  | "currency-per-share"
  | "number"
  | "text";

export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
};

export const PE_NOT_MEANINGFUL = "N/M (non-positive earnings)";
export const PE_NEGATIVE_CAVEAT = "negative earnings";

// A negative P/E is a real, computable figure (price over a forecast/trailing loss)
// And its sign is genuine signal, so it is shown rather than hidden. Its *magnitude*
// Is misleading — non-monotonic in the loss, so a tiny loss yields a huge multiple —
// Hence the caveat, so it is not read as a normal multiple. Only a genuinely
// Non-computable ratio (zero or non-finite earnings) collapses to N/M.
export function formatPeRatio(pe: number, eps?: number): string {
  if (!Number.isFinite(pe) || eps === 0) {
    return PE_NOT_MEANINGFUL;
  }
  if (pe < 0 || (eps !== undefined && eps < 0)) {
    return `${pe.toFixed(2)}x (${PE_NEGATIVE_CAVEAT})`;
  }
  if (pe === 0) {
    return PE_NOT_MEANINGFUL;
  }
  return `${pe.toFixed(2)}x`;
}

export function scaleCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toFixed(0);
}

function formatCurrency(value: number, currency = "USD"): string {
  // GBp is Yahoo's pence pseudo-code (not ISO 4217 GBP): render with a p suffix, no K/M/B scaling.
  if (currency === "GBp") {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}p`;
  }
  const symbol = CURRENCY_SYMBOLS[currency];
  if (symbol !== undefined) {
    return `${symbol}${scaleCurrency(value)}`;
  }
  return `${currency} ${scaleCurrency(value)}`;
}

// Formats a numeric lens value by its unit. String values are handled by the
// Caller (text metrics pass through unchanged). This is the single dispatch
// Used by both the server-side summary and the client tile renderer.
export function formatLensValue(value: number, unit: LensValueUnit, currency?: string): string {
  if (unit === "ratio-percent") {
    return formatRatioPercent(value);
  }
  if (unit === "whole-percent") {
    return formatWholePercent(value);
  }
  if (unit === "ratio") {
    return `${clampRoundedZero(value, 2).toFixed(2)}x`;
  }
  if (unit === "currency") {
    return formatCurrency(value, currency);
  }
  if (unit === "currency-per-share") {
    const amount = clampRoundedZero(value, 2).toFixed(2);
    const code = currency ?? "USD";
    const symbol = CURRENCY_SYMBOLS[code];
    return symbol === undefined ? `${code} ${amount}` : `${symbol}${amount}`;
  }
  return clampRoundedZero(value, 2).toFixed(2);
}

// One Metric Section display for report.md and the Console; undefined means nothing to show.
export function formatMetricValue(
  value: number | string | undefined,
  unit: LensValueUnit | undefined,
  currency?: string,
): string | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  return value === undefined || !Number.isFinite(value) || unit === undefined
    ? undefined
    : formatLensValue(value, unit, currency);
}

export function metricPeriodLabel(
  periodEnd: string,
  periodMonths?: number,
  sectionId?: string,
  inputs: readonly {
    readonly periodType?: string;
    readonly periodStart?: string;
    readonly periodEnd?: string;
  }[] = [],
): string {
  // Provider observations carry a full timestamp; a label names the date.
  const end = /^\d{4}-\d{2}-\d{2}T/u.test(periodEnd) ? periodEnd.slice(0, 10) : periodEnd;
  if (sectionId === "price-performance") {
    return `Session ending ${end}`;
  }
  const flows = inputs.filter(
    (input) =>
      input.periodStart !== undefined &&
      (input.periodType === "annual" || input.periodType === "interim"),
  );
  if (flows.length === 0) {
    // Summary sidecars date a flow by end and length only; a known length still names the span.
    return periodMonths === undefined
      ? `As of ${end}`
      : `${String(periodMonths)}-month period ending ${end}`;
  }
  const annual = flows.every((input) => {
    const days =
      (Date.parse(input.periodEnd ?? "") - Date.parse(input.periodStart ?? "")) / 86_400_000;
    return input.periodType === "annual" && days >= 350 && days <= 380;
  });
  if (annual) {
    return `FY ending ${end}`;
  }
  return periodMonths === undefined
    ? `Period ending ${end}`
    : `${String(periodMonths)}-month period ending ${end}`;
}
