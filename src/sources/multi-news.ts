import type { Source, SourceGap, SourceProviderAlias } from "../domain/types";
import { isRepeatFallbackGap, sourceGap } from "../domain/source-gaps";
import { filterSeenNewsSources, newsSeenLane } from "./news-seen";
import { canonicalizeUrl, normalizeTitle } from "./news-utils";
import {
  type CollectContext,
  type NewsAdapter,
  type NewsCollectionAnalytics,
  type NewsCollectionResult,
  type NewsRelevanceTarget,
} from "./types";
import { yahooNewsAdapter } from "./yahoo-news";

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

function aliasFor(source: Source): SourceProviderAlias | undefined {
  if (source.provider === undefined) {
    return undefined;
  }

  return {
    provider: source.provider,
    ...(source.providerArticleId !== undefined
      ? { providerArticleId: source.providerArticleId }
      : {}),
    ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
    fetchedAt: source.fetchedAt,
    ...(source.rawRef !== undefined ? { rawRef: source.rawRef } : {}),
  };
}

function mergeAliases(
  existing: readonly SourceProviderAlias[] | undefined,
  next: SourceProviderAlias | undefined,
): readonly SourceProviderAlias[] | undefined {
  if (next === undefined) {
    return existing;
  }

  const aliases = existing ?? [];
  const alreadyPresent = aliases.some(
    (alias) =>
      alias.provider === next.provider &&
      alias.providerArticleId === next.providerArticleId &&
      alias.rawRef === next.rawRef,
  );

  return alreadyPresent ? aliases : [...aliases, next];
}

function withCanonical(source: Source): Source {
  const canonicalUrl = source.canonicalUrl ?? canonicalizeUrl(source.url);
  return canonicalUrl !== undefined ? { ...source, canonicalUrl } : source;
}

function withAlias(source: Source): Source {
  const providerAliases = mergeAliases(source.providerAliases, aliasFor(source));
  return providerAliases !== undefined ? { ...source, providerAliases } : source;
}

function mergeSource(existing: Source, source: Source): Source {
  const canonicalUrl = existing.canonicalUrl ?? source.canonicalUrl;
  const summary = existing.summary ?? source.summary;
  const snippet = existing.snippet ?? source.snippet;
  const providerAliases = mergeAliases(existing.providerAliases, aliasFor(source));

  return {
    ...existing,
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(providerAliases !== undefined ? { providerAliases } : {}),
  };
}

function registerMergeKeys(
  source: Source,
  index: number,
  indexByCanonical: Map<string, number>,
  indexByTitle: Map<string, number>,
): void {
  if (source.canonicalUrl !== undefined) {
    indexByCanonical.set(source.canonicalUrl, index);
  }
  const normalizedTitle = normalizeTitle(source.title);
  if (normalizedTitle !== undefined) {
    indexByTitle.set(normalizedTitle, index);
  }
}

function dedupeByCanonicalUrlOrTitle(sources: readonly Source[]): readonly Source[] {
  const merged: Source[] = [];
  const indexByCanonical = new Map<string, number>();
  const indexByTitle = new Map<string, number>();

  for (const source of sources.map((item) => withCanonical(item))) {
    const titleKey = normalizeTitle(source.title);
    const existingIndex =
      source.canonicalUrl === undefined ? undefined : indexByCanonical.get(source.canonicalUrl);
    const mergeIndex =
      existingIndex ?? (titleKey === undefined ? undefined : indexByTitle.get(titleKey));

    if (mergeIndex === undefined) {
      registerMergeKeys(source, merged.length, indexByCanonical, indexByTitle);
      merged.push(withAlias(source));
      continue;
    }

    const { [mergeIndex]: existing } = merged;
    if (existing === undefined) {
      continue;
    }

    registerMergeKeys(source, mergeIndex, indexByCanonical, indexByTitle);
    merged[mergeIndex] = mergeSource(existing, source);
  }

  return merged;
}

