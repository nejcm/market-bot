import type { ResearchCommand } from "../cli/args";
import type { FinancialLensArtifact } from "./extended-evidence/financial-lens";
import type { BusinessFrameworkArtifact } from "./extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "./extended-evidence/web-subject-profile";
import type { ValuationCompsArtifact } from "./extended-evidence/valuation-comps";
import type {
  AssetClass,
  ExtendedEvidence,
  InstrumentIdentity,
  MarketContext,
  MarketSnapshot,
  Source,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../domain/types";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SourceRequest {
  readonly url: string;
  readonly adapter: string;
  readonly init?: RequestInit | undefined;
  readonly fetch?: ((baseFetch: FetchLike) => FetchLike) | undefined;
}

export type FetchJsonRequestFn = (request: SourceRequest) => Promise<FetchJsonResult | SourceGap>;

export type FetchTextRequestFn = (request: SourceRequest) => Promise<FetchTextResult | SourceGap>;

export interface SourceRequestExecutor {
  readonly json: FetchJsonRequestFn;
  readonly text: FetchTextRequestFn;
}

export interface CollectContext {
  readonly command: ResearchCommand;
  readonly fetchedAt: string;
  readonly newsLimit: number;
  readonly cryptoMoverLimit: number;
  readonly newsRelevanceTargets?: readonly NewsRelevanceTarget[];
  readonly marketauxApiToken?: string;
  readonly finnhubApiToken?: string;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly glassnodeApiKey?: string;
  readonly massiveApiKey?: string;
  readonly exaApiKey?: string;
  readonly secUserAgent?: string;
  readonly newsSeenPath?: string;
  readonly newsSeenRetentionDays?: number;
  // Resolved canonical identity (exchange/quoteCurrency), when known before source collection.
  // US-only collectors use it as the primary instrument-capability signal (see isUsListing).
  readonly instrumentIdentity?: InstrumentIdentity;
  readonly request: SourceRequestExecutor;
}

export interface NewsRelevanceTarget {
  readonly symbol: string;
  readonly name?: string;
  readonly allowLowercaseSymbolMention?: boolean;
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
  readonly relevantBeforeSeenFilterCount: number;
  readonly relevantSuppressedBySeenFilterCount: number;
  readonly relevantSelectedCount: number;
  readonly repeatFallbackKeptCount: number;
  readonly relevantRepeatKeptCount?: number;
  readonly selectedNewsSourceCount: number;
  readonly selectedRelevantTickerNewsSourceCount?: number;
  readonly selectedGenericTickerNewsSourceCount?: number;
  readonly selectedRelevantMoverNewsSourceCount?: number;
  readonly selectedGenericMoverNewsSourceCount?: number;
  readonly repeatFallbackUsed: boolean;
}

export interface EarningsSetupCollected {
  readonly event: {
    readonly symbol: string;
    readonly date: string;
    readonly timing: "bmo" | "amc" | "unknown";
    readonly epsEstimate?: number;
    readonly revenueEstimate?: number;
    readonly sourceIds: readonly string[];
    readonly fetchedAt: string;
  };
  readonly impliedMove?: {
    readonly expiration: string;
    readonly strike: number;
    readonly spot: number;
    readonly straddleMidpoint: number;
    readonly impliedMovePct: number;
    readonly sourceIds: readonly string[];
    readonly observedAt: string;
  };
  readonly gaps: readonly string[];
}

export interface CollectedSources {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly supplementalMarketSnapshots: readonly MarketSnapshot[];
  readonly newsSources: readonly Source[];
  readonly extendedSources: readonly Source[];
  readonly extendedEvidence?: ExtendedEvidence;
  readonly marketContext?: MarketContext;
  readonly marketContextSources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
  readonly newsAnalytics?: NewsCollectionAnalytics;
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly resolvedInstrumentIdentity?: InstrumentIdentity;
  readonly earningsSetup?: EarningsSetupCollected;
  readonly valuationComps?: ValuationCompsArtifact;
  readonly financialLenses?: FinancialLensArtifact;
  readonly businessFramework?: BusinessFrameworkArtifact;
  readonly webSubjectProfile?: WebSubjectProfileArtifact;
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
  readonly payloadCompacted?: boolean;
  readonly payloadBytes?: number;
  readonly payloadSha256?: string;
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

export function isFetchTextResult(value: FetchTextResult | SourceGap): value is FetchTextResult {
  return "rawSnapshot" in value;
}

export function latestRawSnapshotFetchedAt(
  snapshots: readonly RawSourceSnapshot[],
  fallback: string,
): string {
  return (
    snapshots
      .map((snapshot) => snapshot.fetchedAt)
      .toSorted()
      .at(-1) ?? fallback
  );
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
