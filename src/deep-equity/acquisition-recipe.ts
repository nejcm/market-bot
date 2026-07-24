import type { EvidenceLane } from "../research/source-plan";

export type DeepEquityAcquisitionPhase = "target" | "parallel-provider" | "dependent" | "derive";

export type DeepEquityAcquisitionExecutor =
  | "yahoo-target"
  | "supplemental-market"
  | "news"
  | "verified-price-history"
  | "sec-target-packet"
  | "finnhub-packet"
  | "fred-packet"
  | "tradier-packet"
  | "target-valuation"
  | "peer-packets"
  | "adaptive-web"
  | "deterministic-derivations";

export interface DeepEquityAcquisitionTask {
  readonly id: string;
  readonly phase: DeepEquityAcquisitionPhase;
  readonly execute: DeepEquityAcquisitionExecutor;
  readonly sourcePlanLane?: EvidenceLane;
}

export const DEEP_EQUITY_ACQUISITION_RECIPE: readonly DeepEquityAcquisitionTask[] = [
  {
    id: "target-yahoo-quote-identity",
    phase: "target",
    execute: "yahoo-target",
    sourcePlanLane: "market-data",
  },
  {
    id: "supplemental-market-packet",
    phase: "parallel-provider",
    execute: "supplemental-market",
    sourcePlanLane: "supplemental-market",
  },
  {
    id: "news-packet",
    phase: "parallel-provider",
    execute: "news",
    sourcePlanLane: "news",
  },
  {
    id: "verified-price-packet",
    phase: "parallel-provider",
    execute: "verified-price-history",
    sourcePlanLane: "verified-price-history",
  },
  {
    id: "sec-target-packet",
    phase: "parallel-provider",
    execute: "sec-target-packet",
    sourcePlanLane: "regulatory-filings",
  },
  {
    id: "finnhub-provider-packet",
    phase: "parallel-provider",
    execute: "finnhub-packet",
    sourcePlanLane: "corporate-events",
  },
  {
    id: "fred-provider-packet",
    phase: "parallel-provider",
    execute: "fred-packet",
    sourcePlanLane: "macro-indicators",
  },
  {
    id: "tradier-provider-packet",
    phase: "parallel-provider",
    execute: "tradier-packet",
    sourcePlanLane: "derivatives-volatility",
  },
  {
    id: "target-valuation-inputs",
    phase: "derive",
    execute: "target-valuation",
    sourcePlanLane: "target-valuation",
  },
  {
    id: "peer-provider-packets",
    phase: "dependent",
    execute: "peer-packets",
    sourcePlanLane: "peer-valuation",
  },
  {
    id: "adaptive-web-batch",
    phase: "dependent",
    execute: "adaptive-web",
    sourcePlanLane: "subject-profile",
  },
  {
    id: "deterministic-derived-views",
    phase: "derive",
    execute: "deterministic-derivations",
  },
];

export function deepEquityRecipeLanes(): ReadonlySet<EvidenceLane> {
  return new Set(
    DEEP_EQUITY_ACQUISITION_RECIPE.flatMap((task) =>
      task.sourcePlanLane === undefined ? [] : [task.sourcePlanLane],
    ),
  );
}

export function hasDeepEquityAcquisitionTask(execute: DeepEquityAcquisitionExecutor): boolean {
  return DEEP_EQUITY_ACQUISITION_RECIPE.some((task) => task.execute === execute);
}
