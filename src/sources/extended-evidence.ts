import type {
  CollectContext,
  ExtendedEvidenceAdapter,
  ExtendedEvidenceCollectionResult,
} from "./types";

export const emptyExtendedEvidenceAdapter: ExtendedEvidenceAdapter = {
  name: "extended-evidence",
  collect: (_ctx: CollectContext): Promise<ExtendedEvidenceCollectionResult> =>
    Promise.resolve({
      rawSnapshots: [],
      sources: [],
      sourceGaps: [],
    }),
};
