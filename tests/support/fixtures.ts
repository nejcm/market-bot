import type { MarketSnapshot, Prediction, ResearchReport, Source } from "../../src/domain/types";
import type { PredictionScore } from "../../src/scoring/types";
import type { CollectedSources } from "../../src/sources/types";

const DEFAULT_OBSERVED_AT = "2026-05-19T00:00:00.000Z";

export function researchReport(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    runId: "run-1",
    jobType: "daily",
    assetClass: "equity",
    generatedAt: DEFAULT_OBSERVED_AT,
    summary: "",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [],
    notFinancialAdvice: true,
    ...overrides,
  };
}

export function prediction(overrides: Partial<Prediction> = {}): Prediction {
  return {
    id: "pred-1",
    claim: "SPY closes higher over 5 trading days.",
    kind: "direction",
    subject: "SPY",
    measurableAs: "close(SPY, +5) > close(SPY, 0)",
    horizonTradingDays: 5,
    probability: 0.65,
    sourceIds: [],
    ...overrides,
  };
}

export function marketSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    sourceId: "market-aapl",
    assetClass: "equity",
    symbol: "AAPL",
    price: 100,
    changePercent24h: 2,
    volume: 1_000_000,
    observedAt: DEFAULT_OBSERVED_AT,
    ...overrides,
  };
}

export function newsSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "news-equity-1",
    title: "equity update",
    fetchedAt: DEFAULT_OBSERVED_AT,
    kind: "news",
    assetClass: "equity",
    ...overrides,
  };
}

export function collectedSources(overrides: Partial<CollectedSources> = {}): CollectedSources {
  return {
    rawSnapshots: [],
    marketSnapshots: [],
    supplementalMarketSnapshots: [],
    newsSources: [],
    extendedSources: [],
    marketContextSources: [],
    sourceGaps: [],
    ...overrides,
  };
}

export function predictionScore(
  outcome: "hit" | "miss",
  overrides: Partial<PredictionScore> = {},
): PredictionScore {
  return {
    predictionId: "p",
    runId: "r",
    resolved: true,
    outcome,
    observedAt: DEFAULT_OBSERVED_AT,
    attemptCount: 1,
    evidence: {},
    ...overrides,
  };
}
