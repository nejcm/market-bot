import { coinGeckoMarketDataAdapter } from "./coingecko";
import { cryptoExtendedEvidenceAdapter, equityExtendedEvidenceAdapter } from "./extended-evidence";
import { marketContextAdapter } from "./market-context";
import { finnhubNewsAdapter } from "./finnhub-news";
import { marketAuxNewsAdapter } from "./marketaux-news";
import { massiveNewsAdapter, massiveSupplementalMarketDataAdapter } from "./massive";
import type { SourceProviderModule } from "./types";
import { yahooMarketDataAdapter } from "./yahoo";
import { yahooNewsAdapter } from "./yahoo-news";

export const sourceProviders: readonly SourceProviderModule[] = [
  {
    name: "marketaux",
    news: { equity: marketAuxNewsAdapter, crypto: marketAuxNewsAdapter },
  },
  {
    name: "finnhub",
    news: { equity: finnhubNewsAdapter, crypto: finnhubNewsAdapter },
  },
  {
    name: "yahoo",
    marketData: { equity: yahooMarketDataAdapter },
    news: { equity: yahooNewsAdapter, crypto: yahooNewsAdapter },
  },
  {
    name: "coingecko",
    marketData: { crypto: coinGeckoMarketDataAdapter },
  },
  {
    name: "massive",
    supplementalMarketData: { equity: massiveSupplementalMarketDataAdapter },
    news: { equity: massiveNewsAdapter },
  },
  {
    name: "extended-evidence",
    extendedEvidence: {
      equity: equityExtendedEvidenceAdapter,
      crypto: cryptoExtendedEvidenceAdapter,
    },
  },
  {
    name: "market-context",
    marketContext: { equity: marketContextAdapter, crypto: marketContextAdapter },
  },
];
