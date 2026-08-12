import type { ValuationCompsArtifact } from "./valuation-comps";
import { isRecord, readNumber, readString, readStringArray } from "../../guards";

export const VALUATION_METRIC_KEYS = [
  "priceToEarnings",
  "priceToSales",
  "enterpriseValueToRevenue",
  "priceToFreeCashFlow",
] as const;

export type ValuationMetricKey = (typeof VALUATION_METRIC_KEYS)[number];

export type ValuationObservationBasis = "annual" | "ttm";

export type ValuationMetricSuppressionReason =
  | "price-history-unavailable"
  | "quote-currency-unavailable"
  | "reporting-currency-unavailable"
  | "quote-reporting-currency-mismatch"
  | "earnings-unavailable"
  | "revenue-unavailable"
  | "free-cash-flow-unavailable"
  | "diluted-shares-unavailable"
  | "numerator-unavailable"
  | "cash-unavailable"
  | "debt-unavailable";

export type ValuationMetricNotMeaningfulReason =
  | "negative-denominator"
  | "zero-denominator"
  | "non-finite-denominator";

export interface ValuationFundamentalInput {
  readonly value: number;
  readonly label: string;
  readonly periodEnd: string;
  readonly publicAt: string;
  readonly currency: string | null;
  readonly unit: string;
  readonly sourceIds: readonly string[];
  readonly derivation?: string;
}

export interface ValuationPriceInput {
  readonly close: number;
  readonly sessionDate: string;
  readonly currency: string;
  readonly sourceId: string;
}

export type ValuationMetricResult =
  | {
      readonly status: "populated";
      readonly value: number;
      readonly display: string;
      readonly numerator: number;
      readonly denominator: number;
      readonly formula: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly status: "not-meaningful";
      readonly display: "N/M";
      readonly reason: ValuationMetricNotMeaningfulReason;
      readonly denominator: number;
      readonly formula: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly status: "suppressed";
      readonly display: "—";
      readonly reason: ValuationMetricSuppressionReason;
      readonly detail: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly status: "not-applicable";
      readonly display: "not applicable";
      readonly rule: string;
      readonly inputs: Readonly<Record<string, number | string>>;
      readonly rationale: string;
      readonly sourceIds: readonly string[];
    };

export interface HistoricalValuationObservation {
  readonly basis: ValuationObservationBasis;
  readonly periodEnd: string;
  readonly publicAt: string;
  readonly price: ValuationPriceInput | null;
  readonly inputs: {
    readonly revenue?: ValuationFundamentalInput;
    readonly netIncome?: ValuationFundamentalInput;
    readonly dilutedEps?: ValuationFundamentalInput;
    readonly dilutedShares?: ValuationFundamentalInput;
    readonly freeCashFlow?: ValuationFundamentalInput;
    readonly cash?: ValuationFundamentalInput;
    readonly debt?: ValuationFundamentalInput;
  };
  readonly metrics: Readonly<Record<ValuationMetricKey, ValuationMetricResult>>;
  readonly sourceIds: readonly string[];
}

export type TrailingValuationBasis =
  | {
      readonly status: "available";
      readonly periodEnd: string;
      readonly publicAt: string;
      readonly sourceIds: readonly string[];
    }
  | {
      readonly status: "suppressed";
      readonly reason: "canonical-ttm-unavailable";
      readonly detail: string;
      readonly sourceIds: readonly string[];
    };

export type PeerValuationComparison =
  | {
      readonly status: "available";
      readonly valuationComps: ValuationCompsArtifact;
    }
  | {
      readonly status: "suppressed";
      readonly reason: "peer-data-unavailable";
      readonly detail: string;
      readonly sourceIds: readonly string[];
    };

export interface ValuationWorkbenchArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly analysisAsOf: string;
  readonly symbol: string;
  readonly reportingCurrency: string | null;
  readonly quoteCurrency: string | null;
  readonly historicalMultiples: {
    readonly priceSelectionRule: "first verified close within 7 calendar days on or after publicAt";
    readonly observations: readonly HistoricalValuationObservation[];
    readonly trailingBasis: TrailingValuationBasis;
    readonly suppressionReasons: readonly string[];
  };
  readonly peerComparison: PeerValuationComparison;
  readonly sourceIds: readonly string[];
}

const METRIC_SUPPRESSION_REASONS = new Set<ValuationMetricSuppressionReason>([
  "price-history-unavailable",
  "quote-currency-unavailable",
  "reporting-currency-unavailable",
  "quote-reporting-currency-mismatch",
  "earnings-unavailable",
  "revenue-unavailable",
  "free-cash-flow-unavailable",
  "diluted-shares-unavailable",
  "numerator-unavailable",
  "cash-unavailable",
  "debt-unavailable",
]);

const NOT_MEANINGFUL_REASONS = new Set<ValuationMetricNotMeaningfulReason>([
  "negative-denominator",
  "zero-denominator",
  "non-finite-denominator",
]);

function hasFundamentalInputShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "value") !== undefined &&
    readString(value, "label") !== undefined &&
    readString(value, "periodEnd") !== undefined &&
    readString(value, "publicAt") !== undefined &&
    (value.currency === null || readString(value, "currency") !== undefined) &&
    readString(value, "unit") !== undefined &&
    readStringArray(value, "sourceIds") !== undefined &&
    (value.derivation === undefined || readString(value, "derivation") !== undefined)
  );
}

function hasPriceInputShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    readNumber(value, "close") !== undefined &&
    readString(value, "sessionDate") !== undefined &&
    readString(value, "currency") !== undefined &&
    readString(value, "sourceId") !== undefined
  );
}

function hasMetricResultShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const sourceIds = readStringArray(value, "sourceIds");
  if (sourceIds === undefined) {
    return false;
  }
  if (value.status === "populated") {
    return (
      readNumber(value, "value") !== undefined &&
      readString(value, "display") !== undefined &&
      readNumber(value, "numerator") !== undefined &&
      readNumber(value, "denominator") !== undefined &&
      readString(value, "formula") !== undefined
    );
  }
  if (value.status === "not-meaningful") {
    return (
      value.display === "N/M" &&
      NOT_MEANINGFUL_REASONS.has(value.reason as ValuationMetricNotMeaningfulReason) &&
      typeof value.denominator === "number" &&
      readString(value, "formula") !== undefined
    );
  }
  if (value.status === "suppressed") {
    return (
      value.display === "—" &&
      METRIC_SUPPRESSION_REASONS.has(value.reason as ValuationMetricSuppressionReason) &&
      readString(value, "detail") !== undefined
    );
  }
  if (value.status === "not-applicable") {
    return (
      value.display === "not applicable" &&
      readString(value, "rule") !== undefined &&
      isRecord(value.inputs) &&
      Object.values(value.inputs).every(
        (input) => typeof input === "number" || typeof input === "string",
      ) &&
      readString(value, "rationale") !== undefined &&
      sourceIds.length > 0
    );
  }
  return false;
}

function hasObservationShape(value: unknown): boolean {
  const metrics = isRecord(value) && isRecord(value.metrics) ? value.metrics : undefined;
  if (
    !isRecord(value) ||
    (value.basis !== "annual" && value.basis !== "ttm") ||
    readString(value, "periodEnd") === undefined ||
    readString(value, "publicAt") === undefined ||
    (value.price !== null && !hasPriceInputShape(value.price)) ||
    !isRecord(value.inputs) ||
    metrics === undefined ||
    readStringArray(value, "sourceIds") === undefined
  ) {
    return false;
  }
  const inputsValid = Object.values(value.inputs).every((input) => hasFundamentalInputShape(input));
  return inputsValid && VALUATION_METRIC_KEYS.every((key) => hasMetricResultShape(metrics[key]));
}

function hasTrailingBasisShape(value: unknown): boolean {
  if (!isRecord(value) || readStringArray(value, "sourceIds") === undefined) {
    return false;
  }
  return value.status === "available"
    ? readString(value, "periodEnd") !== undefined && readString(value, "publicAt") !== undefined
    : value.status === "suppressed" &&
        value.reason === "canonical-ttm-unavailable" &&
        readString(value, "detail") !== undefined;
}

function hasPeerComparisonShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === "suppressed") {
    return (
      value.reason === "peer-data-unavailable" &&
      readString(value, "detail") !== undefined &&
      readStringArray(value, "sourceIds") !== undefined
    );
  }
  if (value.status !== "available" || !isRecord(value.valuationComps)) {
    return false;
  }
  const comps = value.valuationComps;
  return (
    comps.version === 1 &&
    readString(comps, "generatedAt") !== undefined &&
    isRecord(comps.target) &&
    Array.isArray(comps.peers) &&
    Array.isArray(comps.excludedPeers) &&
    isRecord(comps.summary) &&
    readStringArray(comps, "sourceIds") !== undefined
  );
}

export function readValuationWorkbenchArtifact(
  value: unknown,
): ValuationWorkbenchArtifact | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "generatedAt") === undefined ||
    readString(value, "analysisAsOf") === undefined ||
    readString(value, "symbol") === undefined ||
    (value.reportingCurrency !== null && readString(value, "reportingCurrency") === undefined) ||
    (value.quoteCurrency !== null && readString(value, "quoteCurrency") === undefined) ||
    !isRecord(value.historicalMultiples) ||
    value.historicalMultiples.priceSelectionRule !==
      "first verified close within 7 calendar days on or after publicAt" ||
    !Array.isArray(value.historicalMultiples.observations) ||
    !value.historicalMultiples.observations.every(hasObservationShape) ||
    !hasTrailingBasisShape(value.historicalMultiples.trailingBasis) ||
    readStringArray(value.historicalMultiples, "suppressionReasons") === undefined ||
    !hasPeerComparisonShape(value.peerComparison) ||
    readStringArray(value, "sourceIds") === undefined
  ) {
    return undefined;
  }
  return value as unknown as ValuationWorkbenchArtifact;
}
