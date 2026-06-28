import type { ResolvedRunParams, RunParams } from "../types";

export const EQUITY_MARKET_UPDATE_KIND_MIX = {
  favored: ["relative", "macro", "volatility"],
  minNonDirection: 1,
} as const;

export const CRYPTO_MARKET_UPDATE_KIND_MIX = {
  favored: ["relative", "range"],
  minNonDirection: 1,
} as const;

export const INSTRUMENT_KIND_MIX = {
  favored: ["relative", "range"],
  minNonDirection: 1,
} as const;

export const RESEARCH_KIND_MIX = {
  favored: ["range"],
} as const;

export const CODE_DEFAULTS: Omit<
  ResolvedRunParams,
  "quickModel" | "synthesisModel" | "modelParams"
> = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  targetPredictions: 2,
  defaultPredictionHorizon: 5,
  predictionSubjects: [
    "SPY",
    "QQQ",
    "^VIX",
    "DGS10",
    "DGS2",
    "T10Y2Y",
    "FEDFUNDS",
    "CPIAUCSL",
    "UNRATE",
    "DTWEXBGS",
  ],
  focus: ["market regime", "movers", "risks", "source gaps"],
  analystStyle: "concise brief",
  targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
};

export const INSTRUMENT_RUN_PARAMS: RunParams = {
  minimumKeyFindings: 4,
  minimumScenarios: 1,
  targetPredictions: 3,
  defaultPredictionHorizon: 5,
  analystStyle: "concise brief",
  focus: ["thesis", "evidence", "risks", "data gaps"],
  targetKindMix: INSTRUMENT_KIND_MIX,
  deep: {
    minimumKeyFindings: 6,
    minimumScenarios: 3,
    targetPredictions: 5,
    analystStyle: "fuller analyst-style",
    focus: ["thesis", "evidence", "catalysts", "bull case", "bear case", "scenarios", "data gaps"],
    targetKindMix: { ...INSTRUMENT_KIND_MIX, minNonDirection: 2 },
  },
};
