type FreshnessBudget = "live" | "news" | "reference";

export const ADAPTER_FRESHNESS = {
  apewisdom: "news",
  "exa-search": "news",
  "finnhub-news": "news",
  "marketaux-news": "news",
  "marketaux-news-thematic": "news",
  "massive-news": "news",
  "yahoo-news": "news",
  "yahoo-news-thematic": "news",

  "cboe-listed": "reference",
  "exa-contents": "reference",
  "finnhub-events-1": "reference",
  "finnhub-events-2": "reference",
  "finnhub-events-3": "reference",
  "fred-CPIAUCSL": "reference",
  "fred-DGS10": "reference",
  "fred-DGS2": "reference",
  "fred-DTWEXBGS": "reference",
  "fred-FEDFUNDS": "reference",
  "fred-T10Y2Y": "reference",
  "fred-UNRATE": "reference",
  "glassnode-1": "reference",
  "glassnode-2": "reference",
  "glassnode-3": "reference",
  "glassnode-4": "reference",
  "glassnode-5": "reference",
  "nasdaq-listed": "reference",
  "nasdaq-other-listed": "reference",
  "sec-alpha-fundamentals-companyfacts": "reference",
  "sec-alpha-fundamentals-tickers": "reference",
  "sec-alpha-search-tickers": "reference",
  "sec-calculation-linkbase": "reference",
  "sec-companyfacts": "reference",
  "sec-earnings-release-exhibit": "reference",
  "sec-filing-index": "reference",
  "sec-filing-text": "reference",
  "sec-metalinks": "reference",
  "sec-submissions": "reference",
  "sec-tickers": "reference",
  "sec-untagged-financial-exhibit": "reference",
  "sec-xbrl-instance": "reference",
  "sec-xbrl-schema": "reference",
  "tradier-earnings-expirations": "reference",
  "tradier-expirations": "reference",

  coingecko: "live",
  "finnhub-analyst-range": "live",
  "finnhub-ebitda-estimate": "live",
  "finnhub-eps-estimate": "live",
  "finnhub-feasibility": "live",
  "finnhub-insider-transactions": "live",
  "finnhub-institutional-ownership": "live",
  "finnhub-revenue-estimate": "live",
  "firecrawl-scrape": "live",
  "firecrawl-search": "live",
  "massive-supplemental-market": "live",
  "tradier-earnings-chain": "live",
  "tradier-options": "live",
  "yahoo-actives": "live",
  "yahoo-alpha-search": "live",
  "yahoo-benchmarks": "live",
  "yahoo-gainers": "live",
  "yahoo-losers": "live",
  "yahoo-price-history": "live",
  "yahoo-regime": "live",
  "yahoo-research-proxy": "live",
  "yahoo-research-snapshots": "live",
  "yahoo-symbol-search": "live",
  "yahoo-ticker": "live",
  "yahoo-valuation-peers": "live",
  "yahoo-verified-chart": "live",
} as const satisfies Record<string, FreshnessBudget>;

type KnownSourceAdapter = keyof typeof ADAPTER_FRESHNESS;

const SEC_CURRENT_FEED_ADAPTER_PREFIX = "sec-alpha-search-current-";

export type SourceAdapter =
  | KnownSourceAdapter
  | `${typeof SEC_CURRENT_FEED_ADAPTER_PREFIX}${string}`;

export function adapterFreshnessBudget(adapter: string): FreshnessBudget {
  if (Object.hasOwn(ADAPTER_FRESHNESS, adapter)) {
    return ADAPTER_FRESHNESS[adapter as KnownSourceAdapter];
  }
  // The suffix is a form type from MARKET_BOT_ALPHA_SEARCH_SEC_FORM_TYPES, so this family stays open.
  return adapter.startsWith(SEC_CURRENT_FEED_ADAPTER_PREFIX) ? "reference" : "live";
}
