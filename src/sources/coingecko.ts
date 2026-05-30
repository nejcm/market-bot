import type { InstrumentIdentity, MarketSnapshot } from "../domain/types";
import {
  isFetchJsonResult,
  type CollectContext,
  type MarketCollectionResult,
  type MarketDataAdapter,
} from "./types";
import { isRecord, optionalString, readNumber, readString } from "./guards";

function normalizeCoinGeckoMarket(value: unknown, fetchedAt: string): MarketSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = readString(value, "symbol")?.trim().toUpperCase();
  const coinId = readString(value, "id")?.trim();
  const price = readNumber(value, "current_price");
  const changePercent24h = readNumber(value, "price_change_percentage_24h");
  const volume = readNumber(value, "total_volume");

  if (
    symbol === undefined ||
    price === undefined ||
    changePercent24h === undefined ||
    volume === undefined
  ) {
    return undefined;
  }

  const name = optionalString(value, "name");
  const marketCap = readNumber(value, "market_cap");
  const identity: InstrumentIdentity = {
    quoteCurrency: "USD",
    ...(name !== undefined ? { displayName: name } : {}),
    ...(coinId !== undefined
      ? { providerIds: [{ provider: "coingecko", idKind: "coin-id", value: coinId }] }
      : {}),
    aliases: [{ provider: "coingecko", idKind: "symbol", value: symbol }],
  };

  return {
    sourceId: `market-coingecko-crypto-${symbol.toLowerCase()}`,
    assetClass: "crypto",
    symbol,
    ...(name !== undefined ? { name } : {}),
    identity,
    price,
    changePercent24h,
    volume,
    ...(marketCap !== undefined ? { marketCap } : {}),
    observedAt: fetchedAt,
  };
}

export function normalizeCoinGeckoMarketsPayload(
  payload: unknown,
  fetchedAt: string,
): readonly MarketSnapshot[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((value) => normalizeCoinGeckoMarket(value, fetchedAt))
    .filter((snapshot): snapshot is MarketSnapshot => snapshot !== undefined);
}

const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function coinGeckoMarketsUrl(perPage: number): string {
  return `${COINGECKO_MARKETS_URL}?${encodeQuery({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: String(perPage),
    page: "1",
    sparkline: "false",
    price_change_percentage: "24h",
  })}`;
}

function fetchLimit(ctx: CollectContext): number {
  const { command, cryptoMoverLimit } = ctx;
  if (command.jobType === "daily" || command.jobType === "weekly") {
    return Math.max(cryptoMoverLimit * 10, 50);
  }
  return 250;
}

async function collectCrypto(ctx: CollectContext): Promise<MarketCollectionResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  const fetched = await fetchOrGap(
    coinGeckoMarketsUrl(fetchLimit(ctx)),
    "coingecko",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
  );

  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], marketSnapshots: [], sourceGaps: [fetched] };
  }

  const all = normalizeCoinGeckoMarketsPayload(fetched.payload, fetchedAt);
  const marketSnapshots =
    command.jobType === "ticker" ? all.filter((s) => s.symbol === command.symbol) : all;

  return {
    rawSnapshots: [fetched.rawSnapshot],
    marketSnapshots,
    sourceGaps: [],
  };
}

export const coinGeckoMarketDataAdapter: MarketDataAdapter = {
  name: "coingecko",
  assetClass: "crypto",
  normalizeMarkets: normalizeCoinGeckoMarketsPayload,
  collect: collectCrypto,
};

const COINGECKO_CHART_URL = "https://api.coingecko.com/api/v3/coins";

function coinGeckoChartUrl(coinId: string, date: Date): string {
  const from = Math.floor(date.getTime() / 1000) - 3600;
  const to = from + 86_400 + 3600;
  const params = new URLSearchParams({
    vs_currency: "usd",
    from: String(from),
    to: String(to),
  });
  return `${COINGECKO_CHART_URL}/${encodeURIComponent(coinId)}/market_chart/range?${params.toString()}`;
}

function extractCloseFromCoinGeckoPayload(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const { prices } = payload;
  if (!Array.isArray(prices) || prices.length === 0) {
    return undefined;
  }
  const last = prices.at(-1);
  if (!Array.isArray(last) || last.length < 2) {
    return undefined;
  }
  return typeof last[1] === "number" ? (last[1] as number) : undefined;
}

export async function fetchCoinGeckoClose(
  coinId: string,
  date: Date,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(coinGeckoChartUrl(coinId, date), {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "user-agent": "market-bot/0.1 research-cli" },
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as unknown;
    return extractCloseFromCoinGeckoPayload(payload);
  } catch {
    return undefined;
  }
}
