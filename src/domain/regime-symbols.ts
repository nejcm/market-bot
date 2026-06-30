// Ticker Regime Context combines broad equity breadth proxies with volatility gauges.
export const EQUITY_BREADTH_PROXY_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA"] as const;
export const EQUITY_VOLATILITY_SYMBOLS = ["^VIX", "^VIX3M"] as const;
export const EQUITY_REGIME_SYMBOLS = [
  ...EQUITY_BREADTH_PROXY_SYMBOLS,
  ...EQUITY_VOLATILITY_SYMBOLS,
] as const;

const equityBreadthProxySymbolSet = new Set<string>(EQUITY_BREADTH_PROXY_SYMBOLS);
const equityVolatilitySymbolSet = new Set<string>(EQUITY_VOLATILITY_SYMBOLS);
const equityRegimeSymbolSet = new Set<string>(EQUITY_REGIME_SYMBOLS);

export function isEquityBreadthProxySymbol(symbol: string): boolean {
  return equityBreadthProxySymbolSet.has(symbol);
}

export function isEquityVolatilitySymbol(symbol: string): boolean {
  return equityVolatilitySymbolSet.has(symbol);
}

export function isEquityRegimeSymbol(symbol: string): boolean {
  return equityRegimeSymbolSet.has(symbol);
}
