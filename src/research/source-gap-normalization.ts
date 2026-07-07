import { consolidateSecCompanyFactGaps, dedupeSourceGaps } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import type { CollectedSources } from "../sources/types";

// Drop exact duplicates first, then consolidate overlapping SEC company-fact gaps so the
// Canonical set no longer double-counts a missing fact that also appears in a wider list.
function normalizeGapList(gaps: readonly SourceGap[]): readonly SourceGap[] {
  return consolidateSecCompanyFactGaps(dedupeSourceGaps(gaps));
}

export function normalizeCanonicalSourceGaps(collectedSources: CollectedSources): CollectedSources {
  return {
    ...collectedSources,
    sourceGaps: normalizeGapList(collectedSources.sourceGaps),
    ...(collectedSources.extendedEvidence !== undefined
      ? {
          extendedEvidence: {
            ...collectedSources.extendedEvidence,
            gaps: normalizeGapList(collectedSources.extendedEvidence.gaps),
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
