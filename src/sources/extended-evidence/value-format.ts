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
  | "shares"
  | "reported-percent"
  | "text";

export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  USD: "$",
  GBP: "£",
  EUR: "€",
};

export const PE_NOT_MEANINGFUL = "N/M (non-positive earnings)";

// P/E on a loss or zero earnings is not meaningful, never a negative or huge multiple.
export function peIsClean(pe: number | undefined, eps: number | undefined): pe is number {
  return pe !== undefined && Number.isFinite(pe) && pe > 0 && (eps === undefined || eps > 0);
}

export function formatPeRatio(pe: number, eps?: number): string {
  return peIsClean(pe, eps) ? `${pe.toFixed(2)}x` : PE_NOT_MEANINGFUL;
}

// Each threshold sits where the tier below would round up to "1000.0".
const CURRENCY_TIERS = [
  { min: 999_950_000_000, unit: 1_000_000_000_000, suffix: "T", digits: 2 },
  { min: 999_950_000, unit: 1_000_000_000, suffix: "B", digits: 1 },
  { min: 999_950, unit: 1_000_000, suffix: "M", digits: 1 },
  { min: 999.5, unit: 1000, suffix: "K", digits: 1 },
] as const;

// The acquisition caveat cites goodwill, so a goodwill input marks a Phase whose growth spans an acquisition.
export function phaseLabel(
  phase: string,
  metric?: { readonly inputs: readonly { readonly series?: string }[] },
): string {
  return metric?.inputs.some((input) => input.series === "goodwill") === true
    ? `${phase} (reported growth spans an acquisition; organic growth not established)`
    : phase;
}

export function scaleCurrency(value: number): string {
  const tier = CURRENCY_TIERS.find(({ min }) => Math.abs(value) >= min);
  return tier ? `${(value / tier.unit).toFixed(tier.digits)}${tier.suffix}` : value.toFixed(0);
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
  // A percent quoted at its source's precision (FRED yields to 2 decimals), unlike whole-percent's fixed 1.
  if (unit === "reported-percent") {
    return `${clampRoundedZero(value, 2).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;
  }
  if (unit === "shares") {
    return Math.abs(value) >= 999_995
      ? `${(value / 1_000_000).toFixed(2)} million shares`
      : `${Math.round(value).toLocaleString("en-US")} shares`;
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

const PROVIDER_OBSERVATION = /^\d{4}-\d{2}-\d{2}T/u;

export function metricPeriodLabel(
  periodEnd: string,
  periodMonths?: number,
  sectionId?: string,
  inputs: readonly {
    readonly periodType?: string;
    readonly periodStart?: string;
    readonly periodEnd?: string;
  }[] = [],
  priceAsOf?: string,
): string {
  if (priceAsOf !== undefined && PROVIDER_OBSERVATION.test(periodEnd)) {
    return `Price as of ${priceAsOf}`;
  }
  const label = fundamentalsPeriodLabel(periodEnd, periodMonths, sectionId, inputs);
  return priceAsOf === undefined
    ? label
    : `Price as of ${priceAsOf}; fundamentals ${label.replace(/^(As of|Period)/u, (lead) => lead.toLowerCase())}`;
}

function fundamentalsPeriodLabel(
  periodEnd: string,
  periodMonths: number | undefined,
  sectionId: string | undefined,
  inputs: readonly {
    readonly periodType?: string;
    readonly periodStart?: string;
    readonly periodEnd?: string;
  }[],
): string {
  // Provider observations carry a full timestamp; a label names the date.
  const end = PROVIDER_OBSERVATION.test(periodEnd) ? periodEnd.slice(0, 10) : periodEnd;
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
  const spans = new Set(
    flows.map((input) => flowSpanLabel(input.periodStart ?? "", input.periodEnd ?? "")),
  );
  const [span] = spans;
  if (spans.size === 1 && span !== undefined) {
    return `${span} period ending ${end}`;
  }
  return periodMonths === undefined
    ? `Period ending ${end}`
    : `${String(periodMonths)}-month period ending ${end}`;
}

const DAYS_PER_MONTH = 30.4368;

// 52/53-week stubs (12, 16, 28, 40 weeks) sit 6+ days off whole months, so they name weeks.
export function flowSpanLabel(periodStart: string, periodEnd: string): string | undefined {
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000 + 1;
  const months = Math.round(days / DAYS_PER_MONTH);
  if (!Number.isFinite(days) || days <= 0 || Math.abs(days - months * DAYS_PER_MONTH) <= 3) {
    return undefined;
  }
  return days % 7 === 0 ? `${String(days / 7)}-week` : `${String(days)}-day`;
}
