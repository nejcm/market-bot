import type { AssetClass } from "../domain/types";
import { coinGeckoMarketDataAdapter } from "./coingecko";
import { cryptoExtendedEvidenceAdapter, equityExtendedEvidenceAdapter } from "./extended-evidence";
import { marketContextAdapter } from "./market-context";
import { multiNewsAdapter } from "./multi-news";
import type {
  ExtendedEvidenceAdapter,
  MarketContextAdapter,
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
  const marketContextAdapters: Record<AssetClass, MarketContextAdapter> = {
    equity: marketContextAdapter,
    crypto: marketContextAdapter,
  };

  return {
    marketDataFor: (assetClass) => marketAdapters[assetClass],
    newsFor: (assetClass) => newsAdapters[assetClass],
    extendedEvidenceFor: (assetClass) => extendedEvidenceAdapters[assetClass],
    marketContextFor: (assetClass) => marketContextAdapters[assetClass],
  };
}
