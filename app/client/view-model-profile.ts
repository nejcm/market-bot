import { formatLensValue } from "../../src/sources/extended-evidence/value-format";
import type {
  BusinessFrameworkArtifact,
  BusinessFrameworkMetric,
  BusinessFrameworkPosture,
  BusinessFrameworkSectionName,
  BusinessLifecyclePhase,
} from "../../src/sources/extended-evidence/business-framework";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileQuestionKey,
} from "../../src/web-evidence";
import {
  readBusinessFrameworkExtra,
  readWebSubjectProfileExtra,
  webSubjectProfileQuestionKeys,
  type BusinessFrameworkExtraGap,
  type WebSubjectProfileFactValue,
} from "../../src/report/report-extras-contract";
import { readStringVerbatim } from "../../src/guards";
import { readRecord } from "./view-model-format";
import type { ValuationMetricTile } from "./view-model-lens";

const BUSINESS_FRAMEWORK_SECTION_NAMES = [
  "Business",
  "Phase",
  "Moat",
  "Growth",
  "Management",
  "Risk",
  "Valuation",
] as const;

const BUSINESS_FRAMEWORK_PHASES = [
  "startup",
  "hyper-growth",
  "operating-leverage",
  "capital-return",
  "decline",
] as const;

const BUSINESS_FRAMEWORK_POSTURES = [
  "criteria-supported",
  "criteria-mixed",
  "criteria-not-supported",
  "insufficient-data",
] as const;

function isBusinessFrameworkSectionName(value: string): value is BusinessFrameworkSectionName {
  return (BUSINESS_FRAMEWORK_SECTION_NAMES as readonly string[]).includes(value);
}

function isBusinessLifecyclePhase(value: string): value is BusinessLifecyclePhase {
  return (BUSINESS_FRAMEWORK_PHASES as readonly string[]).includes(value);
}

function isBusinessFrameworkPosture(value: string): value is BusinessFrameworkPosture {
  return (BUSINESS_FRAMEWORK_POSTURES as readonly string[]).includes(value);
}

interface BusinessFrameworkMetricTile extends ValuationMetricTile {
  readonly key: string;
  readonly sourceIds: readonly string[];
}

