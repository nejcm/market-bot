import { isRecord, optionalString, readNumber, readString } from "./guards";
import { encodeQuery } from "./news-utils";
import type { CollectContext, FetchJsonResult, FetchLike } from "./types";
import type { SourceGap } from "../domain/types";

export const FIRECRAWL_PROVIDER = "firecrawl";
const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2";
const FIRECRAWL_SEARCH_ADAPTER = "firecrawl-search";
const FIRECRAWL_SCRAPE_ADAPTER = "firecrawl-scrape";
const FIRECRAWL_MAX_URL_CHARS = 2048;

// Structurally compatible with web-gather-tools.ts's provider result shape (url, title?, summary?, text?, highlights) so Firecrawl results flow through the same sanitize/emit path as Exa results. `highlights` is always empty: Firecrawl has no highlight equivalent.
export interface FirecrawlWebResult {
  readonly url: string;
  readonly title?: string;
  readonly summary?: string;
  readonly text?: string;
  readonly highlights: readonly string[];
}

export interface FirecrawlResultsParse {
  readonly results: readonly FirecrawlWebResult[];
  readonly malformed: boolean;
  readonly creditsUsed?: number;
}

// Same http(s)-only, no-credentials, bounded-length validation Exa results get in web-gather-tools.ts's validatedWebUrl, duplicated here to keep the two provider adapters independently importable without a circular module dependency between them.
function validatedFirecrawlUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed.length > FIRECRAWL_MAX_URL_CHARS) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return undefined;
    }
    const normalized = parsed.toString();
    return normalized.length <= FIRECRAWL_MAX_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function firecrawlRequestInit(apiKey: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

function firecrawlEndpointFetch(baseFetch: FetchLike): FetchLike {
  return (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    url.search = "";
    return baseFetch(url, init);
  };
}

// Maps our internal freshness window semantics onto Firecrawl's `tbs` time filter. news/market are recent-reporting windows (~1 month); current-subject is a wider current-context window (~1 year); background (durable profile) is left unbounded.
export function firecrawlTbsForSearchType(searchType: string): string | undefined {
  if (searchType === "news" || searchType === "market") {
    return "qdr:m";
  }
  return searchType === "current-subject" ? "qdr:y" : undefined;
}

// POST /v2/search. Shapes verified against current Firecrawl v2 docs: `sources` and search-time `scrapeOptions.formats` are object-shaped ({"type": "web"} / {"type": "markdown"}), not plain strings.
export async function requestFirecrawlSearch(
  ctx: CollectContext,
  apiKey: string,
  query: string,
  numResults: number,
  tbs: string | undefined,
): Promise<FetchJsonResult | SourceGap> {
  const body = {
    query,
    limit: numResults,
    sources: [{ type: "web" }],
    ...(tbs !== undefined ? { tbs } : {}),
    scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true },
  };
  return ctx.request.json({
    url: `${FIRECRAWL_API_URL}/search?${encodeQuery({
      query,
      numResults: String(numResults),
      ...(tbs !== undefined ? { tbs } : {}),
    })}`,
    adapter: FIRECRAWL_SEARCH_ADAPTER,
    init: firecrawlRequestInit(apiKey, body),
    fetch: firecrawlEndpointFetch,
  });
}

// POST /v2/scrape. `formats` accepts plain strings for scrape (unlike search's scrapeOptions.formats, which requires the object shape).
export async function requestFirecrawlScrape(
  ctx: CollectContext,
  apiKey: string,
  url: string,
): Promise<FetchJsonResult | SourceGap> {
  const body = { url, formats: ["markdown"], onlyMainContent: true };
  return ctx.request.json({
    url: `${FIRECRAWL_API_URL}/scrape?${encodeQuery({ url })}`,
    adapter: FIRECRAWL_SCRAPE_ADAPTER,
    init: firecrawlRequestInit(apiKey, body),
    fetch: firecrawlEndpointFetch,
  });
}

// Response shape: { success, data: { web: [{ title, description, url, markdown, ... }] }, creditsUsed }.
export function parseFirecrawlSearchResults(payload: unknown): FirecrawlResultsParse {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.web)) {
    return { results: [], malformed: true };
  }
  const items = payload.data.web;
  const results = items.flatMap((value): FirecrawlWebResult[] => {
    if (!isRecord(value)) {
      return [];
    }
    const url = validatedFirecrawlUrl(readString(value, "url"));
    if (url === undefined) {
      return [];
    }
    const title = optionalString(value, "title");
    const summary = optionalString(value, "description");
    const text = optionalString(value, "markdown");
    return [
      {
        url,
        ...(title !== undefined ? { title } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(text !== undefined ? { text } : {}),
        highlights: [],
      },
    ];
  });
  const creditsUsed = readNumber(payload, "creditsUsed");
  return {
    results,
    malformed: items.length > 0 && results.length === 0,
    ...(creditsUsed !== undefined ? { creditsUsed } : {}),
  };
}

// Response shape: { success, data: { markdown, html, metadata } }.
export function parseFirecrawlScrapeResult(url: string, payload: unknown): FirecrawlResultsParse {
  const validatedUrl = validatedFirecrawlUrl(url);
  if (!isRecord(payload) || !isRecord(payload.data) || validatedUrl === undefined) {
    return { results: [], malformed: true };
  }
  const text = optionalString(payload.data, "markdown");
  if (text === undefined) {
    return { results: [], malformed: true };
  }
  return { results: [{ url: validatedUrl, text, highlights: [] }], malformed: false };
}
