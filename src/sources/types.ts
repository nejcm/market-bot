import type { ResearchCommand } from "../cli/args";
import type { FinancialLensArtifact } from "./extended-evidence/financial-lens";
import type { FundamentalHistoryArtifact } from "./extended-evidence/fundamental-history";
import type { FinancialStatementsArtifact } from "./extended-evidence/financial-statements-contract";
import type { SubsequentFinancingBridgeArtifact } from "./extended-evidence/subsequent-financing";
import type { CapitalOwnershipArtifact } from "./extended-evidence/capital-ownership";
import type { UntaggedFinancialStatementsArtifact } from "./extended-evidence/untagged-financial-tables-contract";
import type { BusinessFrameworkArtifact } from "./extended-evidence/business-framework";
import type { WebSubjectProfileArtifact } from "../web-evidence/contract";
import type { ValuationCompsArtifact } from "./extended-evidence/valuation-comps";
import type { ValuationWorkbenchArtifact } from "./extended-evidence/valuation-workbench-contract";
import type { ReverseDcfArtifact } from "./extended-evidence/reverse-dcf";
import type { ResolvedResearchSubject } from "../research/research-subject-identity";
import type {
  AssetClass,
  EarningsEventDateStatus,
  ExtendedEvidence,
  InstrumentIdentity,
  MarketContext,
  MarketSnapshot,
  Source,
  SourceGap,
  VerifiedMarketSnapshot,
} from "../domain/types";
import type { ModelInputSanitizationAggregate } from "./model-input-sanitizer";
import type { EarningsDateConfirmation } from "./extended-evidence/earnings-date-confirmation";

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
  readonly requiredMarketSnapshotSymbols?: readonly string[];
  readonly newsRelevanceTargets?: readonly NewsRelevanceTarget[];
  readonly thematicNewsQuery?: ThematicNewsQuery;
  readonly marketauxApiToken?: string;
  readonly finnhubApiToken?: string;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly glassnodeApiKey?: string;
  readonly massiveApiKey?: string;
  readonly exaApiKey?: string;
  readonly firecrawlApiKey?: string;
  readonly secUserAgent?: string;
  readonly newsSeenPath?: string;
  readonly newsSeenRetentionDays?: number;
  readonly earningsEventDate?: string;
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

export interface ThematicNewsQuery {
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly terms: readonly string[];
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
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
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
    readonly eventDateStatus?: EarningsEventDateStatus;
    /** Legacy Phase 0 alias; optional on future confirmed events. */
    readonly dateStatus?: "provider-estimated";
    readonly epsEstimate?: number;
    readonly revenueEstimate?: number;
    readonly sourceIds: readonly string[];
    readonly fetchedAt: string;
    readonly dateConfirmation?: EarningsDateConfirmation;
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
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly verifiedRepresentativeSnapshots?: readonly VerifiedMarketSnapshot[];
  readonly resolvedInstrumentIdentity?: InstrumentIdentity;
  readonly resolvedSubject?: ResolvedResearchSubject;
  readonly earningsSetup?: EarningsSetupCollected;
  readonly valuationComps?: ValuationCompsArtifact;
  readonly valuationWorkbench?: ValuationWorkbenchArtifact;
  readonly reverseDcf?: ReverseDcfArtifact;
  readonly financialLenses?: FinancialLensArtifact;
  readonly fundamentalHistory?: FundamentalHistoryArtifact;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly untaggedFinancialStatements?: UntaggedFinancialStatementsArtifact;
  readonly subsequentFinancing?: SubsequentFinancingBridgeArtifact;
  readonly capitalOwnership?: CapitalOwnershipArtifact;
  readonly businessFramework?: BusinessFrameworkArtifact;
  readonly webSubjectProfile?: WebSubjectProfileArtifact;
  readonly webSubjectProfileReuse?: {
    readonly runDirName: string;
    readonly generatedAt: string;
  };
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
  readonly cacheStatus?: "current" | "stale-fallback";
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
  readonly searchThematic?: (
    ctx: CollectContext,
    query: ThematicNewsQuery,
  ) => Promise<NewsCollectionResult>;
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
