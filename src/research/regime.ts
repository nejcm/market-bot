import type { AssetClass, MarketRegimeLabel, MarketRegimeSummary, MarketSnapshot } from "../domain/types";

const EQUITY_BREADTH_PROXIES = new Set(["SPY", "QQQ", "IWM", "DIA"]);
const CRYPTO_MAJOR_PROXIES = new Set(["BTC", "ETH"]);
const VIX_SYMBOL = "^VIX";

function classifyByBreadth(positive: number, negative: number, total: number): MarketRegimeLabel {
  if (total === 0) {
    return "insufficient-data";
  }

  if (positive > negative) {
    return "risk-on";
  }

  if (negative > positive) {
    return "risk-off";
  }

  return "mixed";
}

export function summarizeMarketRegime(assetClass: AssetClass, snapshots: readonly MarketSnapshot[]): MarketRegimeSummary {
  const selected =
    assetClass === "equity"
      ? snapshots.filter((snapshot) => snapshot.assetClass === "equity" && (EQUITY_BREADTH_PROXIES.has(snapshot.symbol) || snapshot.symbol === VIX_SYMBOL))
      : snapshots.filter((snapshot) => snapshot.assetClass === "crypto" && CRYPTO_MAJOR_PROXIES.has(snapshot.symbol));
  const breadth = selected.filter((snapshot) => snapshot.symbol !== VIX_SYMBOL);
  const positive = breadth.filter((snapshot) => snapshot.changePercent24h > 0).length;
  const negative = breadth.filter((snapshot) => snapshot.changePercent24h < 0).length;
  const vix = selected.find((snapshot) => snapshot.symbol === VIX_SYMBOL);
  const breadthLabel = classifyByBreadth(positive, negative, breadth.length);
  const label = assetClass === "equity" && vix !== undefined && vix.price >= 25 ? "risk-off" : breadthLabel;
  const drivers =
    assetClass === "equity"
      ? [`equity breadth proxies ${negative > positive ? "negative" : positive > negative ? "positive" : "mixed"}: ${negative > positive ? negative : positive}/${breadth.length}`]
      : [`major crypto proxies ${negative > positive ? "negative" : positive > negative ? "positive" : "mixed"}: ${negative > positive ? negative : positive}/${breadth.length}`];

  return {
    assetClass,
    label,
    proxyCount: selected.length,
    drivers: vix !== undefined && vix.price >= 25 ? [...drivers, `VIX elevated at ${vix.price}`] : drivers,
    sourceIds: selected.map((snapshot) => snapshot.sourceId),
  };
}
