import type { RunParams } from "../types";
import { RESEARCH_KIND_MIX } from "./shared";

export const researchEquityProfile: RunParams = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  targetPredictions: 2,
  defaultPredictionHorizon: 15,
  predictionSubjects: [],
  analystStyle: "concise brief",
  focus: ["subject evidence", "proxy evidence", "representative instruments", "risks", "data gaps"],
  targetKindMix: RESEARCH_KIND_MIX,
  deep: {
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 3,
    analystStyle: "fuller analyst-style",
    focus: [
      "subject evidence",
      "proxy evidence",
      "representative instruments",
      "catalysts",
      "scenarios",
      "risks",
      "data gaps",
    ],
    targetKindMix: { ...RESEARCH_KIND_MIX, minNonDirection: 2 },
  },
};
