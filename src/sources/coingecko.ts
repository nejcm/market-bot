import type { MarketSnapshot } from "../domain/types";
import type { MarketDataAdapter } from "./types";
import { isRecord, optionalString, readNumber, readString } from "./guards";

function normalizeCoinGeckoMarket(value: unknown, fetchedAt: string): MarketSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = readString(value, "symbol")?.trim().toUpperCase();
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

  return {
    sourceId: `market-coingecko-crypto-${symbol.toLowerCase()}`,
    assetClass: "crypto",
    symbol,
    ...(name !== undefined ? { name } : {}),
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

export const coinGeckoMarketDataAdapter: MarketDataAdapter = {
  name: "coingecko",
  assetClass: "crypto",
  normalizeMarkets: normalizeCoinGeckoMarketsPayload,
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
