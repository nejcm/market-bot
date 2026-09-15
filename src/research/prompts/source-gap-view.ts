import type { SourceGap } from "../../domain/types";
import { ANALYST_EXPECTATION_ADAPTERS } from "../../sources/extended-evidence/analyst-expectations";
import { frameworkGapCode } from "../../sources/extended-evidence/business-framework";
import type { CollectedSources } from "../../sources/types";

export type SourceGapView = "all" | "web-gather";

// Gaps the Web Gather stage prompt must not see. Each entry is argued from its
// Producer, not read off SourceGapCause; cause is not a closability axis.
function isWebGatherVisibleGap(gap: SourceGap): boolean {
  // Only Finnhub HTTP snapshots from collectAnalystExpectations close these; a web page cannot.
  if (ANALYST_EXPECTATION_ADAPTERS.has(gap.source)) {
    return false;
  }
  if (frameworkGapCode(gap) === "analyst-consensus") {
    return false;
  }
  return true;
}

// Web Gather sees a narrowed Source Gap set; every other consumer, including
// Report dataGaps, analytics, normalized/source-gaps.json, and the Console,
// Reads CollectedSources directly and is unaffected. Absence stays a finding.
export function collectedSourcesForGapView(
  view: SourceGapView,
  collectedSources: CollectedSources,
): CollectedSources {
  if (view === "all") {
    return collectedSources;
  }
  const keep = (gaps: readonly SourceGap[]) => gaps.filter((gap) => isWebGatherVisibleGap(gap));
  return {
    ...collectedSources,
    sourceGaps: keep(collectedSources.sourceGaps),
    ...(collectedSources.extendedEvidence !== undefined
      ? {
          extendedEvidence: {
            ...collectedSources.extendedEvidence,
            gaps: keep(collectedSources.extendedEvidence.gaps),
          },
        }
      : {}),
    ...(collectedSources.marketContext !== undefined
      ? {
          marketContext: {
            ...collectedSources.marketContext,
            gaps: keep(collectedSources.marketContext.gaps),
          },
        }
      : {}),
  };
}
