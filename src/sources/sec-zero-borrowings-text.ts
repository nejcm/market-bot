import { dateLabels } from "./extended-evidence/earnings-date-confirmation";
import { normalizeFilingText } from "./sec-filing-text";

export const ZERO_BORROWINGS_TEXT_KEY = "zeroBorrowingText";
export const ZERO_BORROWINGS_REJECT_KEY = "zeroBorrowingReject";

const KINDS = [
  ["line of credit", /^lines? of credit$/iu],
  ["credit facility", /^credit facilit(?:y|ies)$/iu],
  ["term loan", /^term loans?$/iu],
  ["notes", /^(?:notes payable|senior notes|convertible notes)$/iu],
  ["factoring", /^factoring (?:arrangements?|facilit(?:y|ies))$/iu],
  ["commercial paper", /^commercial paper$/iu],
  ["overdraft", /^(?:bank )?overdrafts?$/iu],
] as const;
const KIND_TERM = String.raw`(lines? of credit|credit facilit(?:y|ies)|term loans?|notes payable|senior notes|convertible notes|factoring (?:arrangements?|facilit(?:y|ies))|commercial paper)`;
const PLURAL =
  /^(?:lines of credit|credit facilities|term loans|factoring (?:arrangements|facilities))$/iu;
const DATE = String.raw`((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})`;
const LEAD = String.raw`^(?:As of|At) ${DATE}(?: and ${DATE})?, (?:the Company|we) (?:had|has|have) no (?:outstanding )?`;
const FACILITY_ZERO = new RegExp(
  String.raw`${LEAD}(?:borrowings|amounts outstanding|debt outstanding|outstanding debt) (?:under|against|on) (?:its|our|the|this|that) ((?:[a-z-]+ ){0,3}?)${KIND_TERM}\.?$`,
  "iu",
);
const BARE_ZERO = new RegExp(String.raw`${LEAD}(?:debt|indebtedness|borrowings)\.?$`, "iu");
// Overdrafts are mentioned, never facility-zeroed: only a bare no-debt sentence covers them.
const MENTION = new RegExp(
  String.raw`((?:[\w$,.'-]+ ){0,4})\b(${KIND_TERM.slice(1, -1)}|(?:bank )?overdrafts?)\b`,
  "giu",
);
const NOT_MODIFIER =
  /^(?:a|an|the|its|our|their|this|that|these|those|of|and|or|under|against|on|with|to|from|for|by|in|at|any|all|each|such|no|has|have|had|is|was|\W*|[\d$,.]+|[\w-]+'s|[\w-]*\W)$/iu;
// Disposal-group borrowings are withheld by the held-for-sale checks, so only continuing facilities need cover.
const DISPOSAL = /discontinued operations|held for sale/iu;
const CONTINUING =
  /unrelated to|continuing|\b(?:not|no longer)\b[^.]*?(?:held for sale|discontinued)/iu;
const PARENT_ONLY = /parent company only|excluding its consolidated subsidiaries|registrant only/iu;

const kindOf = (term: string) => KINDS.find(([, pattern]) => pattern.test(term))?.[0];
// The adjective run before the term names the facility ("domestic revolving"); it stops at determiners and verbs.
const modifierKey = (words: string) => {
  const run: string[] = [];
  for (const word of words.trim().toLowerCase().split(" ").toReversed()) {
    if (NOT_MODIFIER.test(word)) {
      break;
    }
    run.unshift(word);
  }
  return run.join(" ");
};

// The filing's own whole-sentence statement of zero borrowings at the instant, covering every facility it names.
export function zeroBorrowingsTextProof(
  html: string,
  periodEnd: string,
): Readonly<Record<string, string>> {
  const sentences = normalizeFilingText(html)
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/[“”]/gu, '"')
    .split(/(?<=[.!?])\s+/u);
  const labels = new Set(dateLabels(periodEnd));
  const covers: { kind?: string; modifiers?: string }[] = [];
  const accepted = sentences.filter((sentence) => {
    const facility = FACILITY_ZERO.exec(sentence);
    const match = facility ?? BARE_ZERO.exec(sentence);
    if (
      match === null ||
      ![match[1], match[2]].some((date) => date !== undefined && labels.has(date))
    ) {
      return false;
    }
    const term = facility?.[4];
    covers.push(
      term === undefined
        ? {}
        : {
            kind: kindOf(term) ?? term,
            ...(PLURAL.test(term) ? {} : { modifiers: modifierKey(facility![3]!) }),
          },
    );
    return true;
  });
  if (PARENT_ONLY.test(sentences.join(" "))) {
    return { [ZERO_BORROWINGS_REJECT_KEY]: "parent-only" };
  }
  if (accepted.length === 0) {
    return { [ZERO_BORROWINGS_REJECT_KEY]: "no-sentence" };
  }
  const named = new Map<string, { modifiers: Set<string>; several: boolean }>();
  for (const sentence of sentences) {
    if (DISPOSAL.test(sentence) && !CONTINUING.test(sentence)) {
      continue;
    }
    const counts = new Map<string, number>();
    for (const [, words, term] of sentence.matchAll(MENTION)) {
      const kind = kindOf(term!) ?? term!;
      const entry = named.get(kind) ?? { modifiers: new Set<string>(), several: false };
      named.set(kind, entry);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      entry.several ||= PLURAL.test(term!) || counts.get(kind)! > 1;
      entry.modifiers.add(modifierKey(words!));
    }
  }
  const uncovered = [...named].filter(([kind, { modifiers, several }]) => {
    const whole = covers.some(
      (cover) => cover.kind === undefined || (cover.kind === kind && cover.modifiers === undefined),
    );
    const facilities = [...modifiers].filter((modifier) => modifier !== "");
    if (whole) {
      return false;
    }
    if (several) {
      return true;
    }
    // A bare mention ("this line of credit") refers back to the one named facility of its kind.
    const needed = facilities.length === 0 ? [""] : facilities;
    return !needed.every((modifier) =>
      covers.some(
        (cover) =>
          cover.kind === kind &&
          (cover.modifiers === modifier || (facilities.length <= 1 && cover.modifiers === "")),
      ),
    );
  });
  return uncovered.length > 0
    ? {
        [ZERO_BORROWINGS_REJECT_KEY]: `uncovered-facility:${uncovered.map(([kind]) => kind).join("/")}`,
      }
    : { [ZERO_BORROWINGS_TEXT_KEY]: accepted.join(" ") };
}
