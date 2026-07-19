import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import {
  isMarketUpdateJobType,
  type ExtendedEvidence,
  type MarketSnapshot,
  type Source,
  type SourceGap,
  type VerifiedMarketSnapshot,
} from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type {
  CollectContext,
  CollectedSources,
  EarningsSetupCollected,
  FetchLike,
  RawSourceSnapshot,
  NewsRelevanceTarget,
  ThematicNewsQuery,
} from "./types";
import { createSourceRegistry } from "./registry";
import { DEFAULT_RETRY_DELAYS_MS } from "./retry-utils";
import { createCollectContext } from "./source-request";
import { collectVerifiedMarketSnapshot } from "./verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "./instrument-identity";
import { addFinancialLensEvidence } from "./extended-evidence/financial-lens";
import { addBusinessFrameworkEvidence } from "./extended-evidence/business-framework";
import { addValuationEvidence } from "./extended-evidence/valuation";
import { buildYahooFundamentals } from "./extended-evidence/yahoo-fundamentals";
import {
  collectValuationComps,
  valuationCompsSkippedGap,
} from "./extended-evidence/valuation-comps";
import { createPeerUniverseProposer } from "../research/peer-universe-proposal";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
} from "../research/peer-universe-cache";
import { parseNearEarningsEvent, computeImpliedMove } from "./extended-evidence/earnings-setup";
import { evidenceSource } from "./extended-evidence/common";
import type { ModelProvider } from "../model/types";
import type { PeerUniverseFallbackContext } from "../research/peer-universe";
import type { ResolvedResearchSubject } from "../research/research-subject-identity";
import { mergeModelInputSanitization } from "./model-input-sanitizer";
import {
  sanitizeInstrumentIdentityMetadata,
  sanitizeMarketSnapshotMetadata,
} from "./metadata-sanitization";

function buildImpliedMoveSource(
  command: ResearchCommand,
  impliedMove: EarningsSetupCollected["impliedMove"],
): Source | undefined {
  const sourceId = impliedMove?.sourceIds[0];
  if (impliedMove === undefined || sourceId === undefined) {
    return undefined;
  }
  const label = isInstrumentCommand(command) ? command.symbol : "earnings";
  return evidenceSource(
    sourceId,
    `${label} earnings implied move`,
    "tradier",
    command,
    impliedMove.observedAt,
  );
}

function moverLimit(command: ResearchCommand, sourceOptions: SourceOptions): number {
  return command.assetClass === "crypto"
    ? sourceOptions.cryptoMoverLimit
    : sourceOptions.equityMoverLimit;
}

function moverNewsRelevanceTargets(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  marketSnapshots: readonly MarketSnapshot[],
): readonly NewsRelevanceTarget[] {
  if (!isMarketUpdateJobType(command.jobType)) {
    return [];
  }
  return rankMovers(
    marketSnapshots.filter((snapshot) => snapshot.assetClass === command.assetClass),
    moverLimit(command, sourceOptions),
  ).map(({ snapshot }) => ({
    symbol: snapshot.symbol,
    ...(snapshot.name !== undefined ? { name: snapshot.name } : {}),
  }));
}

function tickerNewsRelevanceTargets(
  command: ResearchCommand,
  displayName: string | undefined,
): readonly NewsRelevanceTarget[] {
  if (!isInstrumentCommand(command)) {
    return [];
  }
  return [
    {
      symbol: command.symbol,
      ...(displayName !== undefined ? { name: displayName } : {}),
    },
  ];
}

