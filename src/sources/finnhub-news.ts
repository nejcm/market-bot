import type { ResearchCommand } from "../cli/args";
import { sourceGap } from "../domain/source-gaps";
import type { AssetClass, Source } from "../domain/types";
import { isRecord, optionalString, readNumber, readString } from "./guards";
import { canonicalizeUrl, dateDaysBefore, encodeQuery, recencyDays, ymd } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type NewsAdapter,
  type NewsCollectionResult,
} from "./types";

const FINNHUB_API_URL = "https://finnhub.io/api/v1";

function buildFinnhubUrl(command: ResearchCommand, token: string, fetchedAt: string): string {
  if (command.jobType === "ticker" && command.assetClass === "equity") {
    const from = ymd(dateDaysBefore(fetchedAt, recencyDays(command)));
    const to = ymd(new Date(fetchedAt));
    return `${FINNHUB_API_URL}/company-news?${encodeQuery({ symbol: command.symbol, from, to, token })}`;
  }

  const category = command.assetClass === "crypto" ? "crypto" : "general";
  return `${FINNHUB_API_URL}/news?${encodeQuery({ category, token })}`;
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

  const title = readString(value, "headline");
  if (title === undefined) {
    return undefined;
  }

  const url = optionalString(value, "url");
  const publisher = optionalString(value, "source");
  const publishedTime = readNumber(value, "datetime");
  const providerArticleId = readNumber(value, "id");
  const summary = optionalString(value, "summary");
  const canonicalUrl = canonicalizeUrl(url);
  const publishedAt =
    publishedTime !== undefined ? new Date(publishedTime * 1000).toISOString() : fetchedAt;

  return {
    id: `news-${assetClass}-finnhub-${index + 1}`,
    title,
    ...(url !== undefined ? { url } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    fetchedAt: publishedAt,
    kind: "news",
    assetClass,
    provider: "finnhub",
    ...(providerArticleId !== undefined ? { providerArticleId: String(providerArticleId) } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function normalizeNews(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly Source[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((item: unknown, index: number) => normalizeArticle(item, assetClass, fetchedAt, index))
    .filter((source): source is Source => source !== undefined);
}

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  const { command, fetchedAt, newsLimit } = ctx;

  if (ctx.finnhubApiToken === undefined) {
    return {
      rawSnapshots: [],
      newsSources: [],
      sourceGaps: [
        sourceGap({
          source: "finnhub-news",
          message: "missing MARKET_BOT_FINNHUB_API_TOKEN",
          provider: "finnhub",
          capability: "news",
          cause: "missing-credential",
          evidenceQualityImpact: "no-cap",
        }),
      ],
    };
  }

  const fetched = await ctx.request.json({
    url: buildFinnhubUrl(command, ctx.finnhubApiToken, fetchedAt),
    adapter: "finnhub-news",
  });

  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], newsSources: [], sourceGaps: [fetched] };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    newsSources: normalizeNews(
      fetched.payload,
      command.assetClass,
      fetched.rawSnapshot.fetchedAt,
    ).slice(0, newsLimit),
    sourceGaps: [],
  };
}

export const finnhubNewsAdapter: NewsAdapter = {
  name: "finnhub-news",
  provider: "finnhub",
  normalizeNews,
  collect: collectNews,
};
