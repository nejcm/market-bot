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

  if (symbol === undefined || price === undefined || changePercent24h === undefined || volume === undefined) {
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

export function normalizeCoinGeckoMarketsPayload(payload: unknown, fetchedAt: string): readonly MarketSnapshot[] {
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
