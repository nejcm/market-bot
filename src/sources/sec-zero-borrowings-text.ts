import type { ExtendedEvidenceItem } from "../domain/evidence";
import { isDebtPresenceConcept } from "./extended-evidence/financial-statement-definitions";
import { attribute, factValue } from "./sec-ixbrl-fact";
import { normalizeFilingText } from "./sec-filing-text";

export const ZERO_BORROWINGS_TEXT_KEY = "zeroBorrowingText";
export const ZERO_BORROWINGS_FACT_KEY = "zeroBorrowingFact";
export const ZERO_BORROWINGS_REJECT_KEY = "zeroBorrowingReject";
export const UNTAGGED_ZERO = "untagged-zero";

const ZERO_BORROWING_CONCEPTS = new Set([
  "LineOfCredit",
  "CommercialPaper",
  "ShortTermBorrowings",
  "DebtCurrent",
  "DebtInstrumentCarryingAmount",
  "LongTermLineOfCredit",
  "LineOfCreditFacilityAmountOutstanding",
  "LongTermDebt",
  "LongTermDebtNoncurrent",
  "LongTermDebtCurrent",
  "NotesPayable",
]);
const BORROWING_LIKE = new Set([
  ...ZERO_BORROWING_CONCEPTS,
  "LoansPayable",
  "ConvertibleDebt",
  "SeniorNotes",
  "SecuredDebt",
  "UnsecuredDebt",
  "OtherBorrowings",
  "BridgeLoan",
]);
// Any namespace: a balance whose name ends in a borrowing noun; "DebtSecurities…" and capacities do not.
const BORROWING_NAME =
  /(?:Debt|Borrowings?|LinesOfCredit|LineOfCredit|NotesPayable|LoansPayable|CommercialPaper|TermLoans?)(?:Current|Noncurrent|Gross|Net)?$/u;
// Issuer extensions cannot be classified, so any monetary one naming a borrowing word blocks the proof.
const EXTENSION_BORROWING =
  /Debt|Borrow|Loan|Notes|LineOfCredit|LinesOfCredit|CreditFacilit|Revolv|CommercialPaper|Lease|Financing|Overdraft|Mortgage|Bond|Debenture|Factoring/u;
const EXTENSION_NOT_BORROWING = /Securities|Receivable|OperatingLease|Ratio|Rate|Percent/u;
// Axes that name a facility; any other axis (disposal group, legal entity, segment) narrows the zero's scope.
const FACILITY_AXES = new Set([
  "us-gaap:CreditFacilityAxis",
  "us-gaap:DebtInstrumentAxis",
  "us-gaap:LineOfCreditFacilityAxis",
  "us-gaap:ShortTermDebtTypeAxis",
  "us-gaap:LongtermDebtTypeAxis",
]);

const KINDS = [
  ["line of credit", /^lines? of credit$/iu],
  ["credit facility", /^credit facilit(?:y|ies)$/iu],
  ["term loan", /^term loans?$/iu],
  ["notes", /^(?:notes payable|senior notes|convertible notes)$/iu],
  ["promissory note", /^promissory notes?$/iu],
  ["loan agreement", /^loan agreements?$/iu],
  ["factoring", /^factoring (?:arrangements?|facilit(?:y|ies))$/iu],
  ["commercial paper", /^commercial paper$/iu],
  ["overdraft", /^(?:bank )?overdrafts?$/iu],
  ["mortgage", /^mortgages?(?: notes?| loans?)?$/iu],
  ["advances", /^(?:FHLB|Federal Home Loan Bank) advances?$/iu],
] as const;
// A named facility counts as covered when a tagged zero's concept or dimension member names its kind.
const KIND_TAGS: Readonly<Record<(typeof KINDS)[number][0], RegExp>> = {
  "line of credit": /LinesOfCredit|LineOfCredit|RevolvingCredit|CreditFacility|Revolver/u,
  "credit facility": /LinesOfCredit|LineOfCredit|RevolvingCredit|CreditFacility|Revolver/u,
  "term loan": /TermLoan/u,
  notes: /Notes/u,
  "promissory note": /PromissoryNote/u,
  "loan agreement": /Loan\w*Agreement/u,
  factoring: /Factoring/u,
  "commercial paper": /CommercialPaper/u,
  overdraft: /Overdraft/u,
  mortgage: /Mortgage/u,
  advances: /Advance/u,
};
const MENTION =
  /\b(lines? of credit|credit facilit(?:y|ies)|term loans?|notes payable|senior notes|convertible notes|promissory notes?|loan agreements?|factoring (?:arrangements?|facilit(?:y|ies))|commercial paper|(?:bank )?overdrafts?|mortgages?(?: notes?| loans?)?(?!-)|(?:FHLB|Federal Home Loan Bank) advances?)\b/giu;
