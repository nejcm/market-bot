import { isBusinessFrameworkSectionName } from "../sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../web-evidence";
import type {
  BusinessFrameworkExtra,
  WebSubjectProfileExtra,
} from "../report/report-extras-contract";
import { isRecord, nonEmptyStringArrayValue } from "../guards";
import type { CollectedSources, EarningsSetupCollected } from "../sources/types";

interface ExtraProjector {
  readonly key: string;
  readonly codeAssembledDigest?: boolean;
  readonly project: (
    modelExtras: Record<string, unknown>,
    collectedSources: CollectedSources,
  ) => unknown;
}

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

function businessFrameworkExtra(
  modelExtra: unknown,
  collectedSources: CollectedSources,
): BusinessFrameworkExtra | undefined {
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
        sourceIds:
          modelSection !== undefined && modelSection.sourceIds.length > 0
            ? modelSection.sourceIds
            : section.sourceIds,
        gaps: section.gaps,
        ...(modelSection !== undefined ? { text: modelSection.text } : {}),
      };
    }),
    ...(artifact.reconciliation !== undefined ? { reconciliation: artifact.reconciliation } : {}),
  };
}

function webSubjectProfileExtra(
  artifact: WebSubjectProfileArtifact | undefined,
): WebSubjectProfileExtra | undefined {
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
  // Deterministic event, impliedMove, and gaps are code-owned and always win over model extras.
  return {
    ...modelSections,
    event: collected.event,
    ...(collected.impliedMove !== undefined ? { impliedMove: collected.impliedMove } : {}),
    gaps: collected.gaps,
  };
}

const EXTENDED_EVIDENCE_EXTRA_PROJECTORS: readonly ExtraProjector[] = [
  {
    key: "businessFramework",
    project: (modelExtras, collectedSources) =>
      businessFrameworkExtra(modelExtras.businessFramework, collectedSources),
  },
  {
    key: "webSubjectProfile",
    codeAssembledDigest: true,
    project: (_modelExtras, collectedSources) =>
      webSubjectProfileExtra(collectedSources.webSubjectProfile),
  },
  {
    key: "earningsSetup",
    project: (modelExtras, collectedSources) =>
      collectedSources.earningsSetup === undefined
        ? undefined
        : mergeEarningsSetupExtra(modelExtras.earningsSetup, collectedSources.earningsSetup),
  },
];

export const CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS: ReadonlySet<string> = new Set(
  EXTENDED_EVIDENCE_EXTRA_PROJECTORS.flatMap((projector) =>
    projector.codeAssembledDigest === true ? [projector.key] : [],
  ),
);

/*
 * The subset of CODE_ASSEMBLED_EXTENDED_EVIDENCE_EXTRA_KEYS this run actually collected. A
 * codeAssembledDigest projector that produces nothing -- the Web Subject Profile was disabled,
 * its key was missing, or the collector timed out -- leaves its key out of the projection, and
 * `assembleResearchReport` spreads the projection over the model extras, so the report then keeps
 * `extras.<key>` straight from the model draft: editable prose, not a code-assembled digest.
 * Classification alone therefore cannot tell the two apart; only running the projector can. That
 * distinction is what the fail-fast guard in final-synthesis.ts keys off, and getting it wrong
 * stops repairs on wording the next draft could have fixed ("Absence is a finding", AGENTS.md).
 *
 * Projected with empty model extras deliberately: a codeAssembledDigest projector ignores model
 * extras by definition, so this asks the narrower question the guard needs -- does the code
 * assemble a value for this key no matter what the draft says?
 */
export function collectedCodeAssembledExtraKeys(
  collectedSources: CollectedSources,
): ReadonlySet<string> {
  return new Set(
    EXTENDED_EVIDENCE_EXTRA_PROJECTORS.flatMap((projector) =>
      projector.codeAssembledDigest === true &&
      projector.project({}, collectedSources) !== undefined
        ? [projector.key]
        : [],
    ),
  );
}

export function projectExtendedEvidenceReportExtras(input: {
  readonly modelExtras: Record<string, unknown>;
  readonly collectedSources: CollectedSources;
}): Record<string, unknown> {
  return Object.fromEntries(
    EXTENDED_EVIDENCE_EXTRA_PROJECTORS.flatMap((projector) => {
      const projected = projector.project(input.modelExtras, input.collectedSources);
      return projected === undefined ? [] : [[projector.key, projected]];
    }),
  );
}
