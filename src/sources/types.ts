import type { ResearchCommand } from "../cli/args";
import type {
  AssetClass,
  ExtendedEvidence,
  MarketContext,
  MarketSnapshot,
  Source,
  SourceGap,
} from "../domain/types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchOrGapFn = (
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  retryDelaysMs?: readonly number[],
  init?: RequestInit,
) => Promise<FetchJsonResult | SourceGap>;

export type FetchTextOrGapFn = (
  url: string,
  adapter: string,
  fetchedAt: string,
  timeoutMs: number,
  fetchImpl: FetchLike,
  retryDelaysMs?: readonly number[],
  init?: RequestInit,
) => Promise<FetchTextResult | SourceGap>;

export interface CollectContext {
  readonly command: ResearchCommand;
  readonly fetchedAt: string;
  readonly sourceTimeoutMs: number;
  readonly newsLimit: number;
  readonly cryptoMoverLimit: number;
  readonly marketauxApiToken?: string;
  readonly finnhubApiToken?: string;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly glassnodeApiKey?: string;
  readonly massiveApiKey?: string;
  readonly secUserAgent?: string;
  readonly newsSeenPath?: string;
  readonly newsSeenRetentionDays?: number;
  readonly fetchImpl: FetchLike;
  readonly fetchOrGap: FetchOrGapFn;
  readonly fetchTextOrGap: FetchTextOrGapFn;
  readonly retryDelaysMs: readonly number[];
}

export interface MarketCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface SupplementalMarketCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly supplementalMarketSnapshots: readonly MarketSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface NewsCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly newsSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
  readonly newsAnalytics?: NewsCollectionAnalytics;
}

export interface NewsCollectionAnalytics {
  readonly fetchedNewsSourcesByProvider: Readonly<Record<string, number>>;
  readonly fetchedNewsSourceCount: number;
  readonly canonicalDedupedNewsSourceCount: number;
  readonly canonicalDuplicateNewsSourceCount: number;
  readonly persistentSuppressedNewsSourceCount: number;
  readonly repeatFallbackKeptCount: number;
  readonly selectedNewsSourceCount: number;
  readonly repeatFallbackUsed: boolean;
}

export interface ExtendedEvidenceCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly extendedEvidence?: ExtendedEvidence;
  readonly sources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface MarketContextCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketContext?: MarketContext;
  readonly sources: readonly Source[];
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

export interface SupplementalMarketDataAdapter {
  readonly name: string;
  readonly assetClass: AssetClass;
  readonly normalizeMarkets: (payload: unknown, fetchedAt: string) => readonly MarketSnapshot[];
  readonly collect: (
    ctx: CollectContext,
    primarySnapshots: readonly MarketSnapshot[],
  ) => Promise<SupplementalMarketCollectionResult>;
}

export interface NewsAdapter {
  readonly name: string;
  readonly provider: string;
  readonly normalizeNews: (
    payload: unknown,
    assetClass: AssetClass,
    fetchedAt: string,
  ) => readonly Source[];
  readonly collect: (ctx: CollectContext) => Promise<NewsCollectionResult>;
}

export interface ExtendedEvidenceAdapter {
  readonly name: string;
  readonly collect: (ctx: CollectContext) => Promise<ExtendedEvidenceCollectionResult>;
}

export interface MarketContextAdapter {
  readonly name: string;
  readonly collect: (ctx: CollectContext) => Promise<MarketContextCollectionResult>;
}

export interface ObservationProviderAdapter {
  readonly name: string;
}

export interface SourceProviderModule {
  readonly name: string;
  readonly marketData?: Partial<Record<AssetClass, MarketDataAdapter>>;
  readonly supplementalMarketData?: Partial<Record<AssetClass, SupplementalMarketDataAdapter>>;
  readonly news?: Partial<Record<AssetClass, NewsAdapter>>;
  readonly extendedEvidence?: Partial<Record<AssetClass, ExtendedEvidenceAdapter>>;
  readonly marketContext?: Partial<Record<AssetClass, MarketContextAdapter>>;
  readonly observations?: Partial<Record<AssetClass, ObservationProviderAdapter>>;
}

export interface FetchSourceResult<TPayload = unknown> {
  readonly rawSnapshot: RawSourceSnapshot;
  readonly payload: TPayload;
}

export type FetchJsonResult = FetchSourceResult<unknown>;

export type FetchTextResult = FetchSourceResult<string>;

export function isFetchJsonResult(value: FetchJsonResult | SourceGap): value is FetchJsonResult {
  return "rawSnapshot" in value;
}

export interface SourceRegistry {
  readonly marketDataFor: (assetClass: AssetClass) => MarketDataAdapter;
  readonly supplementalMarketDataFor: (
    assetClass: AssetClass,
  ) => readonly SupplementalMarketDataAdapter[];
  readonly newsFor: (assetClass: AssetClass) => NewsAdapter;
  readonly extendedEvidenceFor: (assetClass: AssetClass) => ExtendedEvidenceAdapter;
  readonly marketContextFor: (assetClass: AssetClass) => MarketContextAdapter;
}
