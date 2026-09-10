import { createHash } from "node:crypto";
import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { violatesResearchOnly } from "../domain/research-language";
import { sourceGap } from "../domain/source-gaps";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  SubjectKind,
} from "../domain/types";
import { isRecord, nonEmptyStringArrayValue, readString, stringArrayValue } from "../guards";
import {
  isWebSubjectProfileWithheldAnswer,
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE,
  WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
  WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
  type WebSubjectProfileCompanyQuestionKey,
  type WebSubjectProfileCryptoQuestionKey,
  type WebSubjectProfileFact,
  type WebSubjectProfileThemeQuestionKey,
} from "./contract";

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

const EMPTY_ANSWER: WebSubjectProfileAnswer = { answer: "", sourceIds: [] };

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

export function webSubjectProfileRequiredShape(subjectKind: SubjectKind): Record<string, unknown> {
  return {
    subjectLabel: "string",
    subjectSummary: { answer: "string", sourceIds: ["web-source-id"] },
    questions: Object.fromEntries(
      WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].map((key) => [
        key,
        { answer: "string", sourceIds: ["web-source-id"] },
      ]),
    ),
    recentMaterialEvents: [{ claim: "string", sourceIds: ["web-source-id"] }],
    factLedger: [{ claim: "string", sourceIds: ["web-source-id"] }],
    openGaps: ["string"],
  };
}

/*
 * Research-only screen for model-authored Web Subject Profile fields.
 *
 * `webSubjectProfileExtra` projects the artifact as a `codeAssembledDigest`: the artifact always
 * wins over the model's own extras, so every scanned field reaches `assertSafeReportLanguage`
 * (schema.ts:335-371) with no draft that any repair reprompt could rewrite. A deep AAPL run
 * (`2026-09-07T09-51-24-783Z-a23bf02b`) died on `openGaps`; the same gate also scans
 * `subjectSummary.answer`, `questions.<key>.answer`, `recentMaterialEvents[].claim`, and
 * `factLedger[].claim`.
 *
 * The screen runs at the source instead of in the gate. Deciding, from wording alone, whether a
 * match names a declared absence or an authored assertion is exactly what a narrowed pattern could
 * not do: an assertion sits on either side of the term, or inside the subject enumeration, and
 * three separate attempts each left a hole. So tripping model-authored text is dropped or replaced
 * rather than reworded, and its absence is declared instead of laundered.
 *
 * Origin decides the disposition, which is why the screen is applied per call site rather than to
 * a merged structure:
 * - `subjectSummary` and `questions.<key>` are required, fixed-shape answers. A tripping answer is
 *   replaced by a code-generated withheld notice; removing the field would break the shape.
 *   Keeping the original sourceIds is a choice, not a schema necessity: `EMPTY_ANSWER` is the
 *   sanctioned unusable-answer sentinel (citation rejections already use it at parse), which makes
 *   `requireAny` false and which markdown and the Console both suppress. Inheritance is kept so
 *   the notice stays visible and so `profileSourceIds` / `artifact.sourceIds` still list the
 *   sources that produced the withheld text — those IDs gate framework reconciliation and reuse.
 *   Partial-acceptance impact is computed from the pre-screen `parsed.profile`, so inheritance does
 *   not reach it. The attribution cost is that a withheld answer still carries those citations;
 *   `citedAnswer`, `companyDescription`, and `substantiveAnswerSourceIds` must not treat the notice
 *   as a real answer.
 * - `recentMaterialEvents`, `factLedger`, and `openGaps` are arrays, so they take drop-plus-count:
 *   tripping entries are dropped and one code-generated notice carrying the count is appended.
 *   Inheritance of withheld sourceIds on those notice facts is forced: the extras reader drops
 *   zero-sourceId facts, and an emptied `factLedger` then fails sidecar reuse reads.
 * - model-authored entries (and entries read back off disk, whose origin is no longer knowable)
 *   are dropped or replaced, and the run declares what it withheld: the notice plus a matching
 *   SourceGap. The original wording stays in the run's raw `stages.json` stage output.
 * - the code-generated summaries below are asserted, not dropped: wording the generator produced
 *   is a bug in the generator, and laundering it would hide that.
 * - externally-derived failure detail interpolated into an empty artifact is replaced wholesale
 *   (see `emptyArtifact`); a provider error string is neither ours to assert on nor safe to keep.
 */
