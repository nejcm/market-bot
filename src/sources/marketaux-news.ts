import type { ResearchCommand } from "../cli/args";
import type { AssetClass, Source } from "../domain/types";
import { isRecord, optionalString, readString } from "./guards";
import { canonicalizeUrl, dateDaysBefore, encodeQuery, newsQuery, recencyDays } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type NewsAdapter,
  type NewsCollectionResult,
} from "./types";

const MARKETAUX_NEWS_URL = "https://api.marketaux.com/v1/news/all";

function buildMarketAuxUrl(
  command: ResearchCommand,
  limit: number,
  token: string,
  fetchedAt: string,
): string {
  const params: Record<string, string> = {
    api_token: token,
    language: "en",
    limit: String(limit),
    published_after: dateDaysBefore(fetchedAt, recencyDays(command)).toISOString(),
  };

  if (command.jobType === "ticker") {
    params.symbols = command.symbol;
    params.filter_entities = "true";
  } else {
    params.search = newsQuery(command);
  }

  return `${MARKETAUX_NEWS_URL}?${encodeQuery(params)}`;
}

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

  const url = optionalString(value, "url");
  const publisher = optionalString(value, "source");
  const publishedAt = optionalString(value, "published_at") ?? fetchedAt;
  const providerArticleId = optionalString(value, "uuid");
  const summary = optionalString(value, "description");
  const snippet = optionalString(value, "snippet");
  const canonicalUrl = canonicalizeUrl(url);

  return {
    id: `news-${assetClass}-marketaux-${index + 1}`,
    title,
    ...(url !== undefined ? { url } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    fetchedAt: publishedAt,
    kind: "news",
    assetClass,
    provider: "marketaux",
    ...(providerArticleId !== undefined ? { providerArticleId } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
  };
}

function normalizeNews(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly Source[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return [];
  }

  return payload.data
    .map((item: unknown, index: number) => normalizeArticle(item, assetClass, fetchedAt, index))
    .filter((source): source is Source => source !== undefined);
}

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  const { command, fetchedAt, sourceTimeoutMs, newsLimit, fetchImpl, fetchOrGap, retryDelaysMs } =
    ctx;

  if (ctx.marketauxApiToken === undefined) {
    return {
      rawSnapshots: [],
      newsSources: [],
      sourceGaps: [{ source: "marketaux-news", message: "missing MARKET_BOT_MARKETAUX_API_TOKEN" }],
    };
  }

  const fetched = await fetchOrGap(
    buildMarketAuxUrl(command, newsLimit, ctx.marketauxApiToken, fetchedAt),
    "marketaux-news",
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

export const marketAuxNewsAdapter: NewsAdapter = {
  name: "marketaux-news",
  buildUrl: (command: ResearchCommand, limit: number) =>
    buildMarketAuxUrl(command, limit, "MARKET_BOT_MARKETAUX_API_TOKEN", new Date().toISOString()),
  normalizeNews,
  collect: collectNews,
};
