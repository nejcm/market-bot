import type { AssetClass } from "../domain/types";
import { createMultiNewsAdapter } from "./multi-news";
import { sourceProviders } from "./providers";
import type {
  ExtendedEvidenceAdapter,
  MarketContextAdapter,
  MarketDataAdapter,
  NewsAdapter,
  SourceRegistry,
  SupplementalMarketDataAdapter,
} from "./types";

const NEWS_PROVIDER_ORDER: readonly string[] = ["marketaux", "finnhub", "yahoo-news", "massive"];

function firstCapability<T>(
  assetClass: AssetClass,
  read: (provider: (typeof sourceProviders)[number]) => T | undefined,
): T {
  const capability = sourceProviders
    .map((provider) => read(provider))
    .find((item): item is T => item !== undefined);
  if (capability === undefined) {
    throw new Error(`No source provider capability for ${assetClass}`);
  }
  return capability;
}

function allCapabilities<T>(
  read: (provider: (typeof sourceProviders)[number]) => T | undefined,
): readonly T[] {
  return sourceProviders
    .map((provider) => read(provider))
    .filter((item): item is T => item !== undefined);
}

export function createSourceRegistry(): SourceRegistry {
  const marketAdapters: Record<AssetClass, MarketDataAdapter> = {
    equity: firstCapability("equity", (provider) => provider.marketData?.equity),
    crypto: firstCapability("crypto", (provider) => provider.marketData?.crypto),
  };

  const newsAdapters: Record<AssetClass, NewsAdapter> = {
    equity: createMultiNewsAdapter(
      allCapabilities((provider) => provider.news?.equity),
      NEWS_PROVIDER_ORDER,
    ),
    crypto: createMultiNewsAdapter(
      allCapabilities((provider) => provider.news?.crypto),
      NEWS_PROVIDER_ORDER,
    ),
  };
  const extendedEvidenceAdapters: Record<AssetClass, ExtendedEvidenceAdapter> = {
    equity: firstCapability("equity", (provider) => provider.extendedEvidence?.equity),
    crypto: firstCapability("crypto", (provider) => provider.extendedEvidence?.crypto),
  };
  const marketContextAdapters: Record<AssetClass, MarketContextAdapter> = {
    equity: firstCapability("equity", (provider) => provider.marketContext?.equity),
    crypto: firstCapability("crypto", (provider) => provider.marketContext?.crypto),
  };
  const supplementalMarketAdapters: Record<AssetClass, readonly SupplementalMarketDataAdapter[]> = {
    equity: allCapabilities((provider) => provider.supplementalMarketData?.equity),
    crypto: allCapabilities((provider) => provider.supplementalMarketData?.crypto),
  };

  return {
    marketDataFor: (assetClass) => marketAdapters[assetClass],
    supplementalMarketDataFor: (assetClass) => supplementalMarketAdapters[assetClass],
    newsFor: (assetClass) => newsAdapters[assetClass],
    extendedEvidenceFor: (assetClass) => extendedEvidenceAdapters[assetClass],
    marketContextFor: (assetClass) => marketContextAdapters[assetClass],
  };
}