// SubjectLabel and companyName are model-authored but out of scope: webSubjectProfileSegments
// Does not scan them, so they cannot fail the gate. This screen covers every scanned string.
interface ScreenableProfileFields {
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly string[];
}

interface ScreenedProfileFields extends ScreenableProfileFields {
  readonly withheldGaps: readonly SourceGap[];
}

function assertCodeAssembledProfileText(text: string, origin: string): string {
  const violation = violatesResearchOnly(text);
  if (violation !== null) {
    throw new Error(
      `Web Subject Profile ${origin} is code-assembled and must not carry research-only wording: "${violation.match}"`,
    );
  }
  return text;
}

function withheldCountSummary(noun: string, withheldCount: number, totalCount: number): string {
  return (
    `Web Subject Profile: ${String(withheldCount)} of ${String(totalCount)} ${noun} ` +
    `${WEB_SUBJECT_PROFILE_WITHHELD_MARKER}; the original wording stays in the run's raw stage output.`
  );
}

function screenRequiredAnswer(
  answer: WebSubjectProfileAnswer,
  notice: string,
  origin: string,
): {
  readonly answer: WebSubjectProfileAnswer;
  readonly withheld: boolean;
} {
  if (answer.answer === "") {
    return { answer, withheld: false };
  }
  if (violatesResearchOnly(answer.answer) !== null) {
    if (answer.sourceIds.length === 0) {
      return { answer: EMPTY_ANSWER, withheld: true };
    }
    return {
      answer: {
        answer: assertCodeAssembledProfileText(notice, origin),
        sourceIds: answer.sourceIds,
      },
      withheld: true,
    };
  }
  if (isWebSubjectProfileWithheldAnswer(answer.answer)) {
    return { answer, withheld: true };
  }
  return { answer, withheld: false };
}

function screenModelQuestions(questions: Readonly<Record<string, WebSubjectProfileAnswer>>): {
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly withheldCount: number;
  readonly totalCount: number;
} {
  const entries = Object.entries(questions);
  let withheldCount = 0;
  const next: [string, WebSubjectProfileAnswer][] = [];
  for (const [key, answer] of entries) {
    const screened = screenRequiredAnswer(
      answer,
      WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE,
      "withheld-answer notice",
    );
    if (screened.withheld) {
      withheldCount += 1;
    }
    next.push([key, screened.answer]);
  }
  return {
    questions: withheldCount === 0 ? questions : Object.fromEntries(next),
    withheldCount,
    totalCount: entries.length,
  };
}

function screenModelFacts(
  facts: readonly WebSubjectProfileFact[],
  fieldLabel: string,
  origin: string,
): {
  readonly facts: readonly WebSubjectProfileFact[];
  readonly withheldGaps: readonly SourceGap[];
} {
  if (facts.length === 0) {
    return { facts, withheldGaps: [] };
  }
  const kept: WebSubjectProfileFact[] = [];
  const withheld: WebSubjectProfileFact[] = [];
  const preexistingNotices: WebSubjectProfileFact[] = [];
  for (const fact of facts) {
    if (violatesResearchOnly(fact.claim) !== null) {
      withheld.push(fact);
    } else if (isWebSubjectProfileWithheldAnswer(fact.claim)) {
      preexistingNotices.push(fact);
      kept.push(fact);
    } else {
      kept.push(fact);
    }
  }
  if (withheld.length === 0 && preexistingNotices.length === 0) {
    return { facts, withheldGaps: [] };
  }
  const gaps: SourceGap[] = [];
  if (preexistingNotices[0] !== undefined) {
    gaps.push(
      profileGap(
        assertCodeAssembledProfileText(preexistingNotices[0].claim, origin),
        "validation-failed",
      ),
    );
  }
  if (withheld.length === 0) {
    return { facts: kept, withheldGaps: gaps };
  }
  const considered = facts.length - preexistingNotices.length;
  const summary = assertCodeAssembledProfileText(
    withheldCountSummary(fieldLabel, withheld.length, considered),
    origin,
  );
  const sourceIds = [...new Set(withheld.flatMap((fact) => fact.sourceIds))].toSorted();
  return {
    facts: [...kept, { claim: summary, sourceIds }],
    withheldGaps: [...gaps, profileGap(summary, "validation-failed")],
  };
}

