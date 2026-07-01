import { dedupeSourceGaps } from "../domain/source-gaps";
import type { CollectedSources } from "../sources/types";

export function normalizeCanonicalSourceGaps(collectedSources: CollectedSources): CollectedSources {
  return {
    ...collectedSources,
    sourceGaps: dedupeSourceGaps(collectedSources.sourceGaps),
    ...(collectedSources.extendedEvidence !== undefined
      ? {
          extendedEvidence: {
            ...collectedSources.extendedEvidence,
            gaps: dedupeSourceGaps(collectedSources.extendedEvidence.gaps),
          },
        }
      : {}),
    ...(collectedSources.marketContext !== undefined
      ? {
          marketContext: {
            ...collectedSources.marketContext,
            gaps: dedupeSourceGaps(collectedSources.marketContext.gaps),
          },
        }
      : {}),
  };
}
