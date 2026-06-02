import type { ResearchCommand } from "../cli/args";
import { sourceGapWithContext } from "../domain/source-gaps";
import type {
  AssetClass,
  InstrumentIdentity,
  MarketSnapshot,
  Source,
  SourceGap,
  SourceGapCapability,
} from "../domain/types";
import { isRecord, optionalString, readNumber, readString } from "./guards";
import { canonicalizeUrl, dateDaysBefore, encodeQuery, recencyDays } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type NewsAdapter,
  type NewsCollectionResult,
  type SupplementalMarketCollectionResult,
  type SupplementalMarketDataAdapter,
} from "./types";

const MASSIVE_PROVIDER = "massive";
const MASSIVE_STOCK_SNAPSHOT_URL =
  "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers";
const MASSIVE_NEWS_URL = "https://api.massive.com/v2/reference/news";

function readResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload.tickers)) {
    return payload.tickers;
  }

  return Array.isArray(payload.results) ? payload.results : [];
}

function readNestedNumber(
  record: Record<string, unknown>,
  key: string,
  nestedKey: string,
): number | undefined {
  const nested = record[key];
  return isRecord(nested) ? readNumber(nested, nestedKey) : undefined;
}

function normalizeSnapshot(value: unknown, fetchedAt: string): MarketSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = (readString(value, "ticker") ?? readString(value, "symbol"))?.trim().toUpperCase();
  const price =
    readNestedNumber(value, "lastTrade", "p") ??
    readNestedNumber(value, "day", "c") ??
    readNestedNumber(value, "min", "c");
  const changePercent24h = readNumber(value, "todaysChangePerc");
  const volume = readNestedNumber(value, "day", "v");

  if (
    symbol === undefined ||
    price === undefined ||
    changePercent24h === undefined ||
    volume === undefined
  ) {
    return undefined;
  }

  const open = readNestedNumber(value, "day", "o");
  const previousClose = readNestedNumber(value, "prevDay", "c");
  const identity: InstrumentIdentity = {
    aliases: [{ provider: MASSIVE_PROVIDER, idKind: "ticker", value: symbol }],
  };

  return {
    sourceId: `supplemental-market-massive-equity-${symbol.toLowerCase()}`,
    assetClass: "equity",
    symbol,
    identity,
    price,
    changePercent24h,
    volume,
    ...(open !== undefined ? { open } : {}),
    ...(previousClose !== undefined ? { previousClose } : {}),
    observedAt: fetchedAt,
  };
}

export function normalizeMassiveSnapshotPayload(
  payload: unknown,
  fetchedAt: string,
): readonly MarketSnapshot[] {
  return readResults(payload)
    .map((value) => normalizeSnapshot(value, fetchedAt))
    .filter((snapshot): snapshot is MarketSnapshot => snapshot !== undefined);
}

function uniqueEquitySymbols(snapshots: readonly MarketSnapshot[]): string {
  return [
    ...new Set(
      snapshots
        .filter((snapshot) => snapshot.assetClass === "equity")
        .map((snapshot) => snapshot.symbol.trim().toUpperCase())
        .filter((symbol) => symbol !== ""),
    ),
  ].join(",");
}

function buildMassiveSnapshotUrl(symbols: string, apiKey: string): string {
  return `${MASSIVE_STOCK_SNAPSHOT_URL}?${encodeQuery({ tickers: symbols, apiKey })}`;
}

function massiveGap(gap: SourceGap, capability: SourceGapCapability): SourceGap {
  return sourceGapWithContext(gap, {
    provider: MASSIVE_PROVIDER,
    capability,
    evidenceQualityImpact: "core-cap",
  });
}

async function collectSupplementalMarket(
  ctx: CollectContext,
  primarySnapshots: readonly MarketSnapshot[],
): Promise<SupplementalMarketCollectionResult> {
  if (ctx.command.assetClass !== "equity" || ctx.massiveApiKey === undefined) {
    return { rawSnapshots: [], supplementalMarketSnapshots: [], sourceGaps: [] };
  }

  const symbols = uniqueEquitySymbols(primarySnapshots);
  if (symbols === "") {
    return { rawSnapshots: [], supplementalMarketSnapshots: [], sourceGaps: [] };
  }

  const fetched = await ctx.request.json({
    url: buildMassiveSnapshotUrl(symbols, ctx.massiveApiKey),
    adapter: "massive-supplemental-market",
  });

  if (!isFetchJsonResult(fetched)) {
    return {
      rawSnapshots: [],
      supplementalMarketSnapshots: [],
      sourceGaps: [massiveGap(fetched, "market-data")],
    };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    supplementalMarketSnapshots: normalizeMassiveSnapshotPayload(
      fetched.payload,
      fetched.rawSnapshot.fetchedAt,
    ),
    sourceGaps: [],
  };
}

function buildMassiveNewsUrl(
  command: ResearchCommand,
  limit: number,
  apiKey: string,
  fetchedAt: string,
): string {
  const params: Record<string, string> = {
    apiKey,
    limit: String(limit),
    order: "desc",
    sort: "published_utc",
    "published_utc.gte": dateDaysBefore(fetchedAt, recencyDays(command)).toISOString(),
  };

  if (command.jobType === "ticker") {
    params.ticker = command.symbol;
  }

  return `${MASSIVE_NEWS_URL}?${encodeQuery(params)}`;
}

function readPublisher(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  if (isRecord(value)) {
    return optionalString(value, "name");
  }

  return undefined;
}

function normalizeNewsArticle(
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

  const url = optionalString(value, "article_url") ?? optionalString(value, "url");
  const publisher = readPublisher(value.publisher);
  const providerArticleId = optionalString(value, "id");
  const publishedAt = optionalString(value, "published_utc") ?? fetchedAt;
  const summary = optionalString(value, "description");
  const canonicalUrl = canonicalizeUrl(url);

  return {
    id: `news-${assetClass}-massive-${index + 1}`,
    title,
    ...(url !== undefined ? { url } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    fetchedAt: publishedAt,
    kind: "news",
    assetClass,
    provider: MASSIVE_PROVIDER,
    ...(providerArticleId !== undefined ? { providerArticleId } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function normalizeNews(
  payload: unknown,
  assetClass: AssetClass,
  fetchedAt: string,
): readonly Source[] {
  return readResults(payload)
    .map((item, index) => normalizeNewsArticle(item, assetClass, fetchedAt, index))
    .filter((source): source is Source => source !== undefined);
}

async function collectNews(ctx: CollectContext): Promise<NewsCollectionResult> {
  if (ctx.command.assetClass !== "equity" || ctx.massiveApiKey === undefined) {
    return { rawSnapshots: [], newsSources: [], sourceGaps: [] };
  }

  const fetched = await ctx.request.json({
    url: buildMassiveNewsUrl(ctx.command, ctx.newsLimit, ctx.massiveApiKey, ctx.fetchedAt),
    adapter: "massive-news",
  });

  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], newsSources: [], sourceGaps: [massiveGap(fetched, "news")] };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    newsSources: normalizeNews(
      fetched.payload,
      ctx.command.assetClass,
      fetched.rawSnapshot.fetchedAt,
    ),
    sourceGaps: [],
  };
}

export const massiveSupplementalMarketDataAdapter: SupplementalMarketDataAdapter = {
  name: "massive-supplemental-market",
  assetClass: "equity",
  normalizeMarkets: normalizeMassiveSnapshotPayload,
  collect: collectSupplementalMarket,
};

export const massiveNewsAdapter: NewsAdapter = {
  name: "massive-news",
  provider: MASSIVE_PROVIDER,
  normalizeNews,
  collect: collectNews,
};
