import type { SourceGap } from "../../domain/types";
import {
  frameworkGap,
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkReconciliation,
  type BusinessFrameworkSection,
  type BusinessFrameworkSectionName,
} from "./business-framework";
import type { WebSubjectProfileArtifact } from "./web-subject-profile";

/**
 * GAP[0] maps to three structured profile questions whose non-empty cited answers
 * prove that segment mix, customer concentration, and purchase recurrence are resolved.
 */
const GAP0_QUESTION_KEYS = ["howItMakesMoney", "customers", "purchaseRecurrence"] as const;

/** Sections that carry GAP[0]. */
const GAP0_SECTIONS: ReadonlySet<BusinessFrameworkSectionName> = new Set(["Business", "Moat"]);

export interface ReconciliationResult {
  readonly artifact: BusinessFrameworkArtifact;
  readonly sourceGap: SourceGap | undefined;
}

/**
 * Deterministic post-web reconciliation of the Business Framework.
 *
 * Clears GAP[0] (segment mix / customer concentration / purchase recurrence) from
 * Business + Moat section `gaps` and from the artifact-level `gaps` when the Web
 * Subject Profile answers `howItMakesMoney`, `customers`, AND `purchaseRecurrence`
 * are each non-empty and carry ≥1 cited sourceId. All-or-nothing: partial resolution
 * leaves the whole gap.
 *
 * Postures and phase are **never** changed — reconciliation only removes gap strings.
 *
 * @param {BusinessFrameworkArtifact} framework - The Business Framework artifact to reconcile.
 * @param {WebSubjectProfileArtifact} profile - The Web Subject Profile artifact to check for cited answers.
 * @returns {ReconciliationResult} The (possibly unchanged) artifact and a regenerated frameworkGap
 * SourceGap (undefined when no qualitative gaps remain).
 */
export function reconcileBusinessFramework(
  framework: BusinessFrameworkArtifact,
  profile: WebSubjectProfileArtifact,
): ReconciliationResult {
  if (!canResolveGap0(profile)) {
    return unchanged(framework);
  }

  const [gap0] = QUALITATIVE_GAPS;
  if (!framework.gaps.includes(gap0)) {
    // GAP[0] is not present — nothing to clear.
    return unchanged(framework);
  }

  const profileSourceIds = gap0ProfileSourceIds(profile);

  const sections: readonly BusinessFrameworkSection[] = framework.sections.map((section) => {
    if (!GAP0_SECTIONS.has(section.name) || !section.gaps.includes(gap0)) {
      return section;
    }
    return { ...section, gaps: section.gaps.filter((g) => g !== gap0) };
  });

  const gaps = framework.gaps.filter((g) => g !== gap0);

  const reconciliation: BusinessFrameworkReconciliation = {
    resolvedGaps: [gap0],
    profileSourceIds,
  };

  const artifact: BusinessFrameworkArtifact = {
    ...framework,
    sections,
    gaps,
    reconciliation,
  };

  const sourceGap = gaps.length === 0 ? undefined : frameworkGap(framework.symbol, gaps);
  return { artifact, sourceGap };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canResolveGap0(profile: WebSubjectProfileArtifact): boolean {
  if (profile.subjectKind !== "company") {
    return false;
  }
  return GAP0_QUESTION_KEYS.every((key) => {
    const answer = profile.questions[key];
    return answer.answer !== "" && answer.sourceIds.length > 0;
  });
}

function gap0ProfileSourceIds(profile: WebSubjectProfileArtifact): readonly string[] {
  if (profile.subjectKind !== "company") {
    return [];
  }
  return [
    ...new Set(GAP0_QUESTION_KEYS.flatMap((key) => profile.questions[key].sourceIds)),
  ].toSorted();
}

function unchanged(framework: BusinessFrameworkArtifact): ReconciliationResult {
  const sourceGap =
    framework.gaps.length === 0 ? undefined : frameworkGap(framework.symbol, framework.gaps);
  return { artifact: framework, sourceGap };
}
