import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import { isRecord, readString } from "./guards";
import { isFetchJsonResult, type RawSourceSnapshot, type SourceRequestExecutor } from "./types";

const APEWISDOM_ADAPTER = "apewisdom";
const APEWISDOM_BASE_URL = "https://apewisdom.io/api/v1.0/filter";
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/u;

export interface ApeWisdomCandidate {
  readonly sourceProvider: "apewisdom";
  readonly sourceId: string;
  readonly filter: string;
  readonly url: string;
  readonly rank: number;
  readonly ticker: string;
  readonly name: string;
  readonly mentions: number;
  readonly upvotes: number;
  readonly rank24hAgo?: number;
  readonly mentions24hAgo?: number;
}

export interface ApeWisdomCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly candidates: readonly ApeWisdomCandidate[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface ApeWisdomClientOptions {
  readonly filter: string;
  readonly pageLimit: number;
  readonly request: SourceRequestExecutor;
}

type ApeWisdomPageParse =
  | {
      readonly status: "page";
      readonly results: readonly ApeWisdomCandidate[];
      readonly totalPages?: number;
    }
  | {
      readonly status: "gap";
      readonly gap: SourceGap;
    };

interface ParsedPageFetch {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly candidates: readonly ApeWisdomCandidate[];
  readonly sourceGaps: readonly SourceGap[];
  readonly totalPages?: number;
}

function apeWisdomSourceId(filter: string, ticker: string): string {
  return `apewisdom-${filter}-${ticker}`;
}

function apeWisdomUrl(filter: string, page: number): string {
  return `${APEWISDOM_BASE_URL}/${encodeURIComponent(filter)}/page/${String(page)}`;
}

function malformedGap(message: string): SourceGap {
  return sourceGap({
    source: APEWISDOM_ADAPTER,
    provider: "apewisdom",
    capability: "discussion",
    cause: "malformed-response",
    evidenceQualityImpact: "core-cap",
    message,
  });
}

function readInteger(value: unknown): number | undefined {
  const parsed = (() => {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return Number.NaN;
  })();

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function parseCandidate(
  value: unknown,
  filter: string,
  pageUrl: string,
): ApeWisdomCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const ticker = readString(value, "ticker")?.toUpperCase();
  const rank = readPositiveInteger(value.rank);
  const mentions = readInteger(value.mentions);
  const upvotes = readInteger(value.upvotes);
  if (
    ticker === undefined ||
    !TICKER_RE.test(ticker) ||
    rank === undefined ||
    mentions === undefined ||
    upvotes === undefined
  ) {
    return undefined;
  }

  const name = readString(value, "name") ?? ticker;
  const rank24hAgo = readPositiveInteger(value.rank_24h_ago);
  const mentions24hAgo = readInteger(value.mentions_24h_ago);

  return {
    sourceProvider: "apewisdom",
    sourceId: apeWisdomSourceId(filter, ticker),
    filter,
    url: pageUrl,
    rank,
    ticker,
    name,
    mentions,
    upvotes,
    ...(rank24hAgo !== undefined ? { rank24hAgo } : {}),
    ...(mentions24hAgo !== undefined ? { mentions24hAgo } : {}),
  };
}

function parsePage(payload: unknown, filter: string, pageUrl: string): ApeWisdomPageParse {
  const page = isRecord(payload) ? payload : undefined;
  const results = Array.isArray(page?.results) ? page.results : undefined;
  if (results === undefined) {
    return { status: "gap", gap: malformedGap("ApeWisdom response missing results array") };
  }

  const totalPages = readPositiveInteger(page?.pages);
  return {
    status: "page",
    results: results.flatMap((row) => {
      const candidate = parseCandidate(row, filter, pageUrl);
      return candidate === undefined ? [] : [candidate];
    }),
    ...(totalPages !== undefined ? { totalPages } : {}),
  };
}

async function fetchPage(
  options: ApeWisdomClientOptions,
  page: number,
): Promise<{
  readonly url: string;
  readonly result: Awaited<ReturnType<SourceRequestExecutor["json"]>>;
}> {
  const url = apeWisdomUrl(options.filter, page);
  return {
    url,
    result: await options.request.json({ url, adapter: APEWISDOM_ADAPTER }),
  };
}

function parsePageFetch(
  fetched: {
    readonly url: string;
    readonly result: Awaited<ReturnType<SourceRequestExecutor["json"]>>;
  },
  filter: string,
): ParsedPageFetch {
  if (!isFetchJsonResult(fetched.result)) {
    return { rawSnapshots: [], candidates: [], sourceGaps: [fetched.result] };
  }

  const parsed = parsePage(fetched.result.payload, filter, fetched.url);
  if (parsed.status === "gap") {
    return {
      rawSnapshots: [fetched.result.rawSnapshot],
      candidates: [],
      sourceGaps: [parsed.gap],
    };
  }

  return {
    rawSnapshots: [fetched.result.rawSnapshot],
    candidates: parsed.results,
    sourceGaps: [],
    ...(parsed.totalPages !== undefined ? { totalPages: parsed.totalPages } : {}),
  };
}

function pageRange(start: number, end: number): readonly number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export async function collectApeWisdomCandidates(
  options: ApeWisdomClientOptions,
): Promise<ApeWisdomCollectionResult> {
  if (options.pageLimit <= 0) {
    return { rawSnapshots: [], candidates: [], sourceGaps: [] };
  }

  const firstPage = parsePageFetch(await fetchPage(options, 1), options.filter);
  const finalPage = Math.min(options.pageLimit, firstPage.totalPages ?? options.pageLimit);
  const remainingPages = await Promise.all(
    pageRange(2, finalPage).map((page) => fetchPage(options, page)),
  );
  const pages = [firstPage, ...remainingPages.map((page) => parsePageFetch(page, options.filter))];

  return {
    rawSnapshots: pages.flatMap((page) => page.rawSnapshots),
    candidates: pages.flatMap((page) => page.candidates),
    sourceGaps: pages.flatMap((page) => page.sourceGaps),
  };
}
