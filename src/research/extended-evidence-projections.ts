import { isBusinessFrameworkSectionName } from "../sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../sources/extended-evidence/web-subject-profile";
import { isRecord, nonEmptyStringArrayValue } from "../sources/guards";
import type { CollectedSources, EarningsSetupCollected } from "../sources/types";

type ExtraProjector = (
  modelExtras: Record<string, unknown>,
  collectedSources: CollectedSources,
) => readonly [string, unknown] | undefined;

function modelBusinessFrameworkSections(
  extra: unknown,
): ReadonlyMap<string, { readonly text: string; readonly sourceIds: readonly string[] }> {
  if (!isRecord(extra) || !Array.isArray(extra.sections)) {
    return new Map();
  }
  const sections = new Map<
    string,
    { readonly text: string; readonly sourceIds: readonly string[] }
  >();
  for (const item of extra.sections) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.text !== "string") {
      continue;
    }
    if (!isBusinessFrameworkSectionName(item.name)) {
      continue;
    }
    sections.set(item.name, {
      text: item.text,
      sourceIds: nonEmptyStringArrayValue(item.sourceIds),
    });
  }
  return sections;
}

function businessFrameworkExtra(modelExtra: unknown, collectedSources: CollectedSources): unknown {
  const artifact = collectedSources.businessFramework;
  if (artifact === undefined) {
    return undefined;
  }
  const modelSections = modelBusinessFrameworkSections(modelExtra);
  return {
    version: artifact.version,
    phase: artifact.phase,
    sourceIds: artifact.sourceIds,
    gaps: artifact.gaps,
    sections: artifact.sections.map((section) => {
      const modelSection = modelSections.get(section.name);
      return {
        name: section.name,
        posture: section.posture,
        summary: section.summary,
        metrics: section.metrics,
        sourceIds: modelSection?.sourceIds ?? section.sourceIds,
        gaps: section.gaps,
        ...(modelSection !== undefined ? { text: modelSection.text } : {}),
      };
    }),
    ...(artifact.reconciliation !== undefined ? { reconciliation: artifact.reconciliation } : {}),
  };
}

function webSubjectProfileExtra(artifact: WebSubjectProfileArtifact | undefined): unknown {
  if (artifact === undefined) {
    return undefined;
  }
  return {
    version: artifact.version,
    subjectKind: artifact.subjectKind,
    subjectId: artifact.subjectId,
    ...(artifact.subjectLabel !== undefined ? { subjectLabel: artifact.subjectLabel } : {}),
    ...("symbol" in artifact ? { symbol: artifact.symbol } : {}),
    ...("companyName" in artifact && artifact.companyName !== undefined
      ? { companyName: artifact.companyName }
      : {}),
    subjectSummary: artifact.subjectSummary,
    questions: artifact.questions,
    recentMaterialEvents: artifact.recentMaterialEvents,
    factLedger: artifact.factLedger,
    openGaps: artifact.openGaps,
    sourceIds: artifact.sourceIds,
    ...("secFilingBasisDate" in artifact && artifact.secFilingBasisDate !== undefined
      ? { secFilingBasisDate: artifact.secFilingBasisDate }
      : {}),
  };
}

const EARNINGS_BULLET_SECTIONS = [
  "expectationBar",
  "qualityLandmines",
  "guidanceCredibility",
] as const;

function mergeEarningsSetupExtra(
  modelEarningsSetup: unknown,
  collected: EarningsSetupCollected,
): unknown {
  const modelSections: Record<string, unknown> = {};
  if (isRecord(modelEarningsSetup)) {
    for (const key of EARNINGS_BULLET_SECTIONS) {
      const bullets = modelEarningsSetup[key];
      if (Array.isArray(bullets)) {
        modelSections[key] = bullets;
      }
    }
  }
  return {
    ...modelSections,
    event: collected.event,
    ...(collected.impliedMove !== undefined ? { impliedMove: collected.impliedMove } : {}),
    gaps: collected.gaps,
  };
}

const EXTENDED_EVIDENCE_EXTRA_PROJECTORS: readonly ExtraProjector[] = [
  (modelExtras, collectedSources) => {
    const value = businessFrameworkExtra(modelExtras.businessFramework, collectedSources);
    return value === undefined ? undefined : ["businessFramework", value];
  },
  (_modelExtras, collectedSources) => {
    const value = webSubjectProfileExtra(collectedSources.webSubjectProfile);
    return value === undefined ? undefined : ["webSubjectProfile", value];
  },
  (modelExtras, collectedSources) =>
    collectedSources.earningsSetup === undefined
      ? undefined
      : [
          "earningsSetup",
          mergeEarningsSetupExtra(modelExtras.earningsSetup, collectedSources.earningsSetup),
        ],
];

export function projectExtendedEvidenceReportExtras(input: {
  readonly modelExtras: Record<string, unknown>;
  readonly collectedSources: CollectedSources;
}): Record<string, unknown> {
  return Object.fromEntries(
    EXTENDED_EVIDENCE_EXTRA_PROJECTORS.flatMap((project) => {
      const projected = project(input.modelExtras, input.collectedSources);
      return projected === undefined ? [] : [projected];
    }),
  );
}
