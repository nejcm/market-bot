import type { MarketSnapshot, VerifiedMarketSnapshot } from "./domain/types";
import { isRecord, readNumber, readString } from "./guards";
import { isAssetClass } from "./run-artifact-value-guards";

export function readSnapshots(value: unknown): readonly MarketSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly MarketSnapshot[] => {
    if (
      !isRecord(item) ||
      typeof item.sourceId !== "string" ||
      !isAssetClass(item.assetClass) ||
      typeof item.symbol !== "string" ||
      typeof item.price !== "number" ||
      typeof item.changePercent24h !== "number" ||
      typeof item.volume !== "number" ||
      typeof item.observedAt !== "string"
    ) {
      return [];
    }
    return [item as unknown as MarketSnapshot];
  });
}

function readOhlcvBar(value: unknown): VerifiedMarketSnapshot["ohlcv"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  const open = readNumber(value, "open");
  const high = readNumber(value, "high");
  const low = readNumber(value, "low");
  const close = readNumber(value, "close");
  const volume = readNumber(value, "volume");
  return typeof value.date === "string" &&
    open !== undefined &&
    high !== undefined &&
    low !== undefined &&
    close !== undefined &&
    volume !== undefined
    ? { date: value.date, open, high, low, close, volume }
    : undefined;
}

function readNullableIndicator(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIndicators(value: unknown): VerifiedMarketSnapshot["indicators"] | undefined {
  if (!isRecord(value)) {
    return;
  }
  return {
    ema10: readNullableIndicator(value, "ema10"),
    sma50: readNullableIndicator(value, "sma50"),
    sma200: readNullableIndicator(value, "sma200"),
    rsi14: readNullableIndicator(value, "rsi14"),
    macd: readNullableIndicator(value, "macd"),
    macdSignal: readNullableIndicator(value, "macdSignal"),
    macdHistogram: readNullableIndicator(value, "macdHistogram"),
    bollUpper: readNullableIndicator(value, "bollUpper"),
    bollMiddle: readNullableIndicator(value, "bollMiddle"),
    bollLower: readNullableIndicator(value, "bollLower"),
    atr14: readNullableIndicator(value, "atr14"),
  };
}

function readRecentCloses(value: unknown): VerifiedMarketSnapshot["recentCloses"] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const closes = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const close = readNumber(entry, "close");
    return typeof entry.date === "string" && close !== undefined
      ? [{ date: entry.date, close }]
      : [];
  });
  return closes.length >= 2 ? closes : undefined;
}

export function readVerifiedMarketSnapshot(value: unknown): VerifiedMarketSnapshot | undefined {
  if (!isRecord(value) || value.assetClass !== "equity" || typeof value.symbol !== "string") {
    return;
  }
  const analysisDate = readString(value, "analysisDate");
  const fetchedAt = readString(value, "fetchedAt");
  const latestSessionDate = readString(value, "latestSessionDate");
  const ohlcv = readOhlcvBar(value.ohlcv);
  const indicators = readIndicators(value.indicators);
  const recentCloses = readRecentCloses(value.recentCloses);
  return analysisDate === undefined ||
    fetchedAt === undefined ||
    latestSessionDate === undefined ||
    ohlcv === undefined ||
    indicators === undefined ||
    recentCloses === undefined
    ? undefined
    : {
        symbol: value.symbol.toUpperCase(),
        assetClass: "equity",
        analysisDate,
        fetchedAt,
        latestSessionDate,
        ohlcv,
        indicators,
        recentCloses,
      };
}

export function readVerifiedMarketSnapshots(value: unknown): readonly VerifiedMarketSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): readonly VerifiedMarketSnapshot[] => {
    const snapshot = readVerifiedMarketSnapshot(item);
    return snapshot === undefined ? [] : [snapshot];
  });
}
