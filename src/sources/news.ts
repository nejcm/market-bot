import type { AssetClass, Source } from "../domain/types";
import type { NewsAdapter } from "./types";
import { isRecord, optionalString, readString } from "./guards";

function readArticles(payload: unknown): readonly unknown[] {
  if (!isRecord(payload)) {
    return [];
  }

  return Array.isArray(payload.articles) ? payload.articles : [];
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

  const source = isRecord(value.source) ? optionalString(value.source, "name") : undefined;
  const publishedAt = optionalString(value, "publishedAt") ?? fetchedAt;
  const url = optionalString(value, "url");

  return {
    id: `news-${assetClass}-${index + 1}`,
    title,
    ...(url !== undefined ? { url } : {}),
    ...(source !== undefined ? { publisher: source } : {}),
    fetchedAt: publishedAt,
    kind: "news",
    assetClass,
  };
}

export function normalizeNewsPayload(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly Source[] {
  return readArticles(payload)
    .map((value, index) => normalizeArticle(value, assetClass, fetchedAt, index))
    .filter((source): source is Source => source !== undefined);
}

export const publicNewsAdapter: NewsAdapter = {
  name: "public-news",
  normalizeNews: normalizeNewsPayload,
};
