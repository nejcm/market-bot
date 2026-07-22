// Shared value/currency formatting for the financial-lens summary formatter
// (server) and the console tile renderer (client) so the two cannot drift.
// Sits alongside percent-format.ts which holds the percent conventions.

import { clampRoundedZero, formatRatioPercent, formatWholePercent } from "./percent-format";

export type LensValueUnit =
  | "ratio"
  | "ratio-percent"
  | "whole-percent"
  | "currency"
  | "number"
  | "text";

export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
};

export const PE_NOT_MEANINGFUL = "N/M (non-positive earnings)";

export function formatPeRatio(pe: number, eps: number | undefined): string {
  return pe <= 0 || (eps !== undefined && eps <= 0) ? PE_NOT_MEANINGFUL : `${pe.toFixed(2)}x`;
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

export function formatCurrency(value: number, currency = "USD"): string {
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
  return clampRoundedZero(value, 2).toFixed(2);
}
