import type { ResearchReport } from "../domain/types";
import { isRecord } from "../sources/guards";
import type { CollectedSources } from "../sources/types";
import { CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS } from "./extended-evidence-projections";

// Current-run web-source usage roles shared by run analytics and the post-synthesis audit.
// Descriptive accounting only — a single source of truth so the two consumers can never
// Disagree about which accepted sources count as unused.
export interface WebSourceUsage {
  /** Accepted web sources gathered by the current run (reused-profile carryovers excluded). */
  readonly currentRunIds: ReadonlySet<string>;
  /** Accepted web sources carried over from a reused web subject profile. */
  readonly reusedProfileIds: ReadonlySet<string>;
  /** Current-run sources referenced by the web subject profile. */
  readonly profileUsedIds: ReadonlySet<string>;
  /** Accepted web sources cited by primary report sections. */
  readonly reportCitedIds: ReadonlySet<string>;
  /** Accepted web sources cited by authored extras. */
  readonly extrasCitedIds: ReadonlySet<string>;
  /** Current-run sources used anywhere: profile, report sections, or extras. */
  readonly currentRunUsedIds: ReadonlySet<string>;
}

// Recursively collect every sourceId string reachable under report.extras, excluding the
// Code-assembled Extended Evidence subtrees declared by the projection seam. Authored extras such
// As earningsSetup, businessFramework, spotlights, and historicalContext nest {text, sourceIds}
// Bullets at varying depths, so a walk keeps telemetry robust to extras shape changes.
function collectExtrasSourceIds(extras: Record<string, unknown> | undefined): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS.has(key)) {
        continue;
      }
      if (key === "sourceIds" && Array.isArray(nested)) {
        for (const id of nested) {
          if (typeof id === "string") {
            ids.add(id);
          }
        }
        continue;
      }
      visit(nested);
    }
  };
  visit(extras);
  return ids;
}

export function computeWebSourceUsage(
  report: ResearchReport,
  collectedSources: CollectedSources,
): WebSourceUsage {
  const acceptedIds = new Set(
    report.sources.filter((source) => source.kind === "web").map((source) => source.id),
  );
  const reusedProfileIds = new Set(
    collectedSources.webSubjectProfileReuse === undefined
      ? []
      : (collectedSources.webSubjectProfile?.sourceIds ?? []).filter((id) => acceptedIds.has(id)),
  );
  const currentRunIds = new Set([...acceptedIds].filter((id) => !reusedProfileIds.has(id)));
  const profileUsedIds = new Set(
    (collectedSources.webSubjectProfile?.sourceIds ?? []).filter((id) => currentRunIds.has(id)),
  );
  const reportCitedIds = new Set(
    [
      ...report.keyFindings,
      ...report.bullCase,
      ...report.bearCase,
      ...report.risks,
      ...report.catalysts,
      ...report.scenarios,
      ...report.predictions,
    ]
      .flatMap((item) => item.sourceIds)
      .filter((id) => acceptedIds.has(id)),
  );
  // Web sources cited only in authored extras count as real usage, so fold them into the
  // Usage union (keeps `unused` and usageWarning from flagging genuinely used sources) while
  // Reporting them separately from primary reportCited (run-review finding #1).
  const extrasCitedIds = new Set(
    [...collectExtrasSourceIds(report.extras)].filter((id) => acceptedIds.has(id)),
  );
  const usedUnion = new Set([...profileUsedIds, ...reportCitedIds, ...extrasCitedIds]);
  const currentRunUsedIds = new Set([...usedUnion].filter((id) => currentRunIds.has(id)));
  return {
    currentRunIds,
    reusedProfileIds,
    profileUsedIds,
    reportCitedIds,
    extrasCitedIds,
    currentRunUsedIds,
  };
}
