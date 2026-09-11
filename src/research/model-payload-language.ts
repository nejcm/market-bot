import { violatesResearchOnly } from "../domain/research-language";
import { isRecord } from "../guards";
import type { ModelReportPayload } from "./report-assembly";

export interface ModelPayloadLanguageViolation {
  readonly field: string;
  readonly match: string;
}

/*
 * Every string the field holds, in traversal order. The scan below joins these with newlines
 * rather than scanning `JSON.stringify` output, matching assertSafeReportLanguage exactly: the
 * sentence-initial pattern needs `^` or one of `.!?;:\n` before the verb, and a JSON blob puts a
 * quote there instead, so a draft whose summary opens "Buy the dip" scanned clean under the blob.
 * JSON.stringify also escapes real newlines to a literal backslash-n, defeating that branch a
 * second time. The delimiter matters, so keep this a newline join.
 */
function payloadStrings(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => payloadStrings(item));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => payloadStrings(item));
  }
  return [];
}

/*
 * Field attribution is a hint: only the first match per top-level field is kept, and a phrase
 * straddling two strings joined for the scan is reported against the field that owns both.
 * An empty result means this draft had no detected match, so a report-level language rejection
 * came from somewhere else -- since assertSafeReportLanguage scans only model-authored prose
 * (ADR 0001, 2026-08-26), that is prose from an earlier model stage merged during assembly, such
 * as the Web Subject Profile. This is a failed-run diagnostic (run-artifact-writer.ts) only.
 * It does not decide whether repairs continue: absence from the draft does not make a rejection
 * unrepairable, because a draft can override most merged prose. Final synthesis decides that from
 * the rejected field's own path instead.
 */
export function modelPayloadLanguageViolations(
  payload: ModelReportPayload,
): readonly ModelPayloadLanguageViolation[] {
  return Object.entries(payload).flatMap(([field, value]) => {
    const violation = violatesResearchOnly(payloadStrings(value).join("\n"));
    return violation === null ? [] : [{ field, match: violation.match }];
  });
}