// Build news relevance targets for research runs from the subject registry (Phase 2.3).
// Uses the proxy symbol + subject display name/aliases for topic-level news matching,
// Plus each non-proxy representative instrument by symbol and name.
// Exported for testing; internal callers use this directly.
export function researchNewsRelevanceTargets(
  command: ResearchCommand,
  resolvedSubject?: ResolvedResearchSubject,
): readonly NewsRelevanceTarget[] {
  if (command.jobType !== "research") {
    return [];
  }
  if (
    resolvedSubject?.representativeInstruments === undefined ||
    resolvedSubject.subjectKey === undefined
  ) {
    return [];
  }
  const targets: NewsRelevanceTarget[] = [];

  // Proxy target: use the subject display name + aliases as the name for broad topic matching
  if (resolvedSubject.predictionProxySymbol !== undefined) {
    const topicName = [resolvedSubject.displayName, ...(resolvedSubject.aliases ?? [])]
      .filter((value): value is string => value !== undefined)
      .join(" ");
    targets.push({ symbol: resolvedSubject.predictionProxySymbol, name: topicName });
  }

  // Non-proxy representative instruments by symbol and name
  for (const instrument of resolvedSubject.representativeInstruments) {
    if (instrument.symbol === resolvedSubject.predictionProxySymbol) {
      continue;
    }
    targets.push({
      symbol: instrument.symbol,
      ...(instrument.name !== undefined ? { name: instrument.name } : {}),
    });
  }

  return targets;
}

export function researchThematicNewsQuery(
  resolvedSubject: ResolvedResearchSubject | undefined,
): ThematicNewsQuery | undefined {
  if (
    resolvedSubject?.status !== "resolved" ||
    resolvedSubject.subjectKey === undefined ||
    resolvedSubject.displayName === undefined
  ) {
    return undefined;
  }
  const terms: string[] = [];
  const normalizedTerms = new Set<string>();
  for (const value of [resolvedSubject.displayName, ...(resolvedSubject.aliases ?? [])]) {
    const term = value.trim();
    const normalized = term.toLowerCase();
    if (term === "" || normalizedTerms.has(normalized)) {
      continue;
    }
    normalizedTerms.add(normalized);
    terms.push(term);
  }
  return terms.length === 0
    ? undefined
    : {
        subjectId: resolvedSubject.subjectKey,
        subjectLabel: resolvedSubject.displayName,
        terms,
      };
}

function contextWithNewsRelevanceTargets(
  ctx: CollectContext,
  targets: readonly NewsRelevanceTarget[],
): CollectContext {
  return targets.length === 0 ? ctx : { ...ctx, newsRelevanceTargets: targets };
}