function screenModelOpenGaps(gaps: readonly string[]): {
  readonly kept: readonly string[];
  readonly withheldCount: number;
  readonly preexistingNotices: readonly string[];
} {
  const preexistingNotices: string[] = [];
  const kept: string[] = [];
  let withheldCount = 0;
  for (const gap of gaps) {
    if (violatesResearchOnly(gap) !== null) {
      withheldCount += 1;
    } else if (isWebSubjectProfileWithheldAnswer(gap)) {
      preexistingNotices.push(gap);
    } else {
      kept.push(gap);
    }
  }
  return { kept, withheldCount, preexistingNotices };
}

function screenProfileFields(profile: ScreenableProfileFields): ScreenedProfileFields {
  const subjectSummary = screenRequiredAnswer(
    profile.subjectSummary,
    WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
    "withheld-summary notice",
  );
  const questions = screenModelQuestions(profile.questions);
  const events = screenModelFacts(
    profile.recentMaterialEvents,
    "recent material events",
    "withheld-events summary",
  );
  const ledger = screenModelFacts(
    profile.factLedger,
    "fact-ledger claims",
    "withheld-facts summary",
  );
  const openGaps = screenModelOpenGaps(profile.openGaps);
  const withheldGaps: SourceGap[] = [];
  if (subjectSummary.withheld) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
          "withheld-summary gap",
        ),
        "validation-failed",
      ),
    );
  }
  if (questions.withheldCount > 0) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(
          withheldCountSummary("question answers", questions.withheldCount, questions.totalCount),
          "withheld-questions summary",
        ),
        "validation-failed",
      ),
    );
  }
  if (events.withheldGaps.length > 0) {
    withheldGaps.push(...events.withheldGaps);
  }
  if (ledger.withheldGaps.length > 0) {
    withheldGaps.push(...ledger.withheldGaps);
  }
  const withheldOpenGapsNotice =
    openGaps.withheldCount === 0
      ? undefined
      : assertCodeAssembledProfileText(
          withheldCountSummary(
            "declared open gaps",
            openGaps.withheldCount,
            openGaps.kept.length + openGaps.withheldCount,
          ),
          "withheld-gaps summary",
        );
  if (withheldOpenGapsNotice !== undefined) {
    withheldGaps.push(profileGap(withheldOpenGapsNotice, "validation-failed"));
  }
  if (openGaps.preexistingNotices[0] !== undefined) {
    withheldGaps.push(
      profileGap(
        assertCodeAssembledProfileText(openGaps.preexistingNotices[0], "withheld-gaps summary"),
        "validation-failed",
      ),
    );
  }
  return {
    subjectSummary: subjectSummary.answer,
    questions: questions.questions,
    recentMaterialEvents: events.facts,
    factLedger: ledger.facts,
    openGaps:
      withheldOpenGapsNotice === undefined
        ? profile.openGaps
        : [...openGaps.kept, ...openGaps.preexistingNotices, withheldOpenGapsNotice],
    withheldGaps,
  };
}

