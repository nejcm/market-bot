import type { Source, SourceProviderAlias } from "../domain/types";
import { finnhubNewsAdapter } from "./finnhub-news";
import { marketAuxNewsAdapter } from "./marketaux-news";
import { filterSeenNewsSources } from "./news-seen";
import { canonicalizeUrl } from "./news-utils";
import { type CollectContext, type NewsAdapter, type NewsCollectionResult } from "./types";
import { yahooNewsAdapter } from "./yahoo-news";

const DEFAULT_NEWS_ADAPTERS: readonly NewsAdapter[] = [
  marketAuxNewsAdapter,
  finnhubNewsAdapter,
  yahooNewsAdapter,
];
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

function dedupeByCanonicalUrl(sources: readonly Source[]): readonly Source[] {
  const merged: Source[] = [];
  const indexByCanonical = new Map<string, number>();

  for (const source of sources.map((item) => withCanonical(item))) {
    const { canonicalUrl } = source;
    if (canonicalUrl === undefined) {
      merged.push(withAlias(source));
      continue;
    }

    const existingIndex = indexByCanonical.get(canonicalUrl);
    if (existingIndex === undefined) {
      indexByCanonical.set(canonicalUrl, merged.length);
      merged.push(withAlias(source));
      continue;
    }

    const { [existingIndex]: existing } = merged;
    if (existing === undefined) {
      continue;
    }

    const summary = existing.summary ?? source.summary;
    const snippet = existing.snippet ?? source.snippet;
    const providerAliases = mergeAliases(existing.providerAliases, aliasFor(source));

    merged[existingIndex] = {
      ...existing,
      ...(summary !== undefined ? { summary } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(providerAliases !== undefined ? { providerAliases } : {}),
    };
  }

  return merged;
}

function fetchedAtMs(source: Source): number {
  const parsed = Date.parse(source.fetchedAt);
  return Number.isFinite(parsed) ? parsed : 0;
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
    const dedupedSources = dedupeByCanonicalUrl(results.flatMap((result) => result.newsSources));
    const filtered =
      ctx.newsSeenPath !== undefined && ctx.newsSeenRetentionDays !== undefined
        ? await filterSeenNewsSources(dedupedSources, {
            path: ctx.newsSeenPath,
            retentionDays: ctx.newsSeenRetentionDays,
            command: ctx.command,
            now: new Date(ctx.fetchedAt),
          })
        : { newsSources: dedupedSources, sourceGaps: [] };
    const newsSources = assignSourceIds(
      selectRoundRobin(filtered.newsSources, ctx.newsLimit, providerOrder),
    );
    const repeatFallbackUsed = filtered.sourceGaps.some((gap) =>
      gap.message.includes("kept one repeat fallback"),
    );
    const persistentSuppressedNewsSourceCount = dedupedSources.length - filtered.newsSources.length;

    return {
      rawSnapshots: results.flatMap((result) => result.rawSnapshots),
      newsSources,
      sourceGaps: [...results.flatMap((result) => result.sourceGaps), ...filtered.sourceGaps],
      newsAnalytics: {
        fetchedNewsSourcesByProvider: countNewsByProvider(results, adapters),
        fetchedNewsSourceCount,
        canonicalDedupedNewsSourceCount: dedupedSources.length,
        canonicalDuplicateNewsSourceCount: fetchedNewsSourceCount - dedupedSources.length,
        persistentSuppressedNewsSourceCount,
        repeatFallbackKeptCount: repeatFallbackUsed ? filtered.newsSources.length : 0,
        selectedNewsSourceCount: newsSources.length,
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

export const multiNewsAdapter: NewsAdapter = createMultiNewsAdapter(DEFAULT_NEWS_ADAPTERS);
