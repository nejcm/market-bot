import type { Source, SourceProviderAlias } from "../domain/types";
import { finnhubNewsAdapter } from "./finnhub-news";
import { marketAuxNewsAdapter } from "./marketaux-news";
import { canonicalizeUrl } from "./news-utils";
import { type CollectContext, type NewsAdapter, type NewsCollectionResult } from "./types";
import { yahooNewsAdapter } from "./yahoo-news";

const NEWS_ADAPTERS: readonly NewsAdapter[] = [
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

function selectRoundRobin(sources: readonly Source[], limit: number): readonly Source[] {
  const providerOrder = NEWS_ADAPTERS.map((adapter) => adapter.name.replace(/-news$/u, ""));
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

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  const results = await Promise.all(NEWS_ADAPTERS.map((adapter) => adapter.collect(ctx)));
  const newsSources = assignSourceIds(
    selectRoundRobin(
      dedupeByCanonicalUrl(results.flatMap((result) => result.newsSources)),
      ctx.newsLimit,
    ),
  );

  return {
    rawSnapshots: results.flatMap((result) => result.rawSnapshots),
    newsSources,
    sourceGaps: results.flatMap((result) => result.sourceGaps),
  };
}

export const multiNewsAdapter: NewsAdapter = {
  name: "multi-news",
  buildUrl: yahooNewsAdapter.buildUrl,
  normalizeNews: yahooNewsAdapter.normalizeNews,
  collect: collectNews,
};
