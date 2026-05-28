import type { ResearchCommand } from "../cli/args";
import type { AssetClass, Source } from "../domain/types";
import { isRecord, optionalString, readString } from "./guards";
import { canonicalizeUrl, encodeQuery, newsQuery } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type NewsCollectionResult,
  type NewsAdapter,
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

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  const { command, fetchedAt, sourceTimeoutMs, newsLimit, fetchImpl, fetchOrGap, retryDelaysMs } =
    ctx;
  const url = `${YAHOO_SEARCH_URL}?${encodeQuery({ q: newsQuery(command), newsCount: String(newsLimit) })}`;
  const fetched = await fetchOrGap(
    url,
    "yahoo-news",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
  );

  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], newsSources: [], sourceGaps: [fetched] };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    newsSources: normalizeNews(fetched.payload, command.assetClass, fetchedAt),
    sourceGaps: [],
  };
}

export const yahooNewsAdapter: NewsAdapter = {
  name: "yahoo-news",
  buildUrl: (command: ResearchCommand, limit: number) =>
    `${YAHOO_SEARCH_URL}?${encodeQuery({ q: newsQuery(command), newsCount: String(limit) })}`,
  normalizeNews,
  collect: collectNews,
};
