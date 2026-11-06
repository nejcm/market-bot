export const LISTED_SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/u;
// A digit-leading code needs a letter exchange suffix (0097.KL, 7203.T) so bare years never validate.
export const RESEARCH_SUBJECT_SYMBOL_RE =
  /^(?=.{1,10}$)(?:[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*|[0-9][A-Z0-9]*\.[A-Z]+)$/u;
