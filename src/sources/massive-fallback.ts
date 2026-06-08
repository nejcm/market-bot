import type { Observation } from "../forecast/observable";
import type { MarketSnapshot } from "../domain/types";
import { isRecord, optionalString, readNumber, readString } from "./guards";
import {
  buildMassiveAggregatesUrl,
  buildMassiveSnapshotUrl,
  buildMassiveTickerDetailsUrl,
  normalizeMassiveSnapshotPayload,
  type MassiveQuoteDetails,
} from "./massive";
import type { FetchLike } from "./types";

export interface MassiveQuoteFallbackResult {
  readonly payload: unknown;
  readonly fetchedAt: string;
}

export interface MassiveQuoteFallbackOptions {
  readonly enrichTickerDetails?: boolean;
}

const MASSIVE_TICKER_DETAILS_CONCURRENCY = 5;

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toYahooQuoteResult(details: MassiveQuoteDetails): Record<string, unknown> {
  return {
    symbol: details.symbol,
    regularMarketPrice: details.price,
    regularMarketChangePercent: details.changePercent24h,
    regularMarketVolume: details.volume,
    ...(details.marketCap !== undefined ? { marketCap: details.marketCap } : {}),
    ...(details.exchange !== undefined ? { exchange: details.exchange } : {}),
    ...(details.name !== undefined ? { shortName: details.name } : {}),
    quoteType: "EQUITY",
  };
}

export function buildYahooQuotePayloadFromMassive(
  details: readonly MassiveQuoteDetails[],
): unknown {
  return {
    quoteResponse: {
      result: details.map((detail) => toYahooQuoteResult(detail)),
    },
  };
}

async function fetchTickerDetails(
  symbol: string,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<Partial<MassiveQuoteDetails>> {
  const response = await fetchImpl(buildMassiveTickerDetailsUrl(symbol, apiKey), {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
  });
  if (!response.ok) {
    return {};
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !isRecord(payload.results)) {
    return {};
  }

  const { results } = payload as { results: Record<string, unknown> };
  const marketCap = readNumber(results, "market_cap");
  const exchange = optionalString(results, "primary_exchange");
  const name = optionalString(results, "name");
  return {
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function mergeQuoteDetails(
  snapshot: MarketSnapshot,
  details: Partial<MassiveQuoteDetails>,
): MassiveQuoteDetails {
  return {
    symbol: snapshot.symbol,
    price: snapshot.price,
    changePercent24h: snapshot.changePercent24h,
    volume: snapshot.volume,
    ...(snapshot.marketCap !== undefined ? { marketCap: snapshot.marketCap } : {}),
    ...(details.marketCap !== undefined ? { marketCap: details.marketCap } : {}),
    ...(details.exchange !== undefined ? { exchange: details.exchange } : {}),
    ...(details.name !== undefined ? { name: details.name } : {}),
  };
}

async function enrichSnapshotsWithTickerDetails(
  snapshots: readonly MarketSnapshot[],
  apiKey: string,
  fetchImpl: FetchLike,
  offset = 0,
  acc: MassiveQuoteDetails[] = [],
): Promise<MassiveQuoteDetails[]> {
  if (offset >= snapshots.length) {
    return acc;
  }

  const batch = snapshots.slice(offset, offset + MASSIVE_TICKER_DETAILS_CONCURRENCY);
  const batchDetails = await Promise.all(
    batch.map(async (snapshot) => {
      const tickerDetails = await fetchTickerDetails(snapshot.symbol, apiKey, fetchImpl);
      return mergeQuoteDetails(snapshot, tickerDetails);
    }),
  );

  return enrichSnapshotsWithTickerDetails(
    snapshots,
    apiKey,
    fetchImpl,
    offset + MASSIVE_TICKER_DETAILS_CONCURRENCY,
    [...acc, ...batchDetails],
  );
}

export async function fetchMassiveQuoteFallback(
  symbols: readonly string[],
  apiKey: string | undefined,
  fetchImpl: FetchLike,
  fetchedAt: string = new Date().toISOString(),
  options: MassiveQuoteFallbackOptions = {},
): Promise<MassiveQuoteFallbackResult | undefined> {
  if (apiKey === undefined || symbols.length === 0) {
    return undefined;
  }

  const tickers = [
    ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)),
  ];
  if (tickers.length === 0) {
    return undefined;
  }

  const response = await fetchImpl(buildMassiveSnapshotUrl(tickers.join(","), apiKey), {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
  });
  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as unknown;
  const snapshots = normalizeMassiveSnapshotPayload(payload, fetchedAt);
  if (snapshots.length === 0) {
    return undefined;
  }

  const enrichTickerDetails = options.enrichTickerDetails ?? false;
  const details = enrichTickerDetails
    ? await enrichSnapshotsWithTickerDetails(snapshots, apiKey, fetchImpl)
    : snapshots.map((snapshot) => mergeQuoteDetails(snapshot, {}));

  return {
    payload: buildYahooQuotePayloadFromMassive(details),
    fetchedAt,
  };
}

export function massiveSnapshotsFromQuoteFallback(
  fallback: MassiveQuoteFallbackResult,
): readonly MarketSnapshot[] {
  const { payload } = fallback;
  if (!isRecord(payload) || !isRecord(payload.quoteResponse)) {
    return [];
  }

  const { quoteResponse } = payload;
  const results = Array.isArray(quoteResponse.result) ? quoteResponse.result : [];
  return results.flatMap((value): readonly MarketSnapshot[] => {
    if (!isRecord(value)) {
      return [];
    }
    const symbol = readString(value, "symbol")?.trim().toUpperCase();
    const price = readNumber(value, "regularMarketPrice");
    const changePercent24h = readNumber(value, "regularMarketChangePercent");
    const volume = readNumber(value, "regularMarketVolume");
    if (
      symbol === undefined ||
      price === undefined ||
      changePercent24h === undefined ||
      volume === undefined
    ) {
      return [];
    }

    const marketCap = readNumber(value, "marketCap");
    const name = optionalString(value, "shortName");
    const exchange = optionalString(value, "exchange");
    return [
      {
        sourceId: `market-yahoo-equity-${symbol.toLowerCase()}`,
        assetClass: "equity",
        symbol,
        ...(name !== undefined ? { name } : {}),
        identity: {
          ...(exchange !== undefined ? { exchange } : {}),
          ...(name !== undefined ? { displayName: name } : {}),
          aliases: [{ provider: "yahoo", idKind: "symbol", value: symbol }],
        },
        price,
        changePercent24h,
        volume,
        ...(marketCap !== undefined ? { marketCap } : {}),
        observedAt: fallback.fetchedAt,
      },
    ];
  });
}

export async function fetchMassiveCloseWindow(
  symbol: string,
  from: Date,
  to: Date,
  apiKey: string | undefined,
  fetchImpl: FetchLike,
): Promise<readonly Observation[] | undefined> {
  if (apiKey === undefined) {
    return undefined;
  }

  const response = await fetchImpl(buildMassiveAggregatesUrl(symbol, ymd(from), ymd(to), apiKey), {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
  });
  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return undefined;
  }

  return payload.results.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const timestamp = readNumber(value, "t");
    const close = readNumber(value, "c");
    if (timestamp === undefined || close === undefined) {
      return [];
    }
    return [{ subject: symbol.toUpperCase(), date: ymd(new Date(timestamp)), value: close }];
  });
}