function fetchedAtMs(source: Source): number {
  const parsed = Date.parse(source.fetchedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relevanceTargets(ctx: CollectContext): readonly NewsRelevanceTarget[] {
  if (ctx.command.jobType !== "ticker") {
    return ctx.newsRelevanceTargets ?? [];
  }
  const [target] = ctx.newsRelevanceTargets ?? [];
  return [
    {
      symbol: ctx.command.symbol,
      ...(target?.name !== undefined ? { name: target.name } : {}),
      allowLowercaseSymbolMention: true,
    },
  ];
}

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

function isNewsRelevant(source: Source, targets: readonly NewsRelevanceTarget[]): boolean {
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

function selectedRelevanceAnalytics(
  command: CollectContext["command"],
  sources: readonly Source[],
  targets: readonly NewsRelevanceTarget[],
): Pick<
  NewsCollectionAnalytics,
  | "selectedRelevantTickerNewsSourceCount"
  | "selectedGenericTickerNewsSourceCount"
  | "selectedRelevantMoverNewsSourceCount"
  | "selectedGenericMoverNewsSourceCount"
> {
  if (targets.length === 0) {
    return {};
  }
  const selectedRelevantCount = sources.filter((source) => isNewsRelevant(source, targets)).length;
  const selectedGenericCount = sources.length - selectedRelevantCount;
  return command.jobType === "ticker"
    ? {
        selectedRelevantTickerNewsSourceCount: selectedRelevantCount,
        selectedGenericTickerNewsSourceCount: selectedGenericCount,
      }
    : {
        selectedRelevantMoverNewsSourceCount: selectedRelevantCount,
        selectedGenericMoverNewsSourceCount: selectedGenericCount,
      };
}

function relevantNewsCount(
  sources: readonly Source[],
  targets: readonly NewsRelevanceTarget[],
): number {
  return sources.filter((source) => isNewsRelevant(source, targets)).length;
}

// Min-relevant-keep guarantee for ticker lanes. When the persistent seen-filter
// Strips every relevant source but leaves generic survivors, re-add the most
// Recent relevant deduped source(s) dropped as seen so the issuer signal is not
// Lost to repeat-dedupe. Emits one repeat-fallback gap. Market-overview and
// Mover lanes are unchanged.
const MIN_RELEVANT_KEEP_TICKER = 1;

function canonicalUrlOf(source: Source): string | undefined {
  return source.canonicalUrl ?? canonicalizeUrl(source.url);
}

interface RelevantRepeatKeep {
  readonly pool: readonly Source[];
  readonly keptRelevantRepeat: readonly Source[];
  readonly gap: SourceGap | undefined;
}

function keepRelevantSeenSources(args: {
  readonly command: CollectContext["command"];
  readonly dedupedSources: readonly Source[];
  readonly survivors: readonly Source[];
  readonly targets: readonly NewsRelevanceTarget[];
}): RelevantRepeatKeep {
  const { command, dedupedSources, survivors, targets } = args;
  if (command.jobType !== "ticker" || targets.length === 0) {
    return { pool: survivors, keptRelevantRepeat: [], gap: undefined };
  }
  const relevantSurvivorCount = survivors.filter((source) =>
    isNewsRelevant(source, targets),
  ).length;
  const deficit = Math.max(0, MIN_RELEVANT_KEEP_TICKER - relevantSurvivorCount);
  if (deficit === 0) {
    return { pool: survivors, keptRelevantRepeat: [], gap: undefined };
  }
  const survivorCanonicals = new Set(
    survivors
      .map((source) => canonicalUrlOf(source))
      .filter((value): value is string => value !== undefined),
  );
  const relevantDropped = dedupedSources
    .filter((source) => {
      const canonical = canonicalUrlOf(source);
      return (
        canonical !== undefined &&
        !survivorCanonicals.has(canonical) &&
        isNewsRelevant(source, targets)
      );
    })
    .toSorted((left, right) => fetchedAtMs(right) - fetchedAtMs(left));
  const kept = relevantDropped.slice(0, deficit);
  if (kept.length === 0) {
    return { pool: survivors, keptRelevantRepeat: [], gap: undefined };
  }
  const lane = newsSeenLane(command);
  const gap = sourceGap({
    source: "news-seen",
    message: `Persistent news dedupe suppressed ${String(relevantDropped.length)} relevant repeat source(s) for ${lane}; kept ${String(kept.length)} relevant repeat fallback(s)`,
    capability: "news",
    cause: "repeat-fallback",
    evidenceQualityImpact: "no-cap",
  });
  return { pool: [...survivors, ...kept], keptRelevantRepeat: kept, gap };
}

function selectRoundRobin(
  sources: readonly Source[],
  limit: number,
  providerOrder: readonly string[],
): readonly Source[] {
  const groups = new Map<string, Source[]>();

  for (const source of sources) {
    const provider = source.provider ?? "unknown";
    groups.set(provider, [...(groups.get(provider) ?? []), source]);
  }

  for (const [provider, group] of groups) {
    groups.set(
      provider,
      group.toSorted((left, right) => fetchedAtMs(right) - fetchedAtMs(left)),
    );
  }

  const selected: Source[] = [];
  const cursors = new Map<string, number>();
  const order = [
    ...providerOrder,
    ...[...groups.keys()].filter((key) => !providerOrder.includes(key)),
  ];

  while (selected.length < limit) {
    let added = false;

    for (const provider of order) {
      const group = groups.get(provider) ?? [];
      const cursor = cursors.get(provider) ?? 0;
      const source = group[cursor];
      if (source === undefined) {
        continue;
      }

      selected.push(source);
      cursors.set(provider, cursor + 1);
      added = true;

      if (selected.length >= limit) {
        break;
      }
    }

    if (!added) {
      break;
    }
  }

  return selected;
}

function selectRelevantFirst(
  sources: readonly Source[],
  limit: number,
  providerOrder: readonly string[],
  targets: readonly NewsRelevanceTarget[],
): readonly Source[] {
  if (targets.length === 0) {
    return selectRoundRobin(sources, limit, providerOrder);
  }
  const relevant = sources.filter((source) => isNewsRelevant(source, targets));
  const generic = sources.filter((source) => !isNewsRelevant(source, targets));
  const selectedRelevant = selectRoundRobin(relevant, limit, providerOrder);
  if (selectedRelevant.length >= limit) {
    return selectedRelevant;
  }
  return [
    ...selectedRelevant,
    ...selectRoundRobin(generic, limit - selectedRelevant.length, providerOrder),
  ];
}

function assignSourceIds(sources: readonly Source[]): readonly Source[] {
  return sources.map((source, index) => ({
    ...source,
    id: `news-${source.assetClass ?? "market"}-${index + 1}`,
  }));
}

function countNewsByProvider(
  results: readonly NewsCollectionResult[],
  adapters: readonly NewsAdapter[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};

  results.forEach((result, index) => {
    const provider = adapters[index]?.provider ?? "unknown";
    counts[provider] = (counts[provider] ?? 0) + result.newsSources.length;
  });

  return counts;
}

export function createMultiNewsAdapter(
  adapters: readonly NewsAdapter[],
  providerOrder: readonly string[] = adapters.map((adapter) => adapter.provider),
): NewsAdapter {
  async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
    const results = await Promise.all(adapters.map((adapter) => adapter.collect(ctx)));
    const fetchedNewsSourceCount = results.reduce(
      (total, result) => total + result.newsSources.length,
      0,
    );
    const dedupedSources = dedupeByCanonicalUrlOrTitle(
      results.flatMap((result) => result.newsSources),
    );
    const targets = relevanceTargets(ctx);
    const relevantBeforeSeenFilterCount = relevantNewsCount(dedupedSources, targets);
    const filtered =
      ctx.newsSeenPath !== undefined && ctx.newsSeenRetentionDays !== undefined
        ? await filterSeenNewsSources(dedupedSources, {
            path: ctx.newsSeenPath,
            retentionDays: ctx.newsSeenRetentionDays,
            command: ctx.command,
            now: new Date(ctx.fetchedAt),
          })
        : { newsSources: dedupedSources, sourceGaps: [] };
    const relevantAfterSeenFilterCount = relevantNewsCount(filtered.newsSources, targets);
    const relevantKeep = keepRelevantSeenSources({
      command: ctx.command,
      dedupedSources,
      survivors: filtered.newsSources,
      targets,
    });
    const repeatFallbackGaps = relevantKeep.gap === undefined ? [] : [relevantKeep.gap];
    const newsSources = assignSourceIds(
      selectRelevantFirst(relevantKeep.pool, ctx.newsLimit, providerOrder, targets),
    );
    const relevantSelectedCount = relevantNewsCount(newsSources, targets);
    const repeatFallbackUsed = filtered.sourceGaps.some((gap) => isRepeatFallbackGap(gap));
    const persistentSuppressedNewsSourceCount = dedupedSources.length - filtered.newsSources.length;

    return {
      rawSnapshots: results.flatMap((result) => result.rawSnapshots),
      newsSources,
      sourceGaps: [
        ...results.flatMap((result) => result.sourceGaps),
        ...filtered.sourceGaps,
        ...repeatFallbackGaps,
      ],
      newsAnalytics: {
        fetchedNewsSourcesByProvider: countNewsByProvider(results, adapters),
        fetchedNewsSourceCount,
        canonicalDedupedNewsSourceCount: dedupedSources.length,
        canonicalDuplicateNewsSourceCount: fetchedNewsSourceCount - dedupedSources.length,
        persistentSuppressedNewsSourceCount,
        relevantBeforeSeenFilterCount,
        relevantSuppressedBySeenFilterCount: Math.max(
          0,
          relevantBeforeSeenFilterCount - relevantAfterSeenFilterCount,
        ),
        relevantSelectedCount,
        repeatFallbackKeptCount: repeatFallbackUsed ? filtered.newsSources.length : 0,
        relevantRepeatKeptCount: relevantKeep.keptRelevantRepeat.length,
        selectedNewsSourceCount: newsSources.length,
        ...selectedRelevanceAnalytics(ctx.command, newsSources, targets),
        repeatFallbackUsed,
      },
    };
  }

  return {
    name: "multi-news",
    provider: "multi-news",
    normalizeNews: yahooNewsAdapter.normalizeNews,
    collect: collectNews,
  };
}
