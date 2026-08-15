// Shared contract for the two `report.extras` payloads that have a single producer
// In src/research/extended-evidence-projections.ts and several independent readers:
// The markdown renderers, the source-id traversal, and the Research Console.
//
// Two type families, on purpose:
//
//   *Extra      — what the producer emits. Narrow, artifact-derived, used as the
//                 Producer's return annotation so an unsupported phase, section
//                 Name, posture, or subject kind is a compile error at the source.
//   *ExtraValue — what the readers return. STRUCTURAL, not validating. It admits
//                 Everything the markdown renderers accepted before this module
//                 Existed, because the readers replaced ad-hoc `isRecord` walks
//                 And constraint 5 of the plan makes those walks the spec.
//
// So the readers do not decide what is renderable. They drop a row only where the
// Old walks dropped it — a non-record, or a value of the wrong primitive type —
// And every "is this worth showing" question (empty text, unknown subject kind,
// Missing phase, equity trims) stays in the renderer that asks it. Two rules
// Follow from that and are easy to get wrong:
//
//   - An absent collection stays absent. `sections: undefined` and `sections: []`
//     Render differently (omitted section vs a bare header), so the reader must
//     Not default one to the other.
//   - A row whose text is empty or malformed is KEPT, because the source-id
//     Traversal still cites it. Only the renderer skips it.
//
// The leaf readers shared back into src/run-artifacts.ts (readWebSubjectProfileAnswer,
// ReadWebSubjectProfileFacts) are the strict artifact ones, moved here unchanged.

import type { SubjectKind } from "../domain/types";
import {
  isBusinessFrameworkGapCode,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkGapCode,
  type BusinessFrameworkMetric,
  type BusinessFrameworkReconciliation,
  type BusinessFrameworkSection,
} from "../sources/extended-evidence/business-framework";
import type { LensValueUnit } from "../sources/extended-evidence/value-format";
// Import the public profile contract leaf directly, not the ./web-evidence barrel,
// Which eagerly exports the web-evidence phase.
import {
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileFact,
  type WebSubjectProfileQuestionKey,
} from "../web-evidence/contract";
import { isRecord, readString, readStringArray, readStringVerbatim } from "../guards";

// ---------------------------------------------------------------------------
// Producer contract
// ---------------------------------------------------------------------------

// The model may attach a narrative `text` to a section; everything else is the
// Deterministic artifact section verbatim.
type BusinessFrameworkExtraSection = BusinessFrameworkSection & {
  readonly text?: string;
};

export type BusinessFrameworkExtra = Omit<
  BusinessFrameworkArtifact,
  "generatedAt" | "symbol" | "sections"
> & {
  readonly sections: readonly BusinessFrameworkExtraSection[];
};

export interface WebSubjectProfileExtra {
  readonly version: 2 | 3;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly symbol?: string;
  readonly companyName?: string;
  readonly subjectSummary?: WebSubjectProfileAnswer;
  readonly questions: Readonly<
    Partial<Record<WebSubjectProfileQuestionKey, WebSubjectProfileAnswer>>
  >;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly string[];
  readonly sourceIds: readonly string[];
  readonly secFilingBasisDate?: string;
}

// ---------------------------------------------------------------------------
// Reader results
// ---------------------------------------------------------------------------

// A gap is a bare text, or a text with a code when the code is recognized.
// Choosing which part to display is render policy.
export type BusinessFrameworkExtraGap =
  | string
  | { readonly code?: BusinessFrameworkGapCode; readonly text: string };

interface BusinessFrameworkSectionValue {
  // Optional, and not narrowed to BusinessFrameworkSectionName: the old walk
  // Rendered any string name and cited a nameless row's sources anyway. The
  // Equity trim still matches on the lowercased text.
  readonly name?: string;
  readonly posture?: string;
  readonly summary?: string;
  readonly text?: string;
  // Per-item valid entries. `sourceIdsComplete` is false when the raw array had
  // A non-string member, which markdown treats as no citations at all.
  readonly sourceIds: readonly string[];
  readonly sourceIdsComplete: boolean;
  readonly gaps: readonly BusinessFrameworkExtraGap[];
  readonly metrics: readonly BusinessFrameworkMetric[];
}

export interface BusinessFrameworkExtraValue {
  readonly version?: number;
  readonly phase?: string;
  // Undefined when the payload carries no `sections` array at all. The markdown
  // Renderer treats that as "no framework section", which `[]` would not.
  readonly sections?: readonly BusinessFrameworkSectionValue[];
  readonly sourceIds: readonly string[];
  readonly sourceIdsComplete: boolean;
  readonly gaps: readonly BusinessFrameworkExtraGap[];
  readonly reconciliation?: BusinessFrameworkReconciliation;
}

// Text is optional and kept verbatim, including the empty string: the traversal
// Cites a row whose text is missing or blank, and only the renderer skips it.
export interface WebSubjectProfileAnswerValue {
  readonly answer?: string;
  readonly sourceIds: readonly string[];
  readonly sourceIdsComplete: boolean;
}

