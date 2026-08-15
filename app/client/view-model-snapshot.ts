import { RUN_ARTIFACT_FILES } from "../../src/run-artifact-layout";
import { readFiniteNumber } from "./view-model-format";

export const VERIFIED_SNAPSHOT_PATH = RUN_ARTIFACT_FILES.verifiedMarketSnapshot;

export interface SnapshotClose {
  readonly date: string;
  readonly close: number;
}

interface SnapshotOhlcv {
  readonly date: string;
  readonly close: number;
}

export interface SnapshotView {
  readonly symbol: string;
  readonly analysisDate?: string;
  readonly latestSessionDate?: string;
  readonly ohlcv?: SnapshotOhlcv;
  readonly indicators: Readonly<Record<string, number>>;
  readonly recentCloses: readonly SnapshotClose[];
}

export interface CloseLinePoint {
  readonly x: number;
  readonly y: number;
  readonly date: string;
  readonly close: number;
}

export function verifiedSnapshotView(content: string): SnapshotView | undefined {
  return verifiedSnapshotValue(parseJson(content));
}

export function verifiedSnapshotValue(value: unknown): SnapshotView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const symbol = typeof record.symbol === "string" ? record.symbol : undefined;
  const recentCloses = snapshotCloses(record.recentCloses);
  if (symbol === undefined || recentCloses.length < 2) {
    return undefined;
  }

  const analysisDate = typeof record.analysisDate === "string" ? record.analysisDate : undefined;
  const latestSessionDate =
    typeof record.latestSessionDate === "string" ? record.latestSessionDate : undefined;
  const ohlcv = snapshotOhlcv(record.ohlcv);
  return {
    symbol,
    ...(analysisDate !== undefined ? { analysisDate } : {}),
    ...(latestSessionDate !== undefined ? { latestSessionDate } : {}),
    ...(ohlcv !== undefined ? { ohlcv } : {}),
    indicators: snapshotIndicators(record.indicators),
    recentCloses,
  };
}

export function tradingViewSymbol(symbol: string, exchange?: string): string {
  const cleanSymbol = symbol.trim().toUpperCase();
  const cleanExchange = exchange?.trim().toUpperCase();
  return cleanExchange === undefined || cleanExchange === ""
    ? cleanSymbol
    : `${cleanExchange}:${cleanSymbol}`;
}

export function tradingViewUrl(symbol: string, exchange?: string): string {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
    tradingViewSymbol(symbol, exchange),
  )}`;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function snapshotCloses(value: unknown): readonly SnapshotClose[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const close = readFiniteNumber(record.close);
    return typeof record.date === "string" && close !== undefined
      ? [{ date: record.date, close }]
      : [];
  });
}

function snapshotOhlcv(value: unknown): SnapshotOhlcv | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const close = readFiniteNumber(record.close);
  return typeof record.date === "string" && close !== undefined
    ? { date: record.date, close }
    : undefined;
}

function snapshotIndicators(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const indicator = readFiniteNumber(entry);
      return indicator === undefined ? [] : [[key, indicator] as const];
    }),
  );
}

export function closeLinePoints(
  closes: readonly SnapshotClose[],
  plotLeft: number,
  plotWidth: number,
  plotTop: number,
  plotHeight: number,
): readonly CloseLinePoint[] {
  if (closes.length === 0) {
    return [];
  }

  const values = closes.map((entry) => entry.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return closes.map((entry, index) => ({
    x: plotLeft + (closes.length === 1 ? 0 : (index * plotWidth) / (closes.length - 1)),
    y:
      range === 0 ? plotTop + plotHeight / 2 : plotTop + ((max - entry.close) / range) * plotHeight,
    date: entry.date,
    close: entry.close,
  }));
}

export function horizonMarkers(
  forecasts: readonly { readonly horizonTradingDays?: number }[],
): readonly number[] {
  return [
    ...new Set(
      forecasts
        .map((forecast) => forecast.horizonTradingDays)
        .filter((horizon): horizon is number => horizon !== undefined && horizon > 0),
    ),
  ].toSorted((left, right) => left - right);
}

export function formatClose(value: number): string {
  return Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(4);
}
