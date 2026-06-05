import type {
  AssetClass,
  MarketContext,
  MarketRegimeLabel,
  MarketRegimeSummary,
  MarketSnapshot,
} from "../domain/types";
import { isEquityBreadthProxySymbol, isEquityVolatilitySymbol } from "../domain/regime-symbols";
import { isFredBaseMetricKey } from "../sources/fred";

const CRYPTO_MAJOR_PROXIES = new Set(["BTC", "ETH"]);
const VIX_SYMBOL = "^VIX";
const VIX_TERM_SYMBOL = "^VIX3M";
const VIX_ELEVATED_THRESHOLD = 25;

// One regime driver's directional read; `undefined` means missing inputs, so it casts no vote.
type RegimeVote = "risk-on" | "risk-off" | "neutral";

interface RegimeSignal {
  readonly vote: RegimeVote | undefined;
  readonly driver?: string;
}

function isEquityRegimeSnapshot(snapshot: MarketSnapshot): boolean {
  return (
    (snapshot.assetClass === "equity" && isEquityBreadthProxySymbol(snapshot.symbol)) ||
    isEquityVolatilitySymbol(snapshot.symbol)
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

  let direction = "mixed";
  if (negative > positive) {
    direction = "negative";
  } else if (positive > negative) {
    direction = "positive";
  }
  const directionalCount = negative > positive ? negative : positive;

  return `${prefix} ${direction}: ${directionalCount}/${total}`;
}

function breadthSignal(
  assetClass: AssetClass,
  positive: number,
  negative: number,
  total: number,
): RegimeSignal {
  const driver = buildBreadthDriver(assetClass, positive, negative, total);
  if (total === 0) {
    return { vote: undefined, driver };
  }
  if (positive > negative) {
    return { vote: "risk-on", driver };
  }
  if (negative > positive) {
    return { vote: "risk-off", driver };
  }
  return { vote: "neutral", driver };
}

// Trend driver: each proxy's price vs its own 50-day average.
// Net above is risk-on, net below is risk-off; proxies without an average are excluded.
function trendSignal(breadth: readonly MarketSnapshot[]): RegimeSignal {
  const directions = breadth.flatMap((snapshot) => {
    const average = snapshot.fiftyDayAverage;
    if (average === undefined) {
      return [];
    }
    if (snapshot.price > average) {
      return ["above" as const];
    }
    if (snapshot.price < average) {
      return ["below" as const];
    }
    return ["flat" as const];
  });
  if (directions.length === 0) {
    return { vote: undefined };
  }
  const above = directions.filter((direction) => direction === "above").length;
  const below = directions.filter((direction) => direction === "below").length;
  const total = directions.length;
  if (above > below) {
    return {
      vote: "risk-on",
      driver: `trend positive: ${above}/${total} proxies above 50-day average`,
    };
  }
  if (below > above) {
    return {
      vote: "risk-off",
      driver: `trend negative: ${below}/${total} proxies below 50-day average`,
    };
  }
  return { vote: "neutral", driver: `trend mixed: ${above}/${total} proxies above 50-day average` };
}

// Term structure: front-month VIX above 3-month VIX (backwardation) is a risk-off stress signal.
// Normal contango carries no directional vote and must not nudge the regime toward risk-on.
function termStructureSignal(
  vix: MarketSnapshot | undefined,
  vix3m: MarketSnapshot | undefined,
): RegimeSignal {
  if (vix === undefined || vix3m === undefined) {
    return { vote: undefined };
  }
  const front = vix.price.toFixed(2);
  const back = vix3m.price.toFixed(2);
  if (vix.price > vix3m.price) {
    return {
      vote: "risk-off",
      driver: `VIX term structure backwardation: VIX ${front} vs VIX3M ${back}`,
    };
  }
  return {
    vote: "neutral",
    driver: `VIX term structure contango: VIX ${front} vs VIX3M ${back}`,
  };
}

function resolveLabel(signals: readonly RegimeSignal[], isVixElevated: boolean): MarketRegimeLabel {
  if (isVixElevated) {
    return "risk-off";
  }
  const votes = signals.flatMap((signal) => (signal.vote === undefined ? [] : [signal.vote]));
  if (votes.length === 0) {
    return "insufficient-data";
  }
  const riskOn = votes.filter((vote) => vote === "risk-on").length;
  const riskOff = votes.filter((vote) => vote === "risk-off").length;
  if (riskOn > riskOff) {
    return "risk-on";
  }
  if (riskOff > riskOn) {
    return "risk-off";
  }
  return "mixed";
}

export function summarizeMarketRegime(
  assetClass: AssetClass,
  snapshots: readonly MarketSnapshot[],
): MarketRegimeSummary {
  const selected =
    assetClass === "equity"
      ? snapshots.filter((snapshot) => isEquityRegimeSnapshot(snapshot))
      : snapshots.filter((snapshot) => isCryptoRegimeSnapshot(snapshot));
  const breadth = selected.filter((snapshot) => !isEquityVolatilitySymbol(snapshot.symbol));
  const positive = breadth.filter((snapshot) => snapshot.changePercent24h > 0).length;
  const negative = breadth.filter((snapshot) => snapshot.changePercent24h < 0).length;
  const vix = selected.find((snapshot) => snapshot.symbol === VIX_SYMBOL);
  const vix3m = selected.find((snapshot) => snapshot.symbol === VIX_TERM_SYMBOL);

  const signals: RegimeSignal[] = [breadthSignal(assetClass, positive, negative, breadth.length)];
  if (assetClass === "equity") {
    signals.push(trendSignal(breadth), termStructureSignal(vix, vix3m));
  }

  const isVixElevated =
    assetClass === "equity" && vix !== undefined && vix.price >= VIX_ELEVATED_THRESHOLD;
  const label = resolveLabel(signals, isVixElevated);
  const drivers = signals.flatMap((signal) => (signal.driver === undefined ? [] : [signal.driver]));

  return {
    assetClass,
    label,
    proxyCount: selected.length,
    drivers: isVixElevated ? [...drivers, `VIX elevated at ${vix.price}`] : drivers,
    sourceIds: selected.map((snapshot) => snapshot.sourceId),
  };
}

function marketContextDriver(context: MarketContext): string | undefined {
  const metrics = context.items.find((item) => item.category === "fred-macro")?.metrics;
  if (metrics === undefined) {
    return undefined;
  }
  const dgs10 = metrics.DGS10;
  if (typeof dgs10 === "number") {
    return `FRED macro context: DGS10 ${String(dgs10)}`;
  }
  const metric = Object.entries(metrics).find(
    ([key, value]) => typeof value === "number" && isFredBaseMetricKey(key),
  );
  return metric === undefined ? undefined : `FRED macro context: ${metric[0]} ${String(metric[1])}`;
}

export function addMarketContextToRegime(
  regime: MarketRegimeSummary,
  context: MarketContext | undefined,
): MarketRegimeSummary {
  if (context === undefined || context.items.length === 0) {
    return regime;
  }
  const driver = marketContextDriver(context);
  const sourceIds = context.items.flatMap((item) => item.sourceIds);
  return {
    ...regime,
    drivers: driver === undefined ? regime.drivers : [...regime.drivers, driver],
    sourceIds: [...new Set([...regime.sourceIds, ...sourceIds])],
  };
}