export interface WebSubjectProfileFactValue {
  readonly claim?: string;
  readonly sourceIds: readonly string[];
  readonly sourceIdsComplete: boolean;
}

export interface WebSubjectProfileExtraValue {
  readonly version?: number;
  readonly subjectKind?: string;
  readonly subjectId?: string;
  readonly subjectLabel?: string;
  readonly symbol?: string;
  readonly companyName?: string;
  readonly subjectSummary?: WebSubjectProfileAnswerValue;
  // Undefined when the payload carries no `questions` record. As with sections,
  // The markdown renderer omits the whole profile in that case.
  readonly questions?: Readonly<Record<string, WebSubjectProfileAnswerValue>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFactValue[];
  readonly factLedger: readonly WebSubjectProfileFactValue[];
  readonly openGaps: readonly string[];
  readonly openGapsComplete: boolean;
  readonly sourceIds: readonly string[];
  readonly sourceIdsComplete: boolean;
  readonly secFilingBasisDate?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LENS_VALUE_UNITS: ReadonlySet<string> = new Set<LensValueUnit>([
  "ratio",
  "ratio-percent",
  "whole-percent",
  "currency",
  "number",
  "text",
]);

function isSubjectKind(value: unknown): value is SubjectKind {
  return value === "company" || value === "crypto-asset" || value === "theme";
}

// The two consumers genuinely disagreed at HEAD: markdown treated an array with
// Any non-string member as wholly malformed, the Console kept the valid entries.
// No single array can satisfy both, so the reader keeps the more informative
// Half — the valid entries — plus a `*Complete` flag, and markdown re-applies
// Its all-or-nothing rule at the point of use.
function stringList(
  value: Record<string, unknown>,
  key = "sourceIds",
): { readonly values: readonly string[]; readonly complete: boolean } {
  const raw = value[key];
  if (!Array.isArray(raw)) {
    return { values: [], complete: true };
  }
  const values = raw.filter((item): item is string => typeof item === "string");
  return { values, complete: values.length === raw.length };
}

// For arrays no renderer consumes all-or-nothing, where the flag would be noise.
function stringsOf(value: Record<string, unknown>, key = "sourceIds"): readonly string[] {
  return stringList(value, key).values;
}

function numberAt(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === "number" ? raw : undefined;
}

// The unknown-kind fallback both the markdown renderer and the Console rely on.
export function webSubjectProfileQuestionKeys(
  subjectKind: unknown,
): readonly WebSubjectProfileQuestionKey[] {
  return isSubjectKind(subjectKind)
    ? WEB_SUBJECT_PROFILE_QUESTION_KEYS[subjectKind]
    : WEB_SUBJECT_PROFILE_QUESTION_KEYS.company;
}

// ---------------------------------------------------------------------------
// Business framework
// ---------------------------------------------------------------------------

function readBusinessFrameworkMetric(value: unknown): BusinessFrameworkMetric | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { key, label, unit, value: raw, currency } = value;
  if (
    typeof key !== "string" ||
    typeof label !== "string" ||
    typeof unit !== "string" ||
    !LENS_VALUE_UNITS.has(unit) ||
    (typeof raw !== "number" && typeof raw !== "string")
  ) {
    return undefined;
  }
  return {
    key,
    label,
    value: raw,
    unit: unit as LensValueUnit,
    sourceIds: stringsOf(value),
    ...(typeof currency === "string" ? { currency } : {}),
  };
}

function readBusinessFrameworkGaps(value: unknown): readonly BusinessFrameworkExtraGap[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((gap): readonly BusinessFrameworkExtraGap[] => {
    if (typeof gap === "string") {
      return [gap];
    }
    if (!isRecord(gap) || typeof gap.text !== "string") {
      return [];
    }
    const { code, text } = gap;
    return [
      typeof code === "string" && isBusinessFrameworkGapCode(code) ? { code, text } : { text },
    ];
  });
}

function readBusinessFrameworkSection(value: unknown): BusinessFrameworkSectionValue | undefined {
  // Every record survives, nameless included: the source traversal cites it and
  // Only the renderer needs a name.
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, posture, summary, text } = value;
  const sourceIds = stringList(value);
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof posture === "string" ? { posture } : {}),
    ...(typeof summary === "string" ? { summary } : {}),
    ...(typeof text === "string" ? { text } : {}),
    sourceIds: sourceIds.values,
    sourceIdsComplete: sourceIds.complete,
    gaps: readBusinessFrameworkGaps(value.gaps),
    metrics: Array.isArray(value.metrics)
      ? value.metrics.flatMap((metric): readonly BusinessFrameworkMetric[] => {
          const parsed = readBusinessFrameworkMetric(metric);
          return parsed === undefined ? [] : [parsed];
        })
      : [],
  };
}

function readBusinessFrameworkReconciliation(
  value: unknown,
): BusinessFrameworkReconciliation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    resolvedGaps: stringsOf(value, "resolvedGaps").filter((code) =>
      isBusinessFrameworkGapCode(code),
    ),
    profileSourceIds: stringsOf(value, "profileSourceIds"),
  };
}

