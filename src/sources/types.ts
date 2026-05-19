import type { ResearchCommand } from "../cli/args";
import type { AssetClass, MarketSnapshot, Source } from "../domain/types";

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
}

export interface NewsAdapter {
  readonly name: string;
  readonly buildUrl: (command: ResearchCommand, limit: number) => string;
  readonly normalizeNews: (
    payload: unknown,
    assetClass: AssetClass,
    fetchedAt: string,
  ) => readonly Source[];
}

export interface FetchJsonResult {
  readonly rawSnapshot: RawSourceSnapshot;
  readonly payload: unknown;
}

export interface SourceRegistry {
  readonly marketDataFor: (assetClass: AssetClass) => MarketDataAdapter;
  readonly newsFor: (assetClass: AssetClass) => NewsAdapter;
}
