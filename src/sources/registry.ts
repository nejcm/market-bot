import type { AssetClass } from "../domain/types";
import { coinGeckoMarketDataAdapter } from "./coingecko";
import { multiNewsAdapter } from "./multi-news";
import type { MarketDataAdapter, NewsAdapter, SourceRegistry } from "./types";
import { yahooMarketDataAdapter } from "./yahoo";
import { emptyExtendedEvidenceAdapter } from "./extended-evidence";

export function createSourceRegistry(): SourceRegistry {
  const marketAdapters: Record<AssetClass, MarketDataAdapter> = {
    equity: yahooMarketDataAdapter,
    crypto: coinGeckoMarketDataAdapter,
  };

  const newsAdapters: Record<AssetClass, NewsAdapter> = {
    equity: multiNewsAdapter,
    crypto: multiNewsAdapter,
  };

  return {
    marketDataFor: (assetClass) => marketAdapters[assetClass],
    newsFor: (assetClass) => newsAdapters[assetClass],
    extendedEvidenceFor: () => emptyExtendedEvidenceAdapter,
  };
}
