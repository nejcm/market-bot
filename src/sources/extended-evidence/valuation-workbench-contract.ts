import type { ValuationCompsArtifact } from "./valuation-comps";

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
    readonly priceSelectionRule: "first verified close on or after publicAt";
    readonly observations: readonly HistoricalValuationObservation[];
    readonly trailingBasis: TrailingValuationBasis;
    readonly suppressionReasons: readonly string[];
  };
  readonly peerComparison: PeerValuationComparison;
  readonly sourceIds: readonly string[];
}