function applyScreenedFields(
  artifact: WebSubjectProfileArtifact,
  screened: ScreenableProfileFields,
): WebSubjectProfileArtifact {
  return {
    ...artifact,
    subjectSummary: screened.subjectSummary,
    questions: screened.questions,
    recentMaterialEvents: screened.recentMaterialEvents,
    factLedger: screened.factLedger,
    openGaps: screened.openGaps,
    sourceIds: profileSourceIds(screened),
  } as WebSubjectProfileArtifact;
}

// A failure message can interpolate a provider or model error string, which is external text. It
// Is neither code-assembled enough to assert on nor safe to publish, so a tripping message is
// Replaced entirely; the unscreened detail survives on the transient SourceGap, which is outside
// The report-language scan (ADR 0001).
const WITHHELD_FAILURE_GAP = `Web Subject Profile unavailable; the stage failure detail was ${WEB_SUBJECT_PROFILE_WITHHELD_MARKER}.`;

function screenedFailureOpenGap(gap: string): string {
  return violatesResearchOnly(gap) === null ? gap : WITHHELD_FAILURE_GAP;
}

/*
 * Reuse reads an artifact persisted by an earlier run, possibly one written before this screen
 * existed, and by then a code-generated entry is indistinguishable from a model-authored one. The
 * drop/replace rule is therefore the only safe one here. `violatesResearchOnly` runs first: a
 * string that contains the withheld marker and a banned phrase is a violation, not a notice.
 * Pre-existing clean notices are then counted via `isWebSubjectProfileWithheldAnswer` so the
 * reusing run re-emits the matching Source Gaps instead of dropping the declaration.
 */
function screenReusedArtifact(artifact: WebSubjectProfileArtifact): {
  readonly artifact: WebSubjectProfileArtifact;
  readonly withheldGaps: readonly SourceGap[];
} {
  const screened = screenProfileFields(artifact);
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
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
}): WebSubjectProfileResult {
  const webSourceIds = new Set(input.webSources.map((source) => source.id));
  if (webSourceIds.size === 0) {
    const message = `Web Subject Profile skipped for ${input.subject.subjectId}: no gathered web Sources`;
    const artifact = emptyArtifact(
      input.subject,
      input.generatedAt,
      input.runId,
      message,
      input.secFilingBasisDate,
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
      input.secFilingBasisDate,
    );
    const gap = profileGap(message, "validation-failed");
    return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
  }

  const screened = screenProfileFields(parsed.profile);
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
    openGaps: [...screened.openGaps, ...(rejectionSummary === undefined ? [] : [rejectionSummary])],
  };
  const sourceIds = profileSourceIds(profileForArtifact);
  const artifact = profileArtifact({
    subject: input.subject,
    generatedAt: input.generatedAt,
    originRunDirName: input.runId,
    profile: profileForArtifact,
    sourceIds,
    ...(input.secFilingBasisDate !== undefined
      ? { secFilingBasisDate: input.secFilingBasisDate }
      : {}),
  });
  return profileResult(input.command, input.extendedEvidence, input.subject, artifact, sourceIds, [
    ...(rejectionGap === undefined ? [] : [rejectionGap]),
    ...screened.withheldGaps,
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
}): WebSubjectProfileResult {
  const artifact = emptyArtifact(
    input.subject,
    input.generatedAt,
    input.runId,
    input.message,
    input.secFilingBasisDate,
  );
  const gap = profileGap(input.message, input.cause);
  return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
}

export function buildWebSubjectProfileReuseEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly artifact: WebSubjectProfileArtifact;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly freshnessGap: SourceGap;
}): WebSubjectProfileResult {
  const screened = screenReusedArtifact(input.artifact);
  return profileResult(
    input.command,
    input.extendedEvidence,
    input.subject,
    screened.artifact,
    screened.artifact.sourceIds,
    [input.freshnessGap, ...screened.withheldGaps],
  );
}

interface ParsedProfile {
  readonly subjectLabel?: string;
  readonly companyName?: string;
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly string[];
}

