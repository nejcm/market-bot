import type { Source } from "../domain/sources";
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

function joinedSearchText(...values: readonly (string | undefined)[]): string {
  return values
    .filter((value): value is string => value !== undefined && value.trim() !== "")
    .join(" ");
}

function symbolTokens(text: string): ReadonlySet<string> {
  const tokens = text.match(/\$?[A-Za-z][A-Za-z0-9.-]*/gu) ?? [];
  return new Set(
    tokens.flatMap((token) => {
      if (token.startsWith("$")) {
        return [token.slice(1).toUpperCase()];
      }
      return token === token.toUpperCase() ? [token] : [];
    }),
  );
}

function lowercaseTokens(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(/[a-z][a-z0-9.-]*/gu));
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

function matchesTargets(args: {
  readonly sourceSymbol: string | undefined;
  readonly targets: readonly NewsRelevanceTarget[];
  readonly tickerText: string;
  readonly companyText: string;
}): boolean {
  if (args.targets.length === 0) {
    return false;
  }
  const tickerTokens = symbolTokens(args.tickerText);
  const lowerTokens = lowercaseTokens(args.companyText);
  return args.targets.some((target) => {
    const symbol = target.symbol.toUpperCase();
    if (args.sourceSymbol === symbol) {
      return true;
    }
    if (tickerTokens.has(symbol)) {
      return true;
    }
    if (
      target.allowLowercaseSymbolMention === true &&
      lowerTokens.has(target.symbol.toLowerCase())
    ) {
      return true;
    }
    return companyNameTerms(target.name).some((term) => lowerTokens.has(term));
  });
}

export function isNewsRelevant(source: Source, targets: readonly NewsRelevanceTarget[]): boolean {
  return matchesTargets({
    sourceSymbol: source.symbol?.toUpperCase(),
    targets,
    tickerText: joinedSearchText(source.title, source.summary, source.snippet),
    companyText: joinedSearchText(source.symbol, source.title, source.summary, source.snippet),
  });
}

// The floor-counting variant: summary/snippet-only subject matches do not count toward it.
export function isNewsRelevantByTitleOrSymbol(
  source: Source,
  targets: readonly NewsRelevanceTarget[],
): boolean {
  return matchesTargets({
    sourceSymbol: source.symbol?.toUpperCase(),
    targets,
    tickerText: joinedSearchText(source.title),
    companyText: joinedSearchText(source.symbol, source.title),
  });
}
