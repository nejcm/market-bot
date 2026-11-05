import { isBusinessFrameworkSectionName } from "../sources/extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../web-evidence";
import {
  readWebSubjectProfileOpenGap,
  unreadableOpenGapsNotice,
  type WebSubjectProfileGapTopic,
} from "../web-evidence/contract";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import type {
  BusinessFrameworkExtra,
  MetricSectionsExtra,
  ReconcilableGapTopic,
  WebSubjectProfileExtra,
} from "../report/report-extras-contract";
import { isRecord, nonEmptyStringArrayValue } from "../guards";
import type { CollectedSources, EarningsSetupCollected } from "../sources/types";
import type { FigureQuote } from "../domain/report";
import { readFigureQuotes } from "./web-figure-verification";

interface ExtraProjector {
  readonly key: string;
  readonly codeAssembledDigest?: boolean;
  readonly project: (
    modelExtras: Record<string, unknown>,
    collectedSources: CollectedSources,
  ) => unknown;
}

interface ModelBusinessFrameworkSection {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly figureQuotes?: readonly FigureQuote[];
}

function modelBusinessFrameworkSections(
  extra: unknown,
): ReadonlyMap<string, ModelBusinessFrameworkSection> {
  if (!isRecord(extra) || !Array.isArray(extra.sections)) {
    return new Map();
  }
  const sections = new Map<string, ModelBusinessFrameworkSection>();
  for (const item of extra.sections) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.text !== "string") {
      continue;
    }
    if (!isBusinessFrameworkSectionName(item.name)) {
      continue;
    }
    const figureQuotes = readFigureQuotes(item.figureQuotes);
    sections.set(item.name, {
      text: item.text,
      sourceIds: nonEmptyStringArrayValue(item.sourceIds),
      ...(figureQuotes === undefined ? {} : { figureQuotes }),
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
        metricSectionIds: section.metricSectionIds,
        sourceIds:
          modelSection !== undefined && modelSection.sourceIds.length > 0
            ? modelSection.sourceIds
            : section.sourceIds,
        gaps: section.gaps,
        ...(modelSection !== undefined ? { text: modelSection.text } : {}),
        ...(modelSection?.figureQuotes === undefined
          ? {}
          : { figureQuotes: modelSection.figureQuotes }),
      };
    }),
    ...(artifact.reconciliation !== undefined ? { reconciliation: artifact.reconciliation } : {}),
  };
}

function latestPeriodEnd(sections: readonly MetricSection[], periodMonths?: number): string {
  return sections
    .flatMap(({ metrics }) => metrics)
    .reduce(
      (max, metric) =>
        metric.periodMonths !== undefined &&
        (periodMonths === undefined || metric.periodMonths === periodMonths) &&
        metric.periodEnd !== undefined &&
        metric.periodEnd > max
          ? metric.periodEnd
          : max,
      "",
    );
}

// Unreconciled is the safe default. Geographic gaps never reconcile: shares can overlap
// (Americas + US) and the metrics carry no axis that proves the members are disjoint.
function gapTopicProof(
  topic: WebSubjectProfileGapTopic,
  sections: readonly MetricSection[] | undefined,
): { readonly topic: ReconcilableGapTopic; readonly metricId: string } | undefined {
  if (sections === undefined) {
    return undefined;
  }
  const allMetrics = sections.flatMap(({ metrics }) => metrics);
  const metricsOf = (id: string) => sections.find((section) => section.id === id)?.metrics ?? [];
  if (topic === "segment-results") {
    const latest = metricsOf("segment-results").reduce(
      (max, { periodEnd }) => (periodEnd !== undefined && periodEnd > max ? periodEnd : max),
      latestPeriodEnd(sections),
    );
    const rows = metricsOf("segment-results").filter(({ periodEnd }) => periodEnd === latest);
    if (rows.some(({ periodMonths }) => periodMonths === undefined)) {
      return undefined;
    }
    const proven = [...new Set(rows.map(({ periodMonths }) => periodMonths))].flatMap((months) => {
      const group = rows.filter((metric) => metric.periodMonths === months);
      const revenue = group.filter(({ id }) => id.endsWith("-revenue"));
      const total = allMetrics.find(
        (metric) =>
          metric.id === "revenue" &&
          metric.status === "value" &&
          metric.periodEnd === latest &&
          metric.periodMonths === months,
      )?.value;
      const segmentSum = revenue.reduce(
        (sum, { status, value }) =>
          sum + (status === "value" && typeof value === "number" ? value : Number.NaN),
        0,
      );
      const withIncome = revenue.every((row) =>
        group.some(
          (metric) =>
            metric.id === row.id.replace(/-revenue$/, "-operating-income") &&
            metric.status === "value",
        ),
      );
      // Untagged segments are invisible, so only a sum matching total revenue proves coverage.
      const complete =
        typeof total === "number" && total > 0 && Math.abs(segmentSum - total) <= total * 0.01;
      return revenue[0] !== undefined && withIncome && complete ? [revenue[0].id] : [];
    });
    return proven[0] === undefined ? undefined : { topic, metricId: proven[0] };
  }
  if (topic === "dividend-history") {
    const fiscalYearEnd = latestPeriodEnd(sections, 12);
    const cagr = metricsOf("capital-return").find(
      (metric) =>
        /^dpsCagr\d+y$/.test(metric.id) &&
        metric.status === "value" &&
        metric.periodEnd === fiscalYearEnd,
    );
    return cagr === undefined ? undefined : { topic, metricId: cagr.id };
  }
  return undefined;
}

function webSubjectProfileExtra(
  artifact: WebSubjectProfileArtifact | undefined,
  metricSections: readonly MetricSection[] | undefined,
): WebSubjectProfileExtra | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  // Rerun and deep-bundle paths pass sidecars unvalidated, so legacy string gaps arrive here.
  const readable = artifact.openGaps.flatMap((gap) => readWebSubjectProfileOpenGap(gap) ?? []);
  const unreadable = artifact.openGaps.length - readable.length;
  const openGaps = [
    ...(unreadable > 0
      ? [{ text: unreadableOpenGapsNotice(unreadable), topic: "other" as const }]
      : []),
    ...readable,
  ];
  const reconciledGaps = openGaps.flatMap((gap) => {
    const proof = gapTopicProof(gap.topic, metricSections);
    return proof === undefined ? [] : [{ text: gap.text, ...proof }];
  });
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
    openGaps: openGaps.map((gap) => gap.text),
    ...(reconciledGaps.length > 0 ? { reconciledGaps } : {}),
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
      webSubjectProfileExtra(collectedSources.webSubjectProfile, collectedSources.metricSections),
  },
  {
    key: "metricSections",
    codeAssembledDigest: true,
    project: (_modelExtras, collectedSources): MetricSectionsExtra | undefined =>
      collectedSources.metricSections,
  },
  {
    key: "earningsSetup",
    project: (modelExtras, collectedSources) =>
      collectedSources.earningsSetup === undefined
        ? undefined
        : mergeEarningsSetupExtra(modelExtras.earningsSetup, collectedSources.earningsSetup),
  },
];

export const EXTENDED_EVIDENCE_EXTRA_KEYS: ReadonlySet<string> = new Set(
  EXTENDED_EVIDENCE_EXTRA_PROJECTORS.map((projector) => projector.key),
);

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
