import { violatesResearchOnly } from "../domain/research-language";
import { sourceGap } from "../domain/source-gaps";
import type { SubjectKind } from "../domain/evidence";
import type { SourceGap } from "../domain/sources";
import { isRecord, nonEmptyStringArrayValue, readString } from "../guards";
import { readFigureQuotes } from "../report/figure-quotes";
import {
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileFact,
  type WebSubjectProfileOpenGap,
  readWebSubjectProfileOpenGap,
  unreadableOpenGapsNotice,
} from "./contract";

export const EMPTY_ANSWER: WebSubjectProfileAnswer = { answer: "", sourceIds: [] };
// Profile assembly never resolves references, so a raw token would publish verbatim.
const METRIC_TOKEN = /<<\s*metric\s*:/iu;

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
export interface ScreenableProfileFields {
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly WebSubjectProfileOpenGap[];
}

// A failure message can interpolate a provider or model error string, which is external text. It
// Is neither code-assembled enough to assert on nor safe to publish, so a tripping message is
// Replaced entirely; the unscreened detail survives on the transient SourceGap, which is outside
// The report-language scan (ADR 0001).
const WITHHELD_FAILURE_GAP = `Web Subject Profile unavailable; the stage failure detail was ${WEB_SUBJECT_PROFILE_WITHHELD_MARKER}.`;

function parsedOpenGaps(value: unknown): readonly WebSubjectProfileOpenGap[] {
  const items: readonly unknown[] = Array.isArray(value) ? value : [];
  const readable = items.flatMap((item) => readWebSubjectProfileOpenGap(item) ?? []);
  return [
    ...readable.filter((gap) => !METRIC_TOKEN.test(gap.text)),
    ...(readable.length < items.length
      ? [otherGap(unreadableOpenGapsNotice(items.length - readable.length))]
      : []),
  ];
}

export function screenedFailureOpenGap(gap: string): WebSubjectProfileOpenGap {
  return otherGap(violatesResearchOnly(gap) === null ? gap : WITHHELD_FAILURE_GAP);
}

export function otherGap(text: string): WebSubjectProfileOpenGap {
  return { text, topic: "other" };
}

export interface ParsedProfile {
  readonly subjectLabel?: string;
  readonly companyName?: string;
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly WebSubjectProfileOpenGap[];
}

type AnswerSourceIdFailure =
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly count: number };

// A single rejected question/fact salvaged out of an otherwise-usable profile. Field paths are
// Code-generated and safe to disclose; model-controlled rejection content is not retained.
export interface ProfileRejection {
  readonly field: string;
  readonly answerSourceIdFailure?: AnswerSourceIdFailure;
}

export function parseProfile(
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
    profile: withoutSourceIdMarkers({
      subjectSummary: "error" in subjectSummary ? EMPTY_ANSWER : subjectSummary.answer,
      questions: questions.questions,
      recentMaterialEvents: recentMaterialEvents.facts,
      factLedger: factLedger.facts,
      openGaps: parsedOpenGaps(parsed.openGaps),
      ...(subjectLabel !== undefined ? { subjectLabel } : {}),
      ...(companyName !== undefined ? { companyName } : {}),
    }),
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
  if (answer === undefined || METRIC_TOKEN.test(answer)) {
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
  const figureQuotes = readFigureQuotes(value.figureQuotes);
  return { answer: { answer, sourceIds, ...(figureQuotes === undefined ? {} : { figureQuotes }) } };
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
    if (
      claim === undefined ||
      METRIC_TOKEN.test(claim) ||
      sourceIds.length === 0 ||
      disallowedSourceIds.length > 0
    ) {
      // Per-item rejection: this fact is dropped, but siblings in the same
      // Array are still evaluated (B1.1). The allowlist check above still
      // Rejects the whole item if any cited id is disallowed — no partial
      // Admission of a mixed valid/invalid sourceIds list (non-negotiable).
      rejections.push({
        field: `${field}[${index}]`,
      });
      return;
    }
    const figureQuotes = readFigureQuotes(item.figureQuotes);
    facts.push({ claim, sourceIds, ...(figureQuotes === undefined ? {} : { figureQuotes }) });
  });
  return { facts, rejections };
}

// Models sometimes echo `[sourceId]` inline; renderers already append the structured refs.
export function withoutSourceIdMarkers<
  T extends ScreenableProfileFields & {
    readonly subjectLabel?: string;
    readonly companyName?: string;
  },
>(profile: T): T {
  const ids = profileSourceIds(profile)
    .map((id) => id.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  const marker = String.raw`\[\s*(?:${ids})(?:\s*,\s*(?:${ids}))*\s*\]`;
  const markerRun = new RegExp(String.raw`[^\S\r\n]*(?:${marker}[^\S\r\n]*)+`, "gu");
  const strip = (text: string): string => {
    if (ids === "") {
      return text;
    }
    const stripped = text.replaceAll(markerRun, (run: string, offset: number) =>
      /^[\r\n([{]?$/u.test(text[offset - 1] ?? "") ||
      /^[\r\n.,;:!?)\]}"'’”]?$/u.test(text[offset + run.length] ?? "")
        ? ""
        : " ",
    );
    return stripped !== text && stripped.trim() === "" ? "" : stripped;
  };
  const answer = (value: WebSubjectProfileAnswer) => ({ ...value, answer: strip(value.answer) });
  const fact = (value: WebSubjectProfileFact) => ({ ...value, claim: strip(value.claim) });
  return {
    ...profile,
    subjectSummary: answer(profile.subjectSummary),
    questions: Object.fromEntries(
      Object.entries(profile.questions).map(([key, value]) => [key, answer(value)]),
    ),
    recentMaterialEvents: profile.recentMaterialEvents.map(fact),
    factLedger: profile.factLedger.map(fact),
    openGaps: profile.openGaps
      .map((gap) => ({ ...gap, text: strip(gap.text) }))
      .filter((gap) => gap.text !== ""),
    ...(profile.subjectLabel !== undefined ? { subjectLabel: strip(profile.subjectLabel) } : {}),
    ...(profile.companyName !== undefined ? { companyName: strip(profile.companyName) } : {}),
  };
}

export function profileSourceIds(profile: ScreenableProfileFields): readonly string[] {
  return [
    ...new Set([
      ...profile.subjectSummary.sourceIds,
      ...Object.values(profile.questions).flatMap((answer) => answer.sourceIds),
      ...profile.recentMaterialEvents.flatMap((fact) => fact.sourceIds),
      ...profile.factLedger.flatMap((fact) => fact.sourceIds),
    ]),
  ].toSorted();
}

export function profileGap(
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
