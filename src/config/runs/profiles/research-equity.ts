import type { RunParams } from "../types";
import { RESEARCH_KIND_MIX } from "./shared";

export const researchEquityProfile: RunParams = {
  minimumKeyFindings: 5,
  minimumScenarios: 3,
  targetPredictions: 3,
  defaultPredictionHorizon: 15,
  predictionSubjects: [],
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
};
