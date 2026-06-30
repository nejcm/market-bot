import type { RunParams } from "../types";
import { INSTRUMENT_KIND_MIX } from "./shared";

export const cryptoProfile: RunParams = {
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
