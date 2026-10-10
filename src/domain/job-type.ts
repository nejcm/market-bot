export type AssetClass = "equity" | "crypto";

export type LegacyMarketUpdateJobType = "daily" | "weekly";

export type MarketUpdateJobType = "market-overview" | LegacyMarketUpdateJobType;

export type InstrumentJobType = "equity" | "crypto";

export type JobType = MarketUpdateJobType | InstrumentJobType | "alpha-search" | "research";

export type Depth = "brief" | "deep";

export function isMarketUpdateJobType(
  jobType: JobType | undefined,
): jobType is MarketUpdateJobType {
  return jobType === "market-overview" || jobType === "daily" || jobType === "weekly";
}

// Single-instrument runs (equity / crypto): jobType always equals assetClass.
export function isInstrumentJobType(jobType: JobType | undefined): jobType is InstrumentJobType {
  return jobType === "equity" || jobType === "crypto";
}

function isLegacyMarketUpdateJobType(jobType: JobType): jobType is LegacyMarketUpdateJobType {
  return jobType === "daily" || jobType === "weekly";
}

function legacyMarketUpdateHorizon(jobType: LegacyMarketUpdateJobType): number {
  return jobType === "daily" ? 5 : 15;
}

export function marketUpdateHorizonBucket(horizonTradingDays: number): string {
  if (horizonTradingDays <= 1) {
    return "1d";
  }
  if (horizonTradingDays <= 5) {
    return "2-5d";
  }
  if (horizonTradingDays <= 10) {
    return "6-10d";
  }
  if (horizonTradingDays <= 15) {
    return "11-15d";
  }
  return "16-20d";
}

// Canonical market-update horizon resolution. Market-overview runs carry an
// Explicit horizonTradingDays; legacy daily/weekly runs map to their fixed
// Horizon. Non-market-update job types (equity/crypto/alpha-search/research) have no
// Market-update horizon. Callers with a richer fallback (e.g. an extras bucket
// Or a prediction-horizon column) should resolve that first, then delegate.
export function marketUpdateHorizonOf(source: {
  readonly jobType: JobType;
  readonly horizonTradingDays?: number | undefined;
}): number | undefined {
  if (source.jobType === "market-overview") {
    return source.horizonTradingDays;
  }
  if (isLegacyMarketUpdateJobType(source.jobType)) {
    return legacyMarketUpdateHorizon(source.jobType);
  }
  return undefined;
}

export function marketUpdateHorizonBucketOf(source: {
  readonly jobType: JobType;
  readonly horizonTradingDays?: number | undefined;
}): string | undefined {
  const horizon = marketUpdateHorizonOf(source);
  return horizon === undefined ? undefined : marketUpdateHorizonBucket(horizon);
}

export function marketUpdateMetadataOf(source: {
  readonly jobType: JobType;
  readonly horizonTradingDays?: number | undefined;
  readonly legacyAlias?: LegacyMarketUpdateJobType | undefined;
}):
  | {
      readonly marketUpdateHorizonBucket: string;
      readonly legacyMarketUpdateAlias?: LegacyMarketUpdateJobType;
      readonly marketUpdateCadence?: LegacyMarketUpdateJobType;
    }
  | undefined {
  const horizonBucket = marketUpdateHorizonBucketOf(source);
  if (horizonBucket === undefined) {
    return undefined;
  }
  if (source.jobType === "market-overview") {
    return {
      marketUpdateHorizonBucket: horizonBucket,
      ...(source.legacyAlias !== undefined ? { legacyMarketUpdateAlias: source.legacyAlias } : {}),
    };
  }
  if (isLegacyMarketUpdateJobType(source.jobType)) {
    return { marketUpdateHorizonBucket: horizonBucket, marketUpdateCadence: source.jobType };
  }
  return undefined;
}
