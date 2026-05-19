import type {
  AssetClass,
  MarketRegimeLabel,
  MarketRegimeSummary,
  MarketSnapshot,
} from "../domain/types";

const EQUITY_BREADTH_PROXIES = new Set(["SPY", "QQQ", "IWM", "DIA"]);
const CRYPTO_MAJOR_PROXIES = new Set(["BTC", "ETH"]);
const VIX_SYMBOL = "^VIX";
const VIX_ELEVATED_THRESHOLD = 25;

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

function isEquityRegimeSnapshot(snapshot: MarketSnapshot): boolean {
  return (
    (snapshot.assetClass === "equity" && EQUITY_BREADTH_PROXIES.has(snapshot.symbol)) ||
    snapshot.symbol === VIX_SYMBOL
  );
}

function isCryptoRegimeSnapshot(snapshot: MarketSnapshot): boolean {
  return snapshot.assetClass === "crypto" && CRYPTO_MAJOR_PROXIES.has(snapshot.symbol);
}

function buildBreadthDriver(
  assetClass: AssetClass,
  positive: number,
  negative: number,
  total: number,
): string {
  const prefix = assetClass === "equity" ? "equity breadth proxies" : "major crypto proxies";

  if (total === 0) {
    return `${prefix} unavailable`;
  }

  const direction = negative > positive ? "negative" : (positive > negative ? "positive" : "mixed");
  const directionalCount = negative > positive ? negative : positive;

  return `${prefix} ${direction}: ${directionalCount}/${total}`;
}

export function summarizeMarketRegime(
  assetClass: AssetClass,
  snapshots: readonly MarketSnapshot[],
): MarketRegimeSummary {
  const selected =
    assetClass === "equity"
      ? snapshots.filter(isEquityRegimeSnapshot)
      : snapshots.filter(isCryptoRegimeSnapshot);
  const breadth = selected.filter((snapshot) => snapshot.symbol !== VIX_SYMBOL);
  const positive = breadth.filter((snapshot) => snapshot.changePercent24h > 0).length;
  const negative = breadth.filter((snapshot) => snapshot.changePercent24h < 0).length;
  const vix = selected.find((snapshot) => snapshot.symbol === VIX_SYMBOL);
  const breadthLabel = classifyByBreadth(positive, negative, breadth.length);
  const isVixElevated =
    assetClass === "equity" && vix !== undefined && vix.price >= VIX_ELEVATED_THRESHOLD;
  const label = isVixElevated ? "risk-off" : breadthLabel;
  const drivers = [buildBreadthDriver(assetClass, positive, negative, breadth.length)];

  return {
    assetClass,
    label,
    proxyCount: selected.length,
    drivers: isVixElevated ? [...drivers, `VIX elevated at ${vix.price}`] : drivers,
    sourceIds: selected.map((snapshot) => snapshot.sourceId),
  };
}