type AnswerSourceIdFailure =
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly count: number };

// A single rejected question/fact salvaged out of an otherwise-usable profile. Field paths are
// Code-generated and safe to disclose; model-controlled rejection content is not retained.
interface ProfileRejection {
  readonly field: string;
  readonly answerSourceIdFailure?: AnswerSourceIdFailure;
}

function parseProfile(
  content: string,
  subjectKind: SubjectKind,
  webSourceIds: ReadonlySet<string>,
):
  | { readonly profile: ParsedProfile; readonly rejections: readonly ProfileRejection[] }
  | { readonly error: string } {
  const parsed = parseJsonContent(content);
  if (parsed === undefined) {
    return { error: "model output was not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { error: "model output must be an object" };
  }
  const subjectSummary = readAnswer(parsed.subjectSummary, webSourceIds);
  const subjectSummaryRejections: ProfileRejection[] =
    "error" in subjectSummary
      ? [
          {
            field: "subjectSummary",
            ...(subjectSummary.sourceIdFailure !== undefined
              ? { answerSourceIdFailure: subjectSummary.sourceIdFailure }
              : {}),
          },
        ]
      : [];
  const questions = readQuestions(parsed.questions, subjectKind, webSourceIds);
  if ("error" in questions) {
    return questions;
  }
  const recentMaterialEvents = readFacts(
    parsed.recentMaterialEvents,
    webSourceIds,
    "recentMaterialEvents",
  );
  if ("error" in recentMaterialEvents) {
    return recentMaterialEvents;
  }
  const factLedger = readFacts(parsed.factLedger, webSourceIds, "factLedger");
  if ("error" in factLedger) {
    return factLedger;
  }
  if (factLedger.facts.length === 0) {
    return { error: "factLedger must contain at least one cited fact" };
  }
  const subjectLabel = readString(parsed, "subjectLabel");
  const companyName = readString(parsed, "companyName");
  return {
    profile: {
      subjectSummary: "error" in subjectSummary ? EMPTY_ANSWER : subjectSummary.answer,
      questions: questions.questions,
      recentMaterialEvents: recentMaterialEvents.facts,
      factLedger: factLedger.facts,
      openGaps: stringArrayValue(parsed.openGaps),
      ...(subjectLabel !== undefined ? { subjectLabel } : {}),
      ...(companyName !== undefined ? { companyName } : {}),
    },
    rejections: [
      ...subjectSummaryRejections,
      ...questions.rejections,
      ...recentMaterialEvents.rejections,
      ...factLedger.rejections,
    ],
  };
}

function parseJsonContent(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function readQuestions(
  value: unknown,
  subjectKind: SubjectKind,
  webSourceIds: ReadonlySet<string>,
):
  | {
      readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
      readonly rejections: readonly ProfileRejection[];
    }
  | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "questions must be an object" };
  }
  const entries: [string, WebSubjectProfileAnswer][] = [];
  const rejections: ProfileRejection[] = [];
  for (const key of WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind]) {
    const answer = readAnswer(value[key], webSourceIds);
    if ("error" in answer) {
      // One bad answer costs this question only.
      rejections.push({
        field: `questions.${key}`,
        ...(answer.sourceIdFailure !== undefined
          ? { answerSourceIdFailure: answer.sourceIdFailure }
          : {}),
      });
      entries.push([key, EMPTY_ANSWER]);
      continue;
    }
    entries.push([key, answer.answer]);
  }
  return { questions: Object.fromEntries(entries), rejections };
}

function disallowedSourceIdsOf(
  sourceIds: readonly string[],
  webSourceIds: ReadonlySet<string>,
): readonly string[] {
  return sourceIds.filter((sourceId) => !webSourceIds.has(sourceId));
}

