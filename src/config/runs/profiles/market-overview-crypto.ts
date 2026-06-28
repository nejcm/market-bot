import type { RunParams } from "../types";
import { CRYPTO_MARKET_UPDATE_KIND_MIX } from "./shared";

export const marketOverviewCryptoProfile: RunParams = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  targetPredictions: 2,
  defaultPredictionHorizon: 15,
  predictionSubjects: ["BTC", "ETH"],
  analystStyle: "concise brief",
  focus: ["market regime", "movers", "narratives", "catalysts", "risks", "source gaps"],
  targetKindMix: CRYPTO_MARKET_UPDATE_KIND_MIX,
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
    targetKindMix: { ...CRYPTO_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
  },
};
