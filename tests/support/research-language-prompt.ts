import { READER_DIRECTED_ADVICE_PATTERN } from "../../src/domain/research-language";

function quoteAlternatives(alternatives: readonly string[], quote: string): string {
  const quoted = alternatives.map((alternative) => `${quote}${alternative}${quote}`);
  const last = quoted.at(-1);
  if (last === undefined) {
    throw new Error("reader-directed advice alternative group is empty");
  }
  return `${quoted.slice(0, -1).join(", ")}, or ${last}`;
}

export function readerDirectedAdviceClauses(quote: string): {
  readonly subject: string;
  readonly imperative: string;
} {
  const groups = [...READER_DIRECTED_ADVICE_PATTERN.source.matchAll(/\(\?:([^)]*)\)/gu)].map(
    ([, alternatives]) => alternatives,
  );
  const [subjects, subjectVerbs, imperativeVerbs, tradeVerbs] = groups;
  if (
    groups.length !== 4 ||
    subjects === undefined ||
    subjectVerbs === undefined ||
    imperativeVerbs === undefined ||
    tradeVerbs === undefined
  ) {
    throw new Error("reader-directed advice regex groups changed");
  }
  return {
    subject: `do not put ${quoteAlternatives(subjectVerbs.split("|"), quote)} after ${quoteAlternatives(subjects.split("|"), quote)}`,
    imperative: `do not put ${quoteAlternatives(tradeVerbs.split("|"), quote)} after ${quoteAlternatives(imperativeVerbs.split("|"), quote)}`,
  };
}
