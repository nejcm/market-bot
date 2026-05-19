import type { ResearchCommand } from "../cli/args";
import type { AssetClass, Source } from "../domain/types";
import { isRecord, optionalString, readString } from "./guards";
import type { NewsAdapter } from "./types";

const YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function newsQuery(command: ResearchCommand): string {
  if (command.jobType === "ticker") {
    return command.symbol;
  }

  return command.assetClass === "equity" ? "stock market" : "crypto market";
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

  const url = optionalString(value, "link");
  const publisher = optionalString(value, "publisher");

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

export const yahooNewsAdapter: NewsAdapter = {
  name: "yahoo-news",
  buildUrl: (command: ResearchCommand, limit: number) =>
    `${YAHOO_SEARCH_URL}?${encodeQuery({ q: newsQuery(command), newsCount: String(limit) })}`,
  normalizeNews,
};
