import type { Source, SourceGap, SourceProviderAlias } from "../domain/types";
import { isInstrumentCommand } from "../cli/args";
import { isRepeatFallbackGap, sourceGap } from "../domain/source-gaps";
import { filterSeenNewsSources, newsSeenLane } from "./news-seen";
import { isNewsRelevant } from "./news-relevance";
import { canonicalizeUrl, normalizeTitle } from "./news-utils";
import {
  type CollectContext,
  type NewsAdapter,
  type NewsCollectionAnalytics,
  type NewsCollectionResult,
  type NewsRelevanceTarget,
} from "./types";
import { yahooNewsAdapter } from "./yahoo-news";
import {
  MODEL_INPUT_FIELD_CAPS,
  aggregateModelInputSanitization,
  sanitizeModelInputText,
  type ModelInputFieldRole,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";

const STRUCTURED_ID_RE = /^[\w.:/-]{1,200}$/u;

function validatedNewsUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
      ? canonicalizeUrl(value)
      : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeNewsSource(
  source: Source,
  provider: string,
): { readonly source?: Source; readonly entries: readonly ModelInputSanitizationAggregateEntry[] } {
  if (!STRUCTURED_ID_RE.test(source.id) || !Number.isFinite(Date.parse(source.fetchedAt))) {
    return { entries: [] };
  }
  const values: readonly [ModelInputFieldRole, string | undefined][] = [
    ["title", source.title],
    ["publisher", source.publisher],
    ["summary", source.summary],
    ["snippet", source.snippet],
  ];
  const safe = new Map<ModelInputFieldRole, string>();
  const entries = values.flatMap(([fieldRole, value]) => {
    if (value === undefined) {
      return [];
    }
    const profile = fieldRole === "publisher" ? "short-metadata" : "news";
    const sanitized = sanitizeModelInputText(value, {
      profile,
      fieldRole,
      maxChars: MODEL_INPUT_FIELD_CAPS[fieldRole as keyof typeof MODEL_INPUT_FIELD_CAPS],
    });
    if (sanitized.text !== undefined) {
      safe.set(fieldRole, sanitized.text);
    }
    return [
      {
        provider,
        ingress: "news",
        profile,
        fieldRole,
        droppedItemCount: 0,
        ...sanitized.telemetry,
      } satisfies ModelInputSanitizationAggregateEntry,
    ];
  });
  const title = safe.get("title");
  const publisher = safe.get("publisher");
  const summary = safe.get("summary");
  const snippet = safe.get("snippet");
  if (title === undefined && summary === undefined && snippet === undefined) {
    return {
      entries: entries.map((entry, index) => ({
        ...entry,
        droppedItemCount: index === 0 ? 1 : 0,
      })),
    };
  }
  const canonicalUrl = validatedNewsUrl(source.url);
  const {
    title: _title,
    publisher: _publisher,
    summary: _summary,
    snippet: _snippet,
    url: _url,
    canonicalUrl: _canonicalUrl,
    providerArticleId: _providerArticleId,
    ...rest
  } = source;
  const providerArticleId =
    source.providerArticleId !== undefined && STRUCTURED_ID_RE.test(source.providerArticleId)
      ? source.providerArticleId
      : undefined;
  return {
    source: {
      ...rest,
      title: title ?? `News item from ${provider}`,
      ...(canonicalUrl !== undefined ? { url: source.url, canonicalUrl } : {}),
      ...(publisher !== undefined ? { publisher } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(providerArticleId !== undefined ? { providerArticleId } : {}),
    },
    entries,
  };
}

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
  if (!isInstrumentCommand(ctx.command)) {
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
  return isInstrumentCommand(command)
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

function tickerRelevanceFloor(newsLimit: number): number {
  return Math.max(2, Math.ceil(newsLimit / 2));
}

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
  readonly newsLimit: number;
}): RelevantRepeatKeep {
  const { command, dedupedSources, survivors, targets, newsLimit } = args;
  if (!isInstrumentCommand(command) || targets.length === 0) {
    return { pool: survivors, keptRelevantRepeat: [], gap: undefined };
  }
  const relevantSurvivorCount = survivors.filter((source) =>
    isNewsRelevant(source, targets),
  ).length;
  const availableRelevantCount = relevantNewsCount(dedupedSources, targets);
  const requiredRelevantCount = Math.min(
    tickerRelevanceFloor(newsLimit),
    availableRelevantCount,
    newsLimit,
  );
  const deficit = Math.max(0, requiredRelevantCount - relevantSurvivorCount);
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
    const sanitizedResults = results.map((result, index) => {
      const provider = adapters[index]?.provider ?? "unknown";
      const sanitized = result.newsSources.map((source) => sanitizeNewsSource(source, provider));
      const droppedItemCount = sanitized.filter((item) => item.source === undefined).length;
      return {
        ...result,
        newsSources: sanitized.flatMap((item) => item.source ?? []),
        sourceGaps:
          droppedItemCount === 0
            ? result.sourceGaps
            : [
                ...result.sourceGaps,
                sourceGap({
                  source: `${provider}-news`,
                  provider,
                  capability: "news",
                  cause: "validation-failed",
                  evidenceQualityImpact: "no-cap",
                  message: `Dropped ${String(droppedItemCount)} news item(s) after model-input validation`,
                }),
              ],
        entries: sanitized.flatMap((item) => item.entries),
      };
    });
    const fetchedNewsSourceCount = results.reduce(
      (total, result) => total + result.newsSources.length,
      0,
    );
    const dedupedSources = dedupeByCanonicalUrlOrTitle(
      sanitizedResults.flatMap((result) => result.newsSources),
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
      newsLimit: ctx.newsLimit,
    });
    const repeatFallbackGaps = relevantKeep.gap === undefined ? [] : [relevantKeep.gap];
    const newsSources = assignSourceIds(
      selectRelevantFirst(relevantKeep.pool, ctx.newsLimit, providerOrder, targets),
    );
    const relevantSelectedCount = relevantNewsCount(newsSources, targets);
    const repeatFallbackUsed = filtered.sourceGaps.some((gap) => isRepeatFallbackGap(gap));
    const persistentSuppressedNewsSourceCount = dedupedSources.length - filtered.newsSources.length;

    return {
      rawSnapshots: sanitizedResults.flatMap((result) => result.rawSnapshots),
      newsSources,
      sourceGaps: [
        ...sanitizedResults.flatMap((result) => result.sourceGaps),
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
      modelInputSanitization: aggregateModelInputSanitization(
        sanitizedResults.flatMap((result) => result.entries),
      ),
    };
  }

  return {
    name: "multi-news",
    provider: "multi-news",
    normalizeNews: yahooNewsAdapter.normalizeNews,
    collect: collectNews,
  };
}