function readAnswer(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
):
  | { readonly answer: WebSubjectProfileAnswer }
  | { readonly error: true; readonly sourceIdFailure?: AnswerSourceIdFailure } {
  if (!isRecord(value)) {
    return { error: true };
  }
  const answer = readString(value, "answer");
  const sourceIds = nonEmptyStringArrayValue(value.sourceIds);
  const disallowedSourceIds = disallowedSourceIdsOf(sourceIds, webSourceIds);
  const unknownSourceIdCount = new Set(disallowedSourceIds).size;
  if (answer === undefined) {
    return { error: true };
  }
  if (sourceIds.length === 0) {
    return { error: true, sourceIdFailure: { kind: "missing" } };
  }
  if (unknownSourceIdCount > 0) {
    return {
      error: true,
      sourceIdFailure: { kind: "unknown", count: unknownSourceIdCount },
    };
  }
  return { answer: { answer, sourceIds } };
}

function readFacts(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
  field: string,
):
  | {
      readonly facts: readonly WebSubjectProfileFact[];
      readonly rejections: readonly ProfileRejection[];
    }
  | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: `${field} must be an array` };
  }
  const facts: WebSubjectProfileFact[] = [];
  const rejections: ProfileRejection[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      rejections.push({
        field: `${field}[${index}]`,
      });
      return;
    }
    const claim = readString(item, "claim");
    const sourceIds = nonEmptyStringArrayValue(item.sourceIds);
    const disallowedSourceIds = disallowedSourceIdsOf(sourceIds, webSourceIds);
    if (claim === undefined || sourceIds.length === 0 || disallowedSourceIds.length > 0) {
      // Per-item rejection: this fact is dropped, but siblings in the same
      // Array are still evaluated (B1.1). The allowlist check above still
      // Rejects the whole item if any cited id is disallowed — no partial
      // Admission of a mixed valid/invalid sourceIds list (non-negotiable).
      rejections.push({
        field: `${field}[${index}]`,
      });
      return;
    }
    facts.push({ claim, sourceIds });
  });
  return { facts, rejections };
}

function profileSourceIds(profile: ScreenableProfileFields): readonly string[] {
  return [
    ...new Set([
      ...profile.subjectSummary.sourceIds,
      ...Object.values(profile.questions).flatMap((answer) => answer.sourceIds),
      ...profile.recentMaterialEvents.flatMap((fact) => fact.sourceIds),
      ...profile.factLedger.flatMap((fact) => fact.sourceIds),
    ]),
  ].toSorted();
}

function emptyQuestions(
  subjectKind: SubjectKind,
): Readonly<Record<string, WebSubjectProfileAnswer>> {
  return Object.fromEntries(
    WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind].map((key) => [key, EMPTY_ANSWER]),
  );
}

function emptyArtifact(
  subject: WebSubjectProfileSubject,
  generatedAt: string,
  originRunDirName: string,
  gap: string,
  secFilingBasisDate?: string,
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
      ...(secFilingBasisDate !== undefined ? { secFilingBasisDate } : {}),
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
  readonly secFilingBasisDate?: string;
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
      ...(input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
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

function profileGap(
  message: string,
  cause: NonNullable<SourceGap["cause"]>,
  evidenceQualityImpact: NonNullable<SourceGap["evidenceQualityImpact"]> = "extended-evidence-cap",
): SourceGap {
  return sourceGap({
    source: "web-subject-profile",
    message,
    provider: "market-bot",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact,
  });
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
    (answer) => answer.sourceIds.length > 0,
  ).length;
  const survivingFacts = profile.factLedger.length + profile.recentMaterialEvents.length;
  // Every subject kind defines a fixed, non-empty question set (contract.ts),
  // So totalQuestions is always > 0 here.
  const sufficientQuestions = answeredQuestions / totalQuestions >= MIN_ANSWERED_QUESTION_RATIO;
  const sufficientFacts = survivingFacts >= MIN_SURVIVING_FACT_COUNT;
  const hasSubjectSummary = profile.subjectSummary.sourceIds.length > 0;
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