// Disposal-group borrowings are withheld by the held-for-sale checks, so only continuing facilities need cover.
const DISPOSAL = /discontinued operations|held for sale/iu;
const CONTINUING =
  /unrelated to|continuing|\b(?:not|no longer)\b[^.]*?(?:held for sale|discontinued)/iu;
const PARENT_ONLY = /parent company only|excluding its consolidated subsidiaries|registrant only/iu;
// A supplementary private-use code point (rare in filing text) marks the position through normalizing.
const MARK = String.fromCodePoint(0xf_00_00);

function filingSentences(html: string): readonly string[] {
  return normalizeFilingText(html)
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/[“”]/gu, '"')
    .split(/(?<=[.!?])\s+/u);
}

// Closed-class words name no particular facility; any other word before a facility noun must name the tagged zero.
const NEUTRAL = new Set(
  "a an the this that these those its our their such each any no and or of to for under against with on in by from at as into has had have is are was were be been company".split(
    " ",
  ),
);

interface FacilityMention {
  readonly kind: (typeof KINDS)[number][0];
  readonly phrase: string;
  readonly qualifiers: readonly string[];
}

// Continuing-operations facilities the filing's prose names, each with the words just before it.
function facilityCensus(sentences: readonly string[]): readonly FacilityMention[] {
  return sentences
    .filter((sentence) => !DISPOSAL.test(sentence) || CONTINUING.test(sentence))
    .flatMap((sentence) =>
      [...sentence.matchAll(MENTION)].flatMap(({ 0: term, index }) => {
        const kind = KINDS.find(([, pattern]) => pattern.test(term))?.[0];
        const before = /(\S+)\s*$/u.exec(sentence.slice(0, index))?.[1] ?? "";
        const qualifiers = before
          .toLowerCase()
          .replace(/'s$/u, "")
          .split(/[^a-z]+/u)
          .filter((word) => word !== "" && !NEUTRAL.has(word));
        return kind === undefined
          ? []
          : [{ kind, phrase: [...qualifiers, term.toLowerCase()].join(" "), qualifiers }];
      }),
    );
}

interface InstantFact {
  readonly id: string | undefined;
  readonly concept: string;
  readonly value: number | undefined;
  readonly members: readonly (readonly [axis: string, member: string])[];
  readonly index: number;
  readonly end: number;
}

const ELEMENT_PREFIX = String.raw`(?:[\w.-]+:)?`;
const CONTEXT = new RegExp(
  String.raw`<(${ELEMENT_PREFIX}context)\b([^>]*)>([\s\S]*?)<\/\1\s*>`,
  "gu",
);
const INSTANT = new RegExp(String.raw`<${ELEMENT_PREFIX}instant\b[^>]*>\s*([^<\s]+)\s*<`, "u");
const MEMBER = new RegExp(
  String.raw`<${ELEMENT_PREFIX}(?:explicit|typed)Member\b([^>]*)>([\s\S]*?)<\/${ELEMENT_PREFIX}(?:explicit|typed)Member\s*>`,
  "gu",
);
const FACT = /<ix:nonFraction\b([^>]*?)(?:\/>|>([\s\S]*?)<\/ix:nonFraction\s*>)/gu;

// Facts at the instant, plus the names of facts whose context did not resolve (undefined when unnamed).
function instantFacts(
  html: string,
  periodEnd: string,
): {
  readonly facts: readonly InstantFact[];
  readonly unresolved: readonly (string | undefined)[];
} {
  const contexts = new Map<string, InstantFact["members"] | undefined>();
  for (const { 2: attrs, 3: body } of html.matchAll(CONTEXT)) {
    const id = attribute(attrs!, "id");
    if (id !== undefined) {
      contexts.set(
        id,
        INSTANT.exec(body!)?.[1] === periodEnd
          ? [...body!.matchAll(MEMBER)].map(
              ([, memberAttrs, member]) =>
                [
                  attribute(memberAttrs!, "dimension") ?? "",
                  member!.replaceAll(/<[^>]*>/gu, "").trim(),
                ] as const,
            )
          : undefined,
      );
    }
  }
  const facts: InstantFact[] = [];
  const unresolved: (string | undefined)[] = [];
  for (const match of html.matchAll(FACT)) {
    const attrs = match[1]!;
    const concept = attribute(attrs, "name");
    const contextRef = attribute(attrs, "contextRef") ?? "";
    if (concept === undefined || !contexts.has(contextRef)) {
      unresolved.push(concept);
      continue;
    }
    const members = contexts.get(contextRef);
    if (members !== undefined) {
      facts.push({
        id: attribute(attrs, "id"),
        concept,
        value: factValue(attrs, match[2] ?? ""),
        members,
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return { facts, unresolved };
}

const localName = (concept: string) => concept.slice(concept.indexOf(":") + 1);
const isUsGaap = (concept: string) => concept.startsWith("us-gaap:");
const isBorrowing = (concept: string) =>
  (isUsGaap(concept) &&
    (BORROWING_LIKE.has(localName(concept)) ||
      isDebtPresenceConcept("us-gaap", localName(concept)))) ||
  BORROWING_NAME.test(localName(concept));
const isExtensionBorrowing = (concept: string) =>
  !isUsGaap(concept) &&
  EXTENSION_BORROWING.test(localName(concept)) &&
  !EXTENSION_NOT_BORROWING.test(localName(concept));
const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
const words = (text: string) =>
  (localName(text).match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/gu) ?? []).map((word) => word.toLowerCase());
const ZERO_DISPLAY = /^(?:\$\s*)?(?:no|none|nil|zero|0|[-—–])$/iu;
const BLOCK = /<\/?(?:p|div|td|th|tr|table|li|h[1-6]|br|body)\b[^>]*>/giu;
const inTable = (html: string, at: number) =>
  html.lastIndexOf("<table", at) > html.lastIndexOf("</table", at);

// A visible fact shows in place; an ix:hidden one at a style-linked element whose text reads as zero.
function displayAt(html: string, fact: InstantFact): readonly [number, number] | undefined {
  const hidden =
    html.lastIndexOf("<ix:hidden", fact.index) > html.lastIndexOf("</ix:hidden>", fact.index);
  if (!hidden) {
    return inTable(html, fact.index) ? undefined : [fact.index, fact.end];
  }
  if (fact.id === undefined) {
    return undefined;
  }
  const link = new RegExp(
    String.raw`<[a-z][\w:.-]*\s[^>]*\bstyle\s*=\s*(["'])[^"']*-sec-ix-hidden:\s*${escape(fact.id)}(?![\w.-])[^>]*>`,
    "giu",
  );
  for (const { 0: tag, index } of html.matchAll(link)) {
    const after = index + tag.length;
    const shown = html
      .slice(after, html.indexOf("</", after))
      .replaceAll(/<[^>]*>/gu, "")
      .trim();
    if (ZERO_DISPLAY.test(shown) && !inTable(html, index)) {
      return [index, after];
    }
  }
  return undefined;
}

// The sentence around a displayed position, read within its own block so neighbouring tables and paragraphs stay out.
function enclosingSentence(
  html: string,
  [at, after]: readonly [number, number],
): string | undefined {
  const start = Math.max(
    0,
    ...[...html.slice(0, at).matchAll(BLOCK)].map(({ 0: tag, index }) => index + tag.length),
  );
  const next = html.slice(after).search(BLOCK);
  const block = `${html.slice(start, at)}${MARK}${html.slice(at, next === -1 ? html.length : after + next)}`;
  const sentence = filingSentences(block).find((text) => text.includes(MARK));
  const text = sentence?.replace(MARK, "").replaceAll(/\s+/gu, " ").trim();
  return text !== undefined && text.length >= 20 && text.length <= 600 ? text : undefined;
}

// Zero borrowings rest on the filing's own zero tag, no conflicting borrowing fact, every named facility matched,
// And a prose sentence showing the zero; each failed step is a reject code.
export function zeroBorrowingsTagProof(
  html: string,
  periodEnd: string,
): Readonly<Record<string, string>> {
  const reject = (code: string) => ({ [ZERO_BORROWINGS_REJECT_KEY]: code });
  const { facts, unresolved } = instantFacts(html, periodEnd);
  const unread = unresolved.findIndex(
    (concept) => concept === undefined || isBorrowing(concept) || isExtensionBorrowing(concept),
  );
  if (unread !== -1) {
    return reject(`unresolved-fact:${unresolved[unread] ?? "unnamed"}`);
  }
  const tagged = facts.filter(
    ({ concept, value }) =>
      isUsGaap(concept) && ZERO_BORROWING_CONCEPTS.has(localName(concept)) && value === 0,
  );
  if (tagged.length === 0) {
    return reject(UNTAGGED_ZERO);
  }
  const zeros = tagged.filter(({ members }) => members.every(([axis]) => FACILITY_AXES.has(axis)));
  if (zeros.length === 0) {
    const [axis] = tagged[0]!.members.find(([dimension]) => !FACILITY_AXES.has(dimension))!;
    return reject(`scoped-zero:${axis}`);
  }
  const nonzero = facts.find(({ concept, value }) => isBorrowing(concept) && value !== 0);
  if (nonzero !== undefined) {
    return reject(`nonzero:${nonzero.concept}`);
  }
  const extension = facts.find(
    ({ concept, value }) => isExtensionBorrowing(concept) && value !== 0,
  );
  if (extension !== undefined) {
    return reject(`extension-borrowing:${extension.concept}`);
  }
  const sentences = filingSentences(html);
  if (PARENT_ONLY.test(sentences.join(" "))) {
    return reject("parent-only");
  }
  const identity = zeros.flatMap(({ concept, members }) => [concept, ...members.flat()]).join(" ");
  const identityWords = new Set(identity.split(" ").flatMap((part) => words(part)));
  const uncovered = facilityCensus(sentences).filter(
    ({ kind, qualifiers }) =>
      !KIND_TAGS[kind].test(identity) || qualifiers.some((word) => !identityWords.has(word)),
  );
  if (uncovered.length > 0) {
    return reject(
      `uncovered-facility:${[...new Set(uncovered.map(({ phrase }) => phrase))].join("/")}`,
    );
  }
  const cited = [
    ...new Set(
      zeros.flatMap((fact) => {
        const shown = displayAt(html, fact);
        return (shown && enclosingSentence(html, shown)) ?? [];
      }),
    ),
  ];
  if (cited.length === 0) {
    return reject("zero-not-cited");
  }
  return {
    [ZERO_BORROWINGS_TEXT_KEY]: cited.join(" "),
    [ZERO_BORROWINGS_FACT_KEY]: [
      ...new Set(
        zeros.map(({ concept, members }) =>
          members.length === 0
            ? `${concept} = 0`
            : `${concept} = 0 [${members.map(([axis, member]) => `${axis}=${member}`).join(", ")}]`,
        ),
      ),
    ].join("; "),
  };
}

// MARKET_BOT_TAGGED_ZERO_DEBT_DISABLE: the tagged-zero proof is dropped, so the zero stays withheld.
export function withoutTaggedZero(item: ExtendedEvidenceItem): ExtendedEvidenceItem {
  if (item.metrics?.[ZERO_BORROWINGS_TEXT_KEY] === undefined) {
    return item;
  }
  const {
    [ZERO_BORROWINGS_TEXT_KEY]: _text,
    [ZERO_BORROWINGS_FACT_KEY]: _fact,
    ...metrics
  } = item.metrics;
  return {
    ...item,
    metrics: { ...metrics, [ZERO_BORROWINGS_REJECT_KEY]: "tagged-zero debt disabled" },
  };
}