export function readBusinessFrameworkExtra(
  value: unknown,
): BusinessFrameworkExtraValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const reconciliation = readBusinessFrameworkReconciliation(value.reconciliation);
  const sourceIds = stringList(value);
  const version = numberAt(value, "version");
  const phase = readStringVerbatim(value, "phase");
  return {
    ...(version !== undefined ? { version } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(Array.isArray(value.sections)
      ? {
          sections: value.sections.flatMap((section): readonly BusinessFrameworkSectionValue[] => {
            const parsed = readBusinessFrameworkSection(section);
            return parsed === undefined ? [] : [parsed];
          }),
        }
      : {}),
    sourceIds: sourceIds.values,
    sourceIdsComplete: sourceIds.complete,
    gaps: readBusinessFrameworkGaps(value.gaps),
    ...(reconciliation !== undefined ? { reconciliation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Web subject profile
// ---------------------------------------------------------------------------

// Artifact leaves stay strict except for the persisted empty-answer sentinel.
export function readWebSubjectProfileAnswer(value: unknown): WebSubjectProfileAnswer | undefined {
  if (!isRecord(value)) {
    return;
  }
  const sourceIds = readStringArray(value, "sourceIds");
  if (value.answer === "" && sourceIds?.length === 0) {
    return { answer: "", sourceIds };
  }
  const answer = readString(value, "answer");
  return answer === undefined || sourceIds === undefined ? undefined : { answer, sourceIds };
}

export function readWebSubjectProfileFacts(
  value: unknown,
): readonly WebSubjectProfileFact[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  let malformed = false;
  const facts = value.flatMap((item): readonly WebSubjectProfileFact[] => {
    if (!isRecord(item)) {
      malformed = true;
      return [];
    }
    const claim = readString(item, "claim");
    const sourceIds = readStringArray(item, "sourceIds");
    if (claim === undefined || sourceIds === undefined) {
      malformed = true;
      return [];
    }
    return sourceIds.length === 0 ? [] : [{ claim, sourceIds }];
  });
  return malformed ? undefined : facts;
}

// Extras leaves: every record survives, text verbatim and optional.
function readAnswerValue(value: unknown): WebSubjectProfileAnswerValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const answer = readStringVerbatim(value, "answer");
  const sourceIds = stringList(value);
  return {
    ...(answer !== undefined ? { answer } : {}),
    sourceIds: sourceIds.values,
    sourceIdsComplete: sourceIds.complete,
  };
}

function readFactValues(value: unknown): readonly WebSubjectProfileFactValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly WebSubjectProfileFactValue[] => {
    if (!isRecord(item)) {
      return [];
    }
    const claim = readStringVerbatim(item, "claim");
    const sourceIds = stringList(item);
    return [
      {
        ...(claim !== undefined ? { claim } : {}),
        sourceIds: sourceIds.values,
        sourceIdsComplete: sourceIds.complete,
      },
    ];
  });
}

export function readWebSubjectProfileExtra(
  value: unknown,
): WebSubjectProfileExtraValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const version = numberAt(value, "version");
  const subjectKind = readStringVerbatim(value, "subjectKind");
  const subjectId = readString(value, "subjectId");
  // Labels are verbatim: the Console falls back subjectLabel -> companyName, so
  // Coercing a blank label to undefined would swap in a different visible label.
  const subjectLabel = readStringVerbatim(value, "subjectLabel");
  const symbol = readString(value, "symbol");
  const companyName = readStringVerbatim(value, "companyName");
  const secFilingBasisDate = readString(value, "secFilingBasisDate");
  const subjectSummary = readAnswerValue(value.subjectSummary);
  const openGaps = stringList(value, "openGaps");
  const sourceIds = stringList(value);
  return {
    ...(version !== undefined ? { version } : {}),
    ...(subjectKind !== undefined ? { subjectKind } : {}),
    ...(subjectId !== undefined ? { subjectId } : {}),
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(companyName !== undefined ? { companyName } : {}),
    ...(subjectSummary !== undefined ? { subjectSummary } : {}),
    // Every key is kept, not just this kind's: schema.ts:476-487 validates them
    // And the source traversal cites them. Ordering is the renderer's job.
    ...(isRecord(value.questions)
      ? {
          questions: Object.fromEntries(
            Object.entries(value.questions).flatMap(
              (entry): readonly (readonly [string, WebSubjectProfileAnswerValue])[] => {
                const answer = readAnswerValue(entry[1]);
                return answer === undefined ? [] : [[entry[0], answer]];
              },
            ),
          ),
        }
      : {}),
    recentMaterialEvents: readFactValues(value.recentMaterialEvents),
    factLedger: readFactValues(value.factLedger),
    openGaps: openGaps.values,
    openGapsComplete: openGaps.complete,
    sourceIds: sourceIds.values,
    sourceIdsComplete: sourceIds.complete,
    ...(secFilingBasisDate !== undefined ? { secFilingBasisDate } : {}),
  };
}
