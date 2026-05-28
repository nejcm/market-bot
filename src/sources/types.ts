import type { ResearchCommand } from "../cli/args";
import type { AssetClass, MarketSnapshot, Source, SourceGap } from "../domain/types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchOrGapFn = (
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  retryDelaysMs?: readonly number[],
) => Promise<FetchJsonResult | SourceGap>;

export interface CollectContext {
  readonly command: ResearchCommand;
  readonly fetchedAt: string;
  readonly sourceTimeoutMs: number;
  readonly newsLimit: number;
  readonly cryptoMoverLimit: number;
  readonly fetchImpl: FetchLike;
  readonly fetchOrGap: FetchOrGapFn;
  readonly retryDelaysMs: readonly number[];
}

export interface MarketCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface NewsCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface RawSourceSnapshot {
  readonly id: string;
  readonly adapter: string;
  readonly fetchedAt: string;
  readonly payload: unknown;
}

export interface MarketDataAdapter {
  readonly name: string;
  readonly assetClass: AssetClass;
  readonly normalizeMarkets: (payload: unknown, fetchedAt: string) => readonly MarketSnapshot[];
  readonly collect: (ctx: CollectContext) => Promise<MarketCollectionResult>;
}

export interface NewsAdapter {
  readonly name: string;
  readonly buildUrl: (command: ResearchCommand, limit: number) => string;
  readonly normalizeNews: (
    payload: unknown,
    assetClass: AssetClass,
    fetchedAt: string,
  ) => readonly Source[];
  readonly collect: (ctx: CollectContext) => Promise<NewsCollectionResult>;
}

export interface FetchJsonResult {
  readonly rawSnapshot: RawSourceSnapshot;
  readonly payload: unknown;
}

export function isFetchJsonResult(value: FetchJsonResult | SourceGap): value is FetchJsonResult {
  return "rawSnapshot" in value;
}

export interface SourceRegistry {
  readonly marketDataFor: (assetClass: AssetClass) => MarketDataAdapter;
  readonly newsFor: (assetClass: AssetClass) => NewsAdapter;
}