function representativeSnapshotSymbols(
  resolvedSubject: ResolvedResearchSubject | undefined,
): readonly string[] {
  if (resolvedSubject?.status !== "resolved") {
    return [];
  }
  return [
    ...new Set(
      (resolvedSubject.representativeInstruments ?? [])
        .map((instrument) => instrument.symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

interface PromotedMarketSnapshots {
  readonly marketSnapshots: readonly {
    readonly snapshot: MarketSnapshot;
    readonly adapter: string;
  }[];
  readonly promotedSnapshots: ReadonlySet<MarketSnapshot>;
}

function promoteRequiredMarketSnapshots(
  primarySnapshots: readonly MarketSnapshot[],
  primaryAdapter: string,
  supplementalResults: readonly {
    readonly adapter: string;
    readonly snapshots: readonly MarketSnapshot[];
  }[],
  requiredSymbols: readonly string[],
): PromotedMarketSnapshots {
  const marketSnapshots = primarySnapshots.map((snapshot) => ({
    snapshot,
    adapter: primaryAdapter,
  }));
  const collectedSymbols = new Set(
    primarySnapshots.map((snapshot) => snapshot.symbol.trim().toUpperCase()),
  );
  const required = new Set(requiredSymbols);
  const promotedSnapshots = new Set<MarketSnapshot>();

  for (const result of supplementalResults) {
    for (const snapshot of result.snapshots) {
      const symbol = snapshot.symbol.trim().toUpperCase();
      if (!required.has(symbol) || collectedSymbols.has(symbol)) {
        continue;
      }
      marketSnapshots.push({ snapshot, adapter: result.adapter });
      promotedSnapshots.add(snapshot);
      collectedSymbols.add(symbol);
    }
  }

  return { marketSnapshots, promotedSnapshots };
}

export interface PeerUniverseSeam {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly cachePath: string;
  readonly ttlDays?: number;
}

export interface CollectSourcesRuntimeOptions {
  readonly now?: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly peerUniverse?: PeerUniverseSeam;
  readonly resolvedSubject?: ResolvedResearchSubject;
}

function peerUniverseFallbackFor(
  peerUniverse: PeerUniverseSeam | undefined,
  ctx: CollectContext,
  now: Date,
): PeerUniverseFallbackContext | undefined {
  return peerUniverse === undefined
    ? undefined
    : {
        cacheRead: makePeerUniverseCacheReader(peerUniverse.cachePath, peerUniverse.ttlDays, now),
        cacheWrite: makePeerUniverseCacheWriter(
          peerUniverse.cachePath,
          peerUniverse.ttlDays,
          peerUniverse.provider.name,
          now,
        ),
        propose: createPeerUniverseProposer({
          provider: peerUniverse.provider,
          model: peerUniverse.model,
          request: ctx.request,
          ...(ctx.secUserAgent !== undefined ? { secUserAgent: ctx.secUserAgent } : {}),
          ...(ctx.instrumentIdentity?.displayName !== undefined
            ? { targetName: ctx.instrumentIdentity.displayName }
            : {}),
        }),
      };
}

export async function collectSources(
  command: ResearchCommand,
  sourceOptions: SourceOptions,
  runtime: CollectSourcesRuntimeOptions = {},
): Promise<CollectedSources> {
  const now = runtime.now ?? new Date();
  const requestFetchImpl = runtime.fetchImpl ?? fetch;
  const requestRetryDelaysMs = runtime.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const peerUniverseSeam = runtime.peerUniverse;
  const resolvedSubject = "resolvedSubject" in runtime ? runtime.resolvedSubject : undefined;
  const { context: ctx, staleFallbackGaps } = createCollectContext(
    command,
    sourceOptions,
    now,
    requestFetchImpl,
    requestRetryDelaysMs,
  );

  const registry = createSourceRegistry();
  const requiredMarketSnapshotSymbols = representativeSnapshotSymbols(resolvedSubject);
  const marketCtx =
    requiredMarketSnapshotSymbols.length === 0 ? ctx : { ...ctx, requiredMarketSnapshotSymbols };
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const supplementalMarketAdapters = registry.supplementalMarketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const extendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);
  const marketContextAdapter = registry.marketContextFor(command.assetClass);

  // Verified Market Snapshot: equity ticker only (ADR 0004); joins the parallel batch
  const isEquityTicker = isInstrumentCommand(command) && command.assetClass === "equity";
  const isTicker = isInstrumentCommand(command);

  // Market updates and ticker runs sequence market first so current ranked movers or resolved
  // Instrument identity can steer news selection.
  // Research runs resolve registry-based relevance targets without waiting on market data.
  // Other run types keep the parallel source collection path.
  const shouldCollectMarketBeforeNews =
    isMarketUpdateJobType(command.jobType) || isInstrumentCommand(command);
  const marketResult = shouldCollectMarketBeforeNews
    ? await marketAdapter.collect(marketCtx)
    : undefined;
  const preliminaryIdentityResult =
    isTicker && marketResult !== undefined
      ? deriveCanonicalInstrumentIdentity(marketResult.marketSnapshots, command.symbol)
      : undefined;
  // Thread resolved identity (exchange/quoteCurrency) into the source-collection context so
  // US-only collectors can gate on the primary instrument-capability signal, not just the suffix.
  const identityCtx: CollectContext =
    preliminaryIdentityResult?.identity !== undefined
      ? { ...ctx, instrumentIdentity: preliminaryIdentityResult.identity }
      : ctx;
  let newsContext: CollectContext = identityCtx;
  if (marketResult !== undefined) {
    const targets = isMarketUpdateJobType(command.jobType)
      ? moverNewsRelevanceTargets(command, sourceOptions, marketResult.marketSnapshots)
      : tickerNewsRelevanceTargets(command, preliminaryIdentityResult?.identity?.displayName);
    newsContext = contextWithNewsRelevanceTargets(identityCtx, targets);
  } else if (command.jobType === "research") {
    const thematicNewsQuery = researchThematicNewsQuery(resolvedSubject);
    newsContext = contextWithNewsRelevanceTargets(
      identityCtx,
      researchNewsRelevanceTargets(command, resolvedSubject),
    );
    if (thematicNewsQuery !== undefined) {
      newsContext = { ...newsContext, thematicNewsQuery };
    }
  }
  const [
    resolvedMarketResult,
    newsResult,
    extendedResult,
    marketContextResult,
    verifiedSnapshotResult,
    representativeVerifiedSnapshotResults,
  ] = await Promise.all([
    marketResult ?? marketAdapter.collect(marketCtx),
    newsAdapter.collect(newsContext),
    extendedEvidenceAdapter.collect(identityCtx),
    marketContextAdapter.collect(ctx),
    isEquityTicker
      ? collectVerifiedMarketSnapshot(ctx, command.symbol, ctx.fetchedAt.slice(0, 10))
      : undefined,
    command.jobType === "research" &&
    command.assetClass === "equity" &&
    command.depth === "deep" &&
    requiredMarketSnapshotSymbols.length > 0
      ? Promise.all(
          // Fetch OHLCV/indicator evidence for every representative, even when a live quote exists.
          // The verified chart snapshot is a richer citeable source.
          requiredMarketSnapshotSymbols.map(async (symbol) => ({
            symbol,
            result: await collectVerifiedMarketSnapshot(ctx, symbol, ctx.fetchedAt.slice(0, 10)),
          })),
        )
      : [],
  ]);
  const supplementalMarketResults = await Promise.all(
    supplementalMarketAdapters.map((adapter) =>
      adapter.collect(marketCtx, resolvedMarketResult.marketSnapshots),
    ),
  );
  const promotedMarket = promoteRequiredMarketSnapshots(
    resolvedMarketResult.marketSnapshots,
    marketAdapter.name,
    supplementalMarketResults.map((result, index) => ({
      adapter: supplementalMarketAdapters[index]?.name ?? "supplemental-market-data",
      snapshots: result.supplementalMarketSnapshots,
    })),
    requiredMarketSnapshotSymbols,
  );
  const sanitizedMarket = promotedMarket.marketSnapshots.map(({ snapshot, adapter }) =>
    sanitizeMarketSnapshotMetadata(snapshot, adapter),
  );
  const sanitizedSupplemental = supplementalMarketResults.flatMap((result, index) =>
    result.supplementalMarketSnapshots
      .filter((snapshot) => !promotedMarket.promotedSnapshots.has(snapshot))
      .map((snapshot) =>
        sanitizeMarketSnapshotMetadata(
          snapshot,
          supplementalMarketAdapters[index]?.name ?? "supplemental-market-data",
        ),
      ),
  );
  const verifiedRepresentativeSnapshots = representativeVerifiedSnapshotResults.flatMap((entry) =>
    entry.result.snapshot === undefined ? [] : [entry.result.snapshot],
  );
  const representativeVerifiedGaps = representativeVerifiedSnapshotResults.flatMap((entry) =>
    entry.result.snapshot !== undefined
      ? []
      : entry.result.sourceGaps.map((gap) => ({
          ...gap,
          message: `${gap.message} for research representative ${entry.symbol}`,
          evidenceQualityImpact: "no-cap" as const,
        })),
  );

  const enrichmentResult = await collectEquityEnrichment({
    command,
    marketSnapshots: resolvedMarketResult.marketSnapshots,
    extendedEvidence: extendedResult.extendedEvidence,
    extendedRawSnapshots: extendedResult.rawSnapshots,
    verifiedMarketSnapshot: verifiedSnapshotResult?.snapshot,
    fetchedAt: ctx.fetchedAt,
    context: ctx,
    identityContext: identityCtx,
    preliminaryIdentityResult,
    now,
    peerUniverse: peerUniverseSeam,
  });
  staleFallbackGaps.push(...enrichmentResult.earningsSourceGaps);
  const rawIdentity = enrichmentResult.identityResult?.identity;
  const sanitizedIdentity =
    rawIdentity === undefined
      ? undefined
      : sanitizeInstrumentIdentityMetadata(rawIdentity, "instrument-identity");
  const resolvedInstrumentIdentity = sanitizedIdentity?.identity;

  return {
    rawSnapshots: [
      ...resolvedMarketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...extendedResult.rawSnapshots,
      ...(enrichmentResult.valuationCompsResult?.rawSnapshots ?? []),
      ...marketContextResult.rawSnapshots,
      ...supplementalMarketResults.flatMap((result) => result.rawSnapshots),
      ...(verifiedSnapshotResult?.rawSnapshot !== undefined
        ? [verifiedSnapshotResult.rawSnapshot]
        : []),
      ...representativeVerifiedSnapshotResults.flatMap((entry) =>
        entry.result.rawSnapshot === undefined ? [] : [entry.result.rawSnapshot],
      ),
    ],
    marketSnapshots: sanitizedMarket.map((result) => result.snapshot),
    supplementalMarketSnapshots: sanitizedSupplemental.map((result) => result.snapshot),
    newsSources: newsResult.newsSources,
    extendedSources: [
      ...extendedResult.sources,
      ...(enrichmentResult.valuationCompsResult?.sources ?? []),
      ...enrichmentResult.earningsExtraSources,
    ],
    ...(enrichmentResult.businessFrameworkResult.extendedEvidence !== undefined
      ? { extendedEvidence: enrichmentResult.businessFrameworkResult.extendedEvidence }
      : {}),
    ...(marketContextResult.marketContext !== undefined
      ? { marketContext: marketContextResult.marketContext }
      : {}),
    marketContextSources: marketContextResult.sources,
    ...(newsResult.newsAnalytics !== undefined ? { newsAnalytics: newsResult.newsAnalytics } : {}),
    modelInputSanitization: mergeModelInputSanitization(newsResult.modelInputSanitization, {
      entries: [
        ...sanitizedMarket.flatMap((result) => result.entries),
        ...sanitizedSupplemental.flatMap((result) => result.entries),
        ...(sanitizedIdentity?.entries ?? []),
      ],
    }),
    ...(verifiedSnapshotResult?.snapshot !== undefined
      ? { verifiedMarketSnapshot: verifiedSnapshotResult.snapshot }
      : {}),
    ...(verifiedRepresentativeSnapshots.length > 0 ? { verifiedRepresentativeSnapshots } : {}),
    ...(resolvedInstrumentIdentity !== undefined ? { resolvedInstrumentIdentity } : {}),
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    ...(enrichmentResult.earningsSetup !== undefined
      ? { earningsSetup: enrichmentResult.earningsSetup }
      : {}),
    ...(enrichmentResult.valuationCompsResult?.artifact !== undefined
      ? { valuationComps: enrichmentResult.valuationCompsResult.artifact }
      : {}),
    ...(enrichmentResult.financialLensResult.artifact !== undefined
      ? { financialLenses: enrichmentResult.financialLensResult.artifact }
      : {}),
    ...(enrichmentResult.businessFrameworkResult.artifact !== undefined
      ? { businessFramework: enrichmentResult.businessFrameworkResult.artifact }
      : {}),
    sourceGaps: [
      ...resolvedMarketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...extendedResult.sourceGaps,
      ...enrichmentResult.valuationResult.sourceGaps,
      ...(enrichmentResult.valuationCompsResult?.gaps ?? []),
      ...enrichmentResult.valuationCompsSkippedGaps,
      ...enrichmentResult.financialLensResult.sourceGaps,
      ...enrichmentResult.businessFrameworkResult.sourceGaps,
      ...marketContextResult.sourceGaps,
      ...supplementalMarketResults.flatMap((result) => result.sourceGaps),
      ...(verifiedSnapshotResult?.sourceGaps ?? []),
      ...representativeVerifiedGaps,
      ...(enrichmentResult.identityResult?.gap !== undefined
        ? [enrichmentResult.identityResult.gap]
        : []),
      ...staleFallbackGaps,
    ],
  };
}

type InstrumentIdentityResult = ReturnType<typeof deriveCanonicalInstrumentIdentity>;
type ValuationResult = ReturnType<typeof addValuationEvidence>;
type ValuationCompsResult = Awaited<ReturnType<typeof collectValuationComps>>;
type FinancialLensResult = ReturnType<typeof addFinancialLensEvidence>;
type BusinessFrameworkResult = ReturnType<typeof addBusinessFrameworkEvidence>;

interface EquityEnrichmentInput {
  readonly command: ResearchCommand;
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly extendedRawSnapshots: readonly RawSourceSnapshot[];
  readonly verifiedMarketSnapshot: VerifiedMarketSnapshot | undefined;
  readonly fetchedAt: string;
  readonly context: CollectContext;
  readonly identityContext: CollectContext;
  readonly preliminaryIdentityResult: InstrumentIdentityResult | undefined;
  readonly now: Date;
  readonly peerUniverse: PeerUniverseSeam | undefined;
}

interface EquityEnrichmentResult {
  readonly identityResult: InstrumentIdentityResult | undefined;
  readonly valuationResult: ValuationResult;
  readonly valuationCompsResult: ValuationCompsResult | undefined;
  readonly valuationCompsSkippedGaps: readonly SourceGap[];
  readonly financialLensResult: FinancialLensResult;
  readonly businessFrameworkResult: BusinessFrameworkResult;
  readonly earningsSetup: EarningsSetupCollected | undefined;
  readonly earningsExtraSources: readonly Source[];
  readonly earningsSourceGaps: readonly SourceGap[];
}

async function collectEquityEnrichment(
  input: EquityEnrichmentInput,
): Promise<EquityEnrichmentResult> {
  const identityResult =
    input.preliminaryIdentityResult ??
    (isInstrumentCommand(input.command)
      ? deriveCanonicalInstrumentIdentity(input.marketSnapshots, input.command.symbol)
      : undefined);
  if (isMarketUpdateJobType(input.command.jobType)) {
    return noEquityEnrichment(identityResult, input.extendedEvidence);
  }
  if (!isInstrumentCommand(input.command) || input.command.assetClass !== "equity") {
    return noEquityEnrichment(identityResult, input.extendedEvidence);
  }

  const valuationResult = addValuationEvidence(
    input.command,
    input.marketSnapshots,
    input.extendedEvidence,
  );
  const peerUniverseFallback =
    input.command.depth === "deep"
      ? peerUniverseFallbackFor(input.peerUniverse, input.identityContext, input.now)
      : undefined;
  const valuationCompsResult =
    input.command.depth === "deep" &&
    valuationResult.extendedEvidence?.items.some((item) => item.category === "valuation") === true
      ? await collectValuationComps(
          input.identityContext,
          input.command,
          input.marketSnapshots,
          valuationResult.extendedEvidence,
          peerUniverseFallback !== undefined ? { peerUniverseFallback } : undefined,
        )
      : undefined;
  const valuationCompsSkippedGaps =
    input.command.depth === "deep" && valuationCompsResult === undefined
      ? [valuationCompsSkippedGap(input.command.symbol)]
      : [];
  const evidenceWithComps =
    valuationCompsResult?.extendedEvidence ?? valuationResult.extendedEvidence;
  const evidenceWithYahooFundamentals = addYahooFundamentals(
    input.command,
    input.marketSnapshots,
    evidenceWithComps,
    input.fetchedAt,
  );
  const financialLensResult = addFinancialLensEvidence(
    input.command,
    input.marketSnapshots,
    evidenceWithYahooFundamentals,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
  );
  const businessFrameworkResult = addBusinessFrameworkEvidence(
    input.command,
    input.marketSnapshots,
    financialLensResult.extendedEvidence,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
  );
  const earningsResult =
    input.command.depth === "deep"
      ? await collectEarningsSetup(
          input.command,
          input.marketSnapshots,
          input.extendedRawSnapshots,
          input.context,
        )
      : { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };

  return {
    identityResult,
    valuationResult,
    valuationCompsResult,
    valuationCompsSkippedGaps,
    financialLensResult,
    businessFrameworkResult,
    ...earningsResult,
  };
}

function noEquityEnrichment(
  identityResult: InstrumentIdentityResult | undefined,
  extendedEvidence: ExtendedEvidence | undefined,
): EquityEnrichmentResult {
  const valuationResult = passthroughValuationResult(extendedEvidence);
  const financialLensResult = passthroughFinancialLensResult(extendedEvidence);
  const businessFrameworkResult = passthroughBusinessFrameworkResult(extendedEvidence);
  return {
    identityResult,
    valuationResult,
    valuationCompsResult: undefined,
    valuationCompsSkippedGaps: [],
    financialLensResult,
    businessFrameworkResult,
    earningsSetup: undefined,
    earningsExtraSources: [],
    earningsSourceGaps: [],
  };
}

function passthroughValuationResult(
  extendedEvidence: ExtendedEvidence | undefined,
): ValuationResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function passthroughFinancialLensResult(
  extendedEvidence: ExtendedEvidence | undefined,
): FinancialLensResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function passthroughBusinessFrameworkResult(
  extendedEvidence: ExtendedEvidence | undefined,
): BusinessFrameworkResult {
  return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
}

function addYahooFundamentals(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
  fetchedAt: string,
): ExtendedEvidence | undefined {
  const yahooFundamentalsItem = buildYahooFundamentals(command, marketSnapshots, fetchedAt);
  if (yahooFundamentalsItem === undefined || extendedEvidence === undefined) {
    return extendedEvidence;
  }
  return {
    ...(extendedEvidence.instrument !== undefined
      ? { instrument: extendedEvidence.instrument }
      : {}),
    ...(extendedEvidence.subject !== undefined ? { subject: extendedEvidence.subject } : {}),
    items: [...extendedEvidence.items, yahooFundamentalsItem],
    gaps: extendedEvidence.gaps,
  };
}

async function collectEarningsSetup(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedRawSnapshots: readonly RawSourceSnapshot[],
  context: CollectContext,
): Promise<{
  readonly earningsSetup: EarningsSetupCollected | undefined;
  readonly earningsExtraSources: readonly Source[];
  readonly earningsSourceGaps: readonly SourceGap[];
}> {
  const earningsCalendarSnapshot = extendedRawSnapshots.find(
    (snapshot) => snapshot.adapter === "finnhub-events-1",
  );
  if (earningsCalendarSnapshot === undefined) {
    return { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };
  }
  const earningsSourceId = `extended-finnhub-events-${command.symbol.toLowerCase()}`;
  const event = parseNearEarningsEvent(
    earningsCalendarSnapshot.payload,
    command.symbol,
    earningsCalendarSnapshot.fetchedAt,
    earningsSourceId,
  );
  if (event === undefined) {
    return { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };
  }

  const tickerSnapshot = marketSnapshots.find((snapshot) => snapshot.symbol === command.symbol);
  const spot = tickerSnapshot?.price;
  if (spot === undefined || spot <= 0) {
    return {
      earningsSetup: {
        event,
        gaps: ["Spot price unavailable; implied move could not be computed"],
      },
      earningsExtraSources: [],
      earningsSourceGaps: [],
    };
  }

  const moveResult = await computeImpliedMove(context, event, spot);
  const impliedMoveSource = buildImpliedMoveSource(command, moveResult.impliedMove);
  return {
    earningsSetup: {
      event,
      ...(moveResult.impliedMove !== undefined ? { impliedMove: moveResult.impliedMove } : {}),
      gaps: moveResult.gaps.map((gap) => gap.message),
    },
    earningsExtraSources: impliedMoveSource !== undefined ? [impliedMoveSource] : [],
    earningsSourceGaps: moveResult.gaps,
  };
}
