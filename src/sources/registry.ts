import type { AssetClass } from "../domain/types";
import { coinGeckoMarketDataAdapter } from "./coingecko";
import { cryptoExtendedEvidenceAdapter, equityExtendedEvidenceAdapter } from "./extended-evidence";
import { multiNewsAdapter } from "./multi-news";
import type {
  ExtendedEvidenceAdapter,
  MarketDataAdapter,
  NewsAdapter,
  SourceRegistry,
} from "./types";
import { yahooMarketDataAdapter } from "./yahoo";

export function createSourceRegistry(): SourceRegistry {
  const marketAdapters: Record<AssetClass, MarketDataAdapter> = {
    equity: yahooMarketDataAdapter,
    crypto: coinGeckoMarketDataAdapter,
  };

  const newsAdapters: Record<AssetClass, NewsAdapter> = {
    equity: multiNewsAdapter,
    crypto: multiNewsAdapter,
  };
  const extendedEvidenceAdapters: Record<AssetClass, ExtendedEvidenceAdapter> = {
    equity: equityExtendedEvidenceAdapter,
    crypto: cryptoExtendedEvidenceAdapter,
  };

  return {
    marketDataFor: (assetClass) => marketAdapters[assetClass],
    newsFor: (assetClass) => newsAdapters[assetClass],
    extendedEvidenceFor: (assetClass) => extendedEvidenceAdapters[assetClass],
  };
}
