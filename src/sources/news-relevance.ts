import type { Source } from "../domain/types";
import type { NewsRelevanceTarget } from "./types";

const COMPANY_SUFFIX_TERMS = new Set([
  "class",
  "company",
  "corp",
  "corporation",
  "group",
  "holding",
  "holdings",
  "inc",
  "incorporated",
  "limited",
  "ltd",
  "plc",
]);

// Generic market words that appear in subject aliases (e.g. the "stocks" in "chip stocks")
// But carry no thematic signal for any subject. Excluded from name-relevance terms so that
// Broad market headlines ("Stocks rally...") do not match a specific research subject's news
// Targets. Only universally-generic words belong here: subject-defining words such as "small"
// Or "caps" (the theme of the small-caps subject) must stay matchable.
const GENERIC_TOPIC_TERMS = new Set([
  "equities",
  "equity",
  "market",
  "markets",
  "sector",
  "sectors",
  "share",
  "shares",
  "stock",
  "stocks",
]);

function normalizedSearchText(source: Source): string {
  return [source.symbol, source.title, source.summary, source.snippet]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .join(" ")
    .toLowerCase();
}

function sourceSearchText(source: Source): string {
  return [source.title, source.summary, source.snippet]
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .join(" ");
}

function symbolTokens(source: Source): ReadonlySet<string> {
  const tokens = sourceSearchText(source).match(/\$?[A-Za-z][A-Za-z0-9.-]*/gu) ?? [];
  return new Set(
    tokens.flatMap((token) => {
      if (token.startsWith("$")) {
        return [token.slice(1).toUpperCase()];
      }
      return token === token.toUpperCase() ? [token] : [];
    }),
  );
}

function caseInsensitiveSymbolTokens(source: Source): ReadonlySet<string> {
  const tokens = normalizedSearchText(source).match(/[a-z][a-z0-9.-]*/gu) ?? [];
  return new Set(tokens);
}

function companySearchTokens(source: Source): ReadonlySet<string> {
  const tokens = normalizedSearchText(source).match(/[a-z][a-z0-9.-]*/gu) ?? [];
  return new Set(tokens);
}

function companyNameTerms(name: string | undefined): readonly string[] {
  if (name === undefined) {
    return [];
  }
  const tokens = name.toLowerCase().match(/[a-z][a-z0-9.-]*/gu) ?? [];
  return [
    ...new Set(
      tokens.filter(
        (token) =>
          token.length >= 4 && !COMPANY_SUFFIX_TERMS.has(token) && !GENERIC_TOPIC_TERMS.has(token),
      ),
    ),
  ];
}

export function isNewsRelevant(source: Source, targets: readonly NewsRelevanceTarget[]): boolean {
  if (targets.length === 0) {
    return false;
  }
  const sourceSymbol = source.symbol?.toUpperCase();
  const tickerTokens = symbolTokens(source);
  const lowercaseSymbolTokens = caseInsensitiveSymbolTokens(source);
  const companyTokens = companySearchTokens(source);
  return targets.some((target) => {
    const symbol = target.symbol.toUpperCase();
    const lowercaseSymbol = target.symbol.toLowerCase();
    if (sourceSymbol === symbol) {
      return true;
    }
    if (tickerTokens.has(symbol)) {
      return true;
    }
    if (target.allowLowercaseSymbolMention === true && lowercaseSymbolTokens.has(lowercaseSymbol)) {
      return true;
    }
    return companyNameTerms(target.name).some((term) => companyTokens.has(term));
  });
}
