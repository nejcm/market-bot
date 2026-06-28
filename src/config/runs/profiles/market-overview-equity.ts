import type { RunParams } from "../types";
import { EQUITY_MARKET_UPDATE_KIND_MIX } from "./shared";

export const marketOverviewEquityProfile: RunParams = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  targetPredictions: 2,
  defaultPredictionHorizon: 15,
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
  analystStyle: "concise brief",
  focus: ["market regime", "movers", "narratives", "catalysts", "risks", "source gaps"],
  targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
  deep: {
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 3,
    analystStyle: "fuller analyst-style",
    focus: [
      "market regime",
      "movers",
      "cross-asset themes",
      "narratives",
      "catalysts",
      "risks",
      "source gaps",
    ],
    targetKindMix: { ...EQUITY_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
  },
};
