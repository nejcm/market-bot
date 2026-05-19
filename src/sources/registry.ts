import type { AssetClass } from "../domain/types";
import { coinGeckoMarketDataAdapter } from "./coingecko";
import { yahooNewsAdapter } from "./yahoo-news";
import type { MarketDataAdapter, NewsAdapter, SourceRegistry } from "./types";
import { yahooMarketDataAdapter } from "./yahoo";

export function createSourceRegistry(): SourceRegistry {
  const marketAdapters: Record<AssetClass, MarketDataAdapter> = {
    equity: yahooMarketDataAdapter,
    crypto: coinGeckoMarketDataAdapter,
  };

  const newsAdapters: Record<AssetClass, NewsAdapter> = {
    equity: yahooNewsAdapter,
    crypto: yahooNewsAdapter,
  };

  return {
    marketDataFor: (assetClass) => marketAdapters[assetClass],
    newsFor: (assetClass) => newsAdapters[assetClass],
  };
}
