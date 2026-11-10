import { createHash } from "node:crypto";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { ExtendedEvidence, ExtendedEvidenceItem, SubjectKind } from "../domain/evidence";
import type { Source, SourceGap } from "../domain/sources";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import {
  substantiveProfileSourceIds,
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
  type WebSubjectProfileCompanyQuestionKey,
  type WebSubjectProfileCryptoQuestionKey,
  type WebSubjectProfileThemeQuestionKey,
} from "./contract";
import { webSourceTexts, type WebSourceTexts } from "../research/web-figure-verification";
import {
  EMPTY_ANSWER,
  screenedFailureOpenGap,
  otherGap,
  type ParsedProfile,
  type ProfileRejection,
  parseProfile,
  withoutSourceIdMarkers,
  profileSourceIds,
  profileGap,
} from "./web-subject-profile-parse";
import {
  revenueShares,
  assertCodeAssembledProfileText,
  screenProfileFields,
  applyScreenedFields,
} from "./web-subject-profile-screening";

export { type WebSubjectProfileArtifact } from "./contract";

export interface WebSubjectProfileResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact: WebSubjectProfileArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

export interface WebSubjectProfileSubject {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly symbol?: string;
  readonly assetClass?: "equity" | "crypto";
}

export function normalizedSubjectId(subject: string): string {
  const normalized = subject
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-+/gu, "-");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${normalized === "" ? "subject" : normalized}-${digest}`;
}

// SEC filing Sources (10-K/10-Q text) are high-trust primary evidence that the
// Company Web Subject Profile may cite alongside gathered web Sources. They live
// In `extendedSources` with provider `sec-edgar`. `snippet` must be present: a
// Filing whose text failed to ingest (see A1 in the run-quality remediation plan)
// Still surfaces a metadata-only source/item so the filing-basis date and
// FilingPackets keep working, but that source carries no filing text and must
// Never become citable evidence for a text-grounded stage — a model instructed
// To cite filing text it does not have would otherwise pass the allowlist
// Untouched merely because the id matches the 10-K/10-Q shape.
export function isCompanyProfileSecSource(source: Source): boolean {
  return (
    source.kind === "extended-evidence" &&
    source.provider === "sec-edgar" &&
    source.snippet !== undefined &&
    (source.id.endsWith("-10k") || source.id.endsWith("-10q"))
  );
}

// The one Source set a Web Subject Profile may cite: its prompt payload and validator both read it.
export function profileCitableSources(
  sources: readonly Source[],
  subjectKind: SubjectKind,
): readonly Source[] {
  return sources.filter(
    (source) =>
      source.kind === "web" || (subjectKind === "company" && isCompanyProfileSecSource(source)),
  );
}

export function subjectKindForCommand(command: ResearchCommand): SubjectKind | undefined {
  if (isInstrumentCommand(command)) {
    if (command.assetClass === "equity") {
      return "company";
    }
    if (command.assetClass === "crypto") {
      return "crypto-asset";
    }
  }
  return command.jobType === "research" ? "theme" : undefined;
}

export function webSubjectProfileSubjectForCommand(
  command: ResearchCommand,
  subjectLabel?: string,
): WebSubjectProfileSubject | undefined {
  const subjectKind = subjectKindForCommand(command);
  if (subjectKind === undefined) {
    return undefined;
  }
  if (isInstrumentCommand(command)) {
    return {
      subjectKind,
      subjectId: command.symbol,
      ...(subjectLabel !== undefined ? { subjectLabel } : {}),
      symbol: command.symbol,
      assetClass: command.assetClass,
    };
  }
  if (command.jobType !== "research") {
    return undefined;
  }
  return {
    subjectKind,
    subjectId: command.subjectKey ?? normalizedSubjectId(command.subject),
    subjectLabel: subjectLabel ?? command.subject,
  };
}

const FIGURE_QUOTE = {
  sourceId: "web-source-id",
  quote: "verbatim source text",
  unitQuote: "optional: verbatim unit header cell of a table figure's column",
};

export function webSubjectProfileRequiredShape(subjectKind: SubjectKind): Record<string, unknown> {
  return {
    subjectLabel: "string",
    subjectSummary: {
      answer: "string",
      sourceIds: ["web-source-id"],
      figureQuotes: [FIGURE_QUOTE],
    },
    questions: Object.fromEntries(
      WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].map((key) => [
        key,
        { answer: "string", sourceIds: ["web-source-id"], figureQuotes: [FIGURE_QUOTE] },
      ]),
    ),
    recentMaterialEvents: [
      { claim: "string", sourceIds: ["web-source-id"], figureQuotes: [FIGURE_QUOTE] },
    ],
    factLedger: [{ claim: "string", sourceIds: ["web-source-id"], figureQuotes: [FIGURE_QUOTE] }],
    openGaps: [{ text: "string", topic: "other" }],
  };
}

/*
 * Reuse reads an artifact persisted by an earlier run, possibly one written before this screen
 * existed, and by then a code-generated entry is indistinguishable from a model-authored one. The
 * drop/replace rule is therefore the only safe one here. `violatesResearchOnly` runs first: a
 * string that contains the withheld marker and a banned phrase is a violation, not a notice.
 * Pre-existing clean notices are then counted via `isWebSubjectProfileWithheldAnswer` so the
 * reusing run re-emits the matching Source Gaps instead of dropping the declaration.
 */
export interface ScreenedReusedWebSubjectProfile {
  readonly artifact: WebSubjectProfileArtifact;
  readonly withheldGaps: readonly SourceGap[];
}

export function screenReusedWebSubjectProfile(
  reused: WebSubjectProfileArtifact,
  webTexts: WebSourceTexts,
  metricSections?: readonly MetricSection[],
): ScreenedReusedWebSubjectProfile {
  const artifact = withoutSourceIdMarkers(reused);
  const screened = screenProfileFields(artifact, revenueShares(metricSections), webTexts);
  if (screened.withheldGaps.length === 0) {
    return { artifact, withheldGaps: [] };
  }
  return { artifact: applyScreenedFields(artifact, screened), withheldGaps: screened.withheldGaps };
}

export function buildWebSubjectProfileEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly runId: string;
  readonly modelContent: string;
  readonly webSources: readonly Source[];
  readonly rawSnapshots?: readonly unknown[];
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly metricSections?: readonly MetricSection[];
  readonly secFilingBasisDate?: string;
  readonly issuerReportBasisDate?: string;
}): WebSubjectProfileResult {
  const webSourceIds = new Set(input.webSources.map((source) => source.id));
  if (webSourceIds.size === 0) {
    const message = `Web Subject Profile skipped for ${input.subject.subjectId}: no gathered web Sources`;
    const artifact = emptyArtifact(
      input.subject,
      input.generatedAt,
      input.runId,
      message,
      basisDates(input),
    );
    const gap = profileGap(message, "provider-data-missing");
    return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
  }

  const parsed = parseProfile(input.modelContent, input.subject.subjectKind, webSourceIds);
  if ("error" in parsed) {
    const message = `Web Subject Profile invalid for ${input.subject.subjectId}: ${parsed.error}`;
    const artifact = emptyArtifact(
      input.subject,
      input.generatedAt,
      input.runId,
      message,
      basisDates(input),
    );
    const gap = profileGap(message, "validation-failed");
    return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
  }

  const screened = screenProfileFields(
    parsed.profile,
    revenueShares(input.metricSections),
    webSourceTexts(input.webSources, input.rawSnapshots),
  );
  const rejectionSummary =
    parsed.rejections.length > 0
      ? assertCodeAssembledProfileText(
          sanitizedPartialRejectionSummary(
            parsed.profile,
            input.subject.subjectKind,
            parsed.rejections,
          ),
          "partial-rejection summary",
        )
      : undefined;
  const rejectionGap =
    rejectionSummary === undefined
      ? undefined
      : profileGap(
          rejectionSummary,
          "validation-failed",
          partialAcceptanceImpact(parsed.profile, input.subject.subjectKind),
        );
  // Model-authored prose is screened here, at the only point where its origin is still known.
  // The sanitized summary survives into the reusable artifact and the transient SourceGap.
  // Both paths can reach prompts or persisted report text, so neither may contain model text.
  const profileForArtifact = {
    ...parsed.profile,
    subjectSummary: screened.subjectSummary,
    questions: screened.questions,
    recentMaterialEvents: screened.recentMaterialEvents,
    factLedger: screened.factLedger,
    openGaps: [
      ...screened.openGaps,
      ...(rejectionSummary === undefined ? [] : [otherGap(rejectionSummary)]),
    ],
  };
  const sourceIds = profileSourceIds(profileForArtifact);
  const artifact = profileArtifact({
    subject: input.subject,
    generatedAt: input.generatedAt,
    originRunDirName: input.runId,
    profile: profileForArtifact,
    sourceIds,
    basis: basisDates(input),
  });
  const emptyGap =
    substantiveProfileSourceIds(artifact).size === 0
      ? [
          profileGap(
            `Web Subject Profile empty for ${input.subject.subjectId}: no cited substantive answer or fact remains after validation and marker removal`,
            "validation-failed",
          ),
        ]
      : [];
  return profileResult(input.command, input.extendedEvidence, input.subject, artifact, sourceIds, [
    ...(rejectionGap === undefined ? [] : [rejectionGap]),
    ...screened.withheldGaps,
    ...emptyGap,
  ]);
}

export function buildWebSubjectProfileFailureEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly runId: string;
  readonly message: string;
  readonly cause: NonNullable<SourceGap["cause"]>;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
  readonly issuerReportBasisDate?: string;
}): WebSubjectProfileResult {
  const artifact = emptyArtifact(
    input.subject,
    input.generatedAt,
    input.runId,
    input.message,
    basisDates(input),
  );
  const gap = profileGap(input.message, input.cause);
  return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
}

export function buildWebSubjectProfileReuseEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly reused: ScreenedReusedWebSubjectProfile;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly freshnessGap: SourceGap;
}): WebSubjectProfileResult {
  return profileResult(
    input.command,
    input.extendedEvidence,
    input.subject,
    input.reused.artifact,
    input.reused.artifact.sourceIds,
    [input.freshnessGap, ...input.reused.withheldGaps],
  );
}

function emptyQuestions(
  subjectKind: SubjectKind,
): Readonly<Record<string, WebSubjectProfileAnswer>> {
  return Object.fromEntries(
    WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].map((key) => [key, EMPTY_ANSWER]),
  );
}

interface ProfileBasisDates {
  readonly secFilingBasisDate?: string;
  readonly issuerReportBasisDate?: string;
}

function basisDates(input: ProfileBasisDates): ProfileBasisDates {
  return {
    ...(input.secFilingBasisDate !== undefined
      ? { secFilingBasisDate: input.secFilingBasisDate }
      : {}),
    ...(input.issuerReportBasisDate !== undefined
      ? { issuerReportBasisDate: input.issuerReportBasisDate }
      : {}),
  };
}

function emptyArtifact(
  subject: WebSubjectProfileSubject,
  generatedAt: string,
  originRunDirName: string,
  gap: string,
  basis: ProfileBasisDates,
): WebSubjectProfileArtifact {
  const base = {
    version: 3 as const,
    generatedAt,
    originRunDirName,
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    ...(subject.subjectLabel !== undefined ? { subjectLabel: subject.subjectLabel } : {}),
    subjectSummary: EMPTY_ANSWER,
    recentMaterialEvents: [],
    factLedger: [],
    openGaps: [screenedFailureOpenGap(gap)],
    sourceIds: [],
  };
  if (subject.subjectKind === "company") {
    return {
      ...base,
      subjectKind: "company",
      symbol: subject.symbol ?? subject.subjectId,
      questions: emptyQuestions("company") as Readonly<
        Record<WebSubjectProfileCompanyQuestionKey, WebSubjectProfileAnswer>
      >,
      ...basis,
    };
  }
  if (subject.subjectKind === "crypto-asset") {
    return {
      ...base,
      subjectKind: "crypto-asset",
      symbol: subject.symbol ?? subject.subjectId,
      questions: emptyQuestions("crypto-asset") as Readonly<
        Record<WebSubjectProfileCryptoQuestionKey, WebSubjectProfileAnswer>
      >,
    };
  }
  return {
    ...base,
    subjectKind: "theme",
    questions: emptyQuestions("theme") as Readonly<
      Record<WebSubjectProfileThemeQuestionKey, WebSubjectProfileAnswer>
    >,
  };
}

function profileArtifact(input: {
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly originRunDirName: string;
  readonly profile: ParsedProfile;
  readonly sourceIds: readonly string[];
  readonly basis: ProfileBasisDates;
}): WebSubjectProfileArtifact {
  const subjectLabel = input.profile.subjectLabel ?? input.subject.subjectLabel;
  const base = {
    version: 3 as const,
    generatedAt: input.generatedAt,
    originRunDirName: input.originRunDirName,
    subjectKind: input.subject.subjectKind,
    subjectId: input.subject.subjectId,
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    subjectSummary: input.profile.subjectSummary,
    recentMaterialEvents: input.profile.recentMaterialEvents,
    factLedger: input.profile.factLedger,
    openGaps: input.profile.openGaps,
    sourceIds: input.sourceIds,
  };
  if (input.subject.subjectKind === "company") {
    return {
      ...base,
      subjectKind: "company",
      symbol: input.subject.symbol ?? input.subject.subjectId,
      ...(input.profile.companyName !== undefined
        ? { companyName: input.profile.companyName }
        : {}),
      questions: input.profile.questions as Readonly<
        Record<WebSubjectProfileCompanyQuestionKey, WebSubjectProfileAnswer>
      >,
      ...input.basis,
    };
  }
  if (input.subject.subjectKind === "crypto-asset") {
    return {
      ...base,
      subjectKind: "crypto-asset",
      symbol: input.subject.symbol ?? input.subject.subjectId,
      questions: input.profile.questions as Readonly<
        Record<WebSubjectProfileCryptoQuestionKey, WebSubjectProfileAnswer>
      >,
    };
  }
  return {
    ...base,
    subjectKind: "theme",
    questions: input.profile.questions as Readonly<
      Record<WebSubjectProfileThemeQuestionKey, WebSubjectProfileAnswer>
    >,
  };
}

function profileResult(
  command: ResearchCommand,
  existing: ExtendedEvidence | undefined,
  subject: WebSubjectProfileSubject,
  artifact: WebSubjectProfileArtifact,
  sourceIds: readonly string[],
  gaps: readonly SourceGap[],
): WebSubjectProfileResult {
  return {
    extendedEvidence: mergeExtendedEvidence(command, existing, subject, artifact, sourceIds, gaps),
    artifact,
    sourceGaps: gaps,
  };
}

function mergeExtendedEvidence(
  command: ResearchCommand,
  existing: ExtendedEvidence | undefined,
  subject: WebSubjectProfileSubject,
  artifact: WebSubjectProfileArtifact,
  sourceIds: readonly string[],
  gaps: readonly SourceGap[],
): ExtendedEvidence {
  const item: ExtendedEvidenceItem = {
    category: "web-subject-profile",
    title: "Web Subject Profile",
    summary:
      sourceIds.length === 0
        ? `No cited web subject profile facts were accepted for ${subject.subjectId}.`
        : `Cited web subject profile captured for ${subject.subjectId}.`,
    sourceIds,
    observedAt: artifact.generatedAt,
  };
  const scope =
    existing?.instrument !== undefined
      ? { instrument: existing.instrument }
      : evidenceScopeForSubject(command, subject);
  return {
    ...scope,
    items: [...(existing?.items ?? []).filter((entry) => entry.category !== item.category), item],
    gaps: [...(existing?.gaps ?? []), ...gaps],
  };
}

function evidenceScopeForSubject(
  command: ResearchCommand,
  subject: WebSubjectProfileSubject,
): Pick<ExtendedEvidence, "instrument" | "subject"> {
  if (isInstrumentCommand(command)) {
    return { instrument: { assetClass: command.assetClass, symbol: command.symbol } };
  }
  return {
    subject: {
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      ...(subject.subjectLabel !== undefined ? { subjectLabel: subject.subjectLabel } : {}),
    },
  };
}

// Finding 2: a surviving factLedger entry alone does not make a heavily
// Gutted profile safe to disclose at the lowest severity. "no-cap" is only
// Warranted when the surviving content is substantively usable:
// - A majority of the subject's questions were answered (>= 50%) — below
//   That, the profile is more hole than substance despite passing the
//   `subject-profile` coverage check; and
// - At least 2 facts (factLedger + recentMaterialEvents combined) survived —
//   The bare single-fact floor enforced by `parseProfile` is a validity
//   Gate, not evidence that the salvage produced a materially usable body.
// Either threshold missed escalates to "extended-evidence-cap" so the run
// Reads as degraded rather than clean.
const MIN_ANSWERED_QUESTION_RATIO = 0.5;
const MIN_SURVIVING_FACT_COUNT = 2;

function partialAcceptanceImpact(
  profile: ParsedProfile,
  subjectKind: SubjectKind,
): NonNullable<SourceGap["evidenceQualityImpact"]> {
  const totalQuestions = WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].length;
  const answeredQuestions = Object.values(profile.questions).filter(
    (answer) => answer.answer !== "" && answer.sourceIds.length > 0,
  ).length;
  const survivingFacts = [...profile.factLedger, ...profile.recentMaterialEvents].filter(
    (fact) => fact.claim !== "",
  ).length;
  // Every subject kind defines a fixed, non-empty question set (contract.ts),
  // So totalQuestions is always > 0 here.
  const sufficientQuestions = answeredQuestions / totalQuestions >= MIN_ANSWERED_QUESTION_RATIO;
  const sufficientFacts = survivingFacts >= MIN_SURVIVING_FACT_COUNT;
  const hasSubjectSummary =
    profile.subjectSummary.answer !== "" && profile.subjectSummary.sourceIds.length > 0;
  return hasSubjectSummary && sufficientQuestions && sufficientFacts
    ? "no-cap"
    : "extended-evidence-cap";
}

// Bound the safe field-path disclosure duplicated into gap and report surfaces.
const MAX_DETAILED_REJECTIONS = 5;

// Joins safe field paths and appends an "and N more" overflow note when needed.
function withOverflowSuffix(shown: readonly string[], totalCount: number, joiner: string): string {
  const remaining = totalCount - shown.length;
  const base = shown.join(joiner);
  return remaining > 0 ? `${base}${joiner}and ${remaining} more` : base;
}

// Field paths are code-generated from fixed keys and array indices, and sanitized failure kinds
// Are appended. IDs, reasons, and claims are model-controlled and must not enter the prompt-bound
// SourceGap or persisted artifact summary.
function sanitizedPartialRejectionSummary(
  profile: ParsedProfile,
  subjectKind: SubjectKind,
  rejections: readonly ProfileRejection[],
): string {
  const totalQuestions = WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].length;
  const rejectedFactsAndEvents = rejections.filter(
    (rejection) =>
      rejection.field !== "subjectSummary" && !rejection.field.startsWith("questions."),
  ).length;
  const totalConsidered =
    1 +
    totalQuestions +
    profile.factLedger.length +
    profile.recentMaterialEvents.length +
    rejectedFactsAndEvents;
  const rejectionLabels = rejections.map((rejection) => {
    if (rejection.answerSourceIdFailure?.kind === "missing") {
      return `${rejection.field}: answer cited no sourceIds`;
    }
    if (rejection.answerSourceIdFailure?.kind === "unknown") {
      const { count } = rejection.answerSourceIdFailure;
      return `${rejection.field}: answer cited ${count} unknown sourceId${count === 1 ? "" : "s"}`;
    }
    return rejection.field;
  });
  const shownFields = rejectionLabels.slice(0, MAX_DETAILED_REJECTIONS);
  const fieldsText = withOverflowSuffix(shownFields, rejectionLabels.length, ", ");
  return (
    `Web Subject Profile: ${rejections.length} of ${totalConsidered} items rejected for ` +
    `source-citation errors (${fieldsText}).`
  );
}