interface BusinessFrameworkSectionView {
  readonly name: BusinessFrameworkSectionName;
  readonly posture: BusinessFrameworkPosture;
  readonly summary: string;
  readonly text?: string;
  readonly metrics: readonly BusinessFrameworkMetricTile[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
}

export interface BusinessFrameworkView {
  readonly phase: BusinessLifecyclePhase;
  readonly sections: readonly BusinessFrameworkSectionView[];
  readonly sourceIds: readonly string[];
  readonly gaps: readonly string[];
}

interface WebSubjectProfileQuestionView {
  readonly key: string;
  readonly label: string;
  readonly answer: string;
  readonly sourceIds: readonly string[];
}

interface WebSubjectProfileFactView {
  readonly claim: string;
  readonly sourceIds: readonly string[];
}

export interface WebSubjectProfileView {
  readonly subjectKind?: string;
  readonly subjectLabel?: string;
  readonly subjectSummary?: WebSubjectProfileQuestionView;
  readonly generatedAt?: string;
  readonly questions: readonly WebSubjectProfileQuestionView[];
  readonly recentMaterialEvents: readonly WebSubjectProfileFactView[];
  readonly factLedger: readonly WebSubjectProfileFactView[];
  readonly openGaps: readonly string[];
  readonly sourceIds: readonly string[];
}

function businessFrameworkMetricTile(metric: BusinessFrameworkMetric): BusinessFrameworkMetricTile {
  return {
    key: metric.key,
    label: metric.label,
    value:
      typeof metric.value === "string"
        ? metric.value
        : formatLensValue(metric.value, metric.unit, metric.currency),
    sourceIds: metric.sourceIds,
  };
}

// The reader keeps a gap's code for the markdown renderer; the Console shows text only.
function businessFrameworkGapText(gap: BusinessFrameworkExtraGap): string {
  return typeof gap === "string" ? gap : gap.text;
}

function businessFrameworkFromValue(value: unknown): BusinessFrameworkView | undefined {
  const framework = readBusinessFrameworkExtra(value);
  if (framework === undefined) {
    return undefined;
  }
  // View policy: the Console header is the phase, so an unknown or absent phase
  // Suppresses the whole card. Absent `sections` renders as no sections.
  const { phase } = framework;
  if (phase === undefined || !isBusinessLifecyclePhase(phase)) {
    return undefined;
  }
  const sections = (framework.sections ?? []).flatMap(
    (section): readonly BusinessFrameworkSectionView[] => {
      const { name, posture, summary, text } = section;
      if (
        name === undefined ||
        posture === undefined ||
        summary === undefined ||
        !isBusinessFrameworkSectionName(name) ||
        !isBusinessFrameworkPosture(posture)
      ) {
        return [];
      }
      return [
        {
          name,
          posture,
          summary,
          ...(text !== undefined ? { text } : {}),
          metrics: section.metrics.map(businessFrameworkMetricTile),
          sourceIds: section.sourceIds,
          gaps: section.gaps.map(businessFrameworkGapText),
        },
      ];
    },
  );
  return {
    phase,
    sections,
    sourceIds: framework.sourceIds,
    gaps: framework.gaps.map(businessFrameworkGapText),
  };
}

export function businessFrameworkView(
  report: Record<string, unknown> | undefined,
  artifact?: BusinessFrameworkArtifact,
): BusinessFrameworkView | undefined {
  const extras = readRecord(report?.extras);
  return (
    businessFrameworkFromValue(extras?.businessFramework) ?? businessFrameworkFromValue(artifact)
  );
}

const WEB_SUBJECT_PROFILE_QUESTION_LABELS: Readonly<Record<WebSubjectProfileQuestionKey, string>> =
  {
    whatItDoes: "What it does",
    howItMakesMoney: "How it makes money",
    customers: "Customers",
    geography: "Geography",
    purchaseRecurrence: "Purchase recurrence",
    pricingPower: "Pricing power",
    recessionCyclicality: "Recession cyclicality",
    managementTrackRecord: "Management track record",
    capitalAllocation: "Capital allocation",
    companyKpis: "Company-specific KPIs",
    riskFactors: "Disclosed risk factors",
    valueAccrual: "Value accrual",
    supplyIssuance: "Supply and issuance",
    usageAdoption: "Usage and adoption",
    governanceBuilders: "Governance and builders",
    competitionMoat: "Competition and moat",
    keyRisks: "Key risks",
    whatItIs: "What it is",
    whyNow: "Why now",
    beneficiaries: "Beneficiaries",
    headwinds: "Headwinds",
    keyDebates: "Key debates",
    howItPlaysOut: "How it plays out",
  };

// View policy: an uncited fact is not shown, and a claim the reader kept without
// Text (`claim: undefined`) has nothing to render.
function webProfileFacts(
  facts: readonly WebSubjectProfileFactValue[],
): readonly WebSubjectProfileFactView[] {
  return facts.flatMap(({ claim, sourceIds }): readonly WebSubjectProfileFactView[] =>
    claim === undefined || sourceIds.length === 0 ? [] : [{ claim, sourceIds }],
  );
}

function webSubjectProfileFromValue(value: unknown): WebSubjectProfileView | undefined {
  const profile = readWebSubjectProfileExtra(value);
  if (profile === undefined) {
    return undefined;
  }
  // View policy: an answer is shown only when it has text and a citation; an
  // Absent `questions` record renders as no questions.
  const rawQuestions = profile.questions;
  const questions =
    rawQuestions === undefined
      ? []
      : webSubjectProfileQuestionKeys(profile.subjectKind).flatMap(
          (key): readonly WebSubjectProfileQuestionView[] => {
            const question = rawQuestions[key];
            const answer = question?.answer;
            const sourceIds = question?.sourceIds ?? [];
            return answer === undefined || answer === "" || sourceIds.length === 0
              ? []
              : [{ key, label: WEB_SUBJECT_PROFILE_QUESTION_LABELS[key], answer, sourceIds }];
          },
        );
  const summaryAnswer = profile.subjectSummary?.answer;
  const summarySourceIds = profile.subjectSummary?.sourceIds ?? [];
  const subjectSummary =
    summaryAnswer === undefined || summaryAnswer === "" || summarySourceIds.length === 0
      ? undefined
      : {
          key: "subjectSummary",
          label: "Summary",
          answer: summaryAnswer,
          sourceIds: summarySourceIds,
        };
  const recentMaterialEvents = webProfileFacts(profile.recentMaterialEvents);
  const factLedger = webProfileFacts(profile.factLedger);
  const { subjectKind, openGaps } = profile;
  if (
    questions.length === 0 &&
    recentMaterialEvents.length === 0 &&
    factLedger.length === 0 &&
    openGaps.length === 0
  ) {
    return undefined;
  }
  const subjectLabel = profile.subjectLabel ?? profile.companyName;
  // Not part of the extras contract — the extras projection strips it — but the
  // Sidecar artifact this same mapper reads still carries it.
  const generatedAt = readStringVerbatim(readRecord(value), "generatedAt");
  return {
    ...(subjectKind !== undefined ? { subjectKind } : {}),
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    ...(subjectSummary !== undefined ? { subjectSummary } : {}),
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    questions,
    recentMaterialEvents,
    factLedger,
    openGaps,
    sourceIds: profile.sourceIds,
  };
}

export function webSubjectProfileView(
  report: Record<string, unknown> | undefined,
  artifact?: WebSubjectProfileArtifact,
): WebSubjectProfileView | undefined {
  const extras = readRecord(report?.extras);
  return (
    webSubjectProfileFromValue(extras?.webSubjectProfile) ?? webSubjectProfileFromValue(artifact)
  );
}
