import type { AssetClass, Source } from "../domain/types";
import { isRecord, optionalString, readString } from "../guards";
import { canonicalizeUrl, encodeQuery, newsQuery } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type NewsCollectionResult,
  type NewsAdapter,
  type ThematicNewsQuery,
} from "./types";

const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

function normalizeArticle(
  value: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
  index: number,
): Source | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const title = readString(value, "title");
  if (title === undefined) {
    return undefined;
  }

  const url = optionalString(value, "link");
  const publisher = optionalString(value, "publisher");
  const canonicalUrl = canonicalizeUrl(url);

  const { providerPublishTime } = value;
  const publishedAt =
    typeof providerPublishTime === "number"
      ? new Date(providerPublishTime * 1000).toISOString()
      : fetchedAt;

  return {
    id: `news-${assetClass}-${index + 1}`,
    title,
    ...(url !== undefined ? { url } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    fetchedAt: publishedAt,
    kind: "news",
    assetClass,
    provider: "yahoo-news",
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
  };
}

function normalizeNews(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly Source[] {
  if (!isRecord(payload) || !Array.isArray(payload.news)) {
    return [];
  }

  return payload.news
    .map((item: unknown, index: number) => normalizeArticle(item, assetClass, fetchedAt, index))
    .filter((source): source is Source => source !== undefined);
}

async function collectQuery(
  ctx: CollectContext,
  query: string,
  adapter: string,
): Promise<NewsCollectionResult> {
  const { command, newsLimit } = ctx;
  const url = `${YAHOO_SEARCH_URL}?${encodeQuery({ q: query, newsCount: String(newsLimit) })}`;
  const fetched = await ctx.request.json({
    url,
    adapter,
  });

  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], newsSources: [], sourceGaps: [fetched] };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    newsSources: normalizeNews(fetched.payload, command.assetClass, fetched.rawSnapshot.fetchedAt),
    sourceGaps: [],
  };
}

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  return collectQuery(ctx, newsQuery(ctx.command), "yahoo-news");
}

async function searchThematic(
  ctx: CollectContext,
  query: ThematicNewsQuery,
): Promise<NewsCollectionResult> {
  const search = query.terms.map((term) => `"${term}"`).join(" OR ");
  return collectQuery(ctx, search, "yahoo-news-thematic");
}

export const yahooNewsAdapter: NewsAdapter = {
  name: "yahoo-news",
  provider: "yahoo-news",
  normalizeNews,
  collect: collectNews,
  searchThematic,
};
