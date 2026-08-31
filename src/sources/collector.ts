import { collectEquityEnrichment, type PeerUniverseSeam } from "./collector-equity-enrichment";

import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { SourceOptions } from "../config";
import { progress } from "../progress";
import { isMarketUpdateJobType, type MarketSnapshot } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import type {
  CollectContext,
  CollectedSources,
  ExtendedEvidenceCollectionResult,
  FetchLike,
  NewsRelevanceTarget,
  ThematicNewsQuery,
} from "./types";
import { createSourceRegistry } from "./registry";
import { DEFAULT_RETRY_DELAYS_MS } from "./retry-utils";
import { createCollectContext } from "./source-request";
import { collectVerifiedMarketSnapshot } from "./verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "./instrument-identity";
import { deriveAnalystExpectations } from "./extended-evidence/analyst-expectations";
import { deriveInstitutionalOwnership } from "./extended-evidence/institutional-ownership";
import type { ResolvedResearchSubject } from "../research/research-subject-identity";
import { mergeModelInputSanitization } from "./model-input-sanitizer";
import {
  sanitizeInstrumentIdentityMetadata,
  sanitizeMarketSnapshotMetadata,
} from "./metadata-sanitization";
import {
  analystExpectationsExtendedEvidenceAdapter,
  createMultiExtendedEvidenceAdapter,
  finnhubEventsExtendedEvidenceAdapter,
  fredExtendedEvidenceAdapter,
  institutionalOwnershipExtendedEvidenceAdapter,
  providerResultToExtendedEvidence,
} from "./extended-evidence";
import {
  collectSecTargetPacketBase,
  finalizeSecTargetPacket,
  type SecTargetPacket,
} from "./sec-target-packet";
import {
  collectTradierPacket,
  earningsEventFromExtendedSnapshots,
  type TradierPacket,
} from "./tradier-packet";
import { deepEquityAcquisitionTasksForPhase } from "../deep-equity/acquisition-recipe";

const DEEP_EQUITY_PROVIDER_ADAPTER = createMultiExtendedEvidenceAdapter("equity", [
  finnhubEventsExtendedEvidenceAdapter,
  analystExpectationsExtendedEvidenceAdapter,
  institutionalOwnershipExtendedEvidenceAdapter,
  fredExtendedEvidenceAdapter,
]);

function mergeDeepEquityProviderResults(
  context: CollectContext,
  sec: SecTargetPacket,
  providers: ExtendedEvidenceCollectionResult,
  tradier: TradierPacket,
): ExtendedEvidenceCollectionResult {
  const secEvidence = providerResultToExtendedEvidence(context, "equity", sec.providerResult);
  const tradierEvidence = providerResultToExtendedEvidence(
    context,
    "equity",
    tradier.providerResult,
  );
  return {
    rawSnapshots: [
      ...(sec.companyFactsResult?.rawSnapshots ?? sec.providerResult.rawSnapshots),
      ...providers.rawSnapshots,
      ...tradier.providerResult.rawSnapshots,
    ],
    sources: [...secEvidence.sources, ...providers.sources, ...tradierEvidence.sources],
    extendedEvidence: {
      instrument: { symbol: sec.symbol, assetClass: "equity" },
      items: [
        ...(secEvidence.extendedEvidence?.items ?? []),
        ...(providers.extendedEvidence?.items ?? []),
        ...(tradierEvidence.extendedEvidence?.items ?? []),
      ],
      gaps: [
        ...(secEvidence.extendedEvidence?.gaps ?? []),
        ...(providers.extendedEvidence?.gaps ?? []),
        ...(tradierEvidence.extendedEvidence?.gaps ?? []),
      ],
    },
    sourceGaps: [...secEvidence.sourceGaps, ...providers.sourceGaps, ...tradierEvidence.sourceGaps],
  };
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
export interface CollectSourcesRuntimeOptions {
  readonly now?: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly peerUniverse?: PeerUniverseSeam;
  readonly resolvedSubject?: ResolvedResearchSubject;
  readonly collectTradierTermStructure?: boolean;
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

  progress("collecting sources");
  const registry = createSourceRegistry();
  const requiredMarketSnapshotSymbols = representativeSnapshotSymbols(resolvedSubject);
  const marketCtx =
    requiredMarketSnapshotSymbols.length === 0 ? ctx : { ...ctx, requiredMarketSnapshotSymbols };
  const marketAdapter = registry.marketDataFor(command.assetClass);
  const supplementalMarketAdapters = registry.supplementalMarketDataFor(command.assetClass);
  const newsAdapter = registry.newsFor(command.assetClass);
  const registryExtendedEvidenceAdapter = registry.extendedEvidenceFor(command.assetClass);
  const marketContextAdapter = registry.marketContextFor(command.assetClass);

  // Verified Market Snapshot: equity ticker only (ADR 0004); joins the parallel batch
  const isEquityTicker = isInstrumentCommand(command) && command.assetClass === "equity";
  const isTicker = isInstrumentCommand(command);
  const isDeepEquity = isEquityTicker && command.depth === "deep";
  const deepEquityParallelExecutors = new Set(
    isDeepEquity
      ? deepEquityAcquisitionTasksForPhase("parallel-provider").map((task) => task.execute)
      : [],
  );
  const extendedEvidenceAdapter = isDeepEquity
    ? DEEP_EQUITY_PROVIDER_ADAPTER
    : registryExtendedEvidenceAdapter;

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
    secTargetPacketBase,
    deepSupplementalMarketResults,
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
    isDeepEquity && deepEquityParallelExecutors.has("sec-target-packet")
      ? collectSecTargetPacketBase(identityCtx, command)
      : undefined,
    isDeepEquity && deepEquityParallelExecutors.has("supplemental-market")
      ? Promise.all(
          supplementalMarketAdapters.map((adapter) =>
            adapter.collect(marketCtx, marketResult?.marketSnapshots ?? []),
          ),
        )
      : undefined,
  ]);
  const earningsEvent = isDeepEquity
    ? earningsEventFromExtendedSnapshots(command.symbol, extendedResult.rawSnapshots)
    : undefined;
  const packetContext =
    earningsEvent === undefined
      ? identityCtx
      : { ...identityCtx, earningsEventDate: earningsEvent.date };
  const [secTargetPacket, tradierPacket] =
    isDeepEquity && secTargetPacketBase !== undefined
      ? await Promise.all([
          finalizeSecTargetPacket(packetContext, secTargetPacketBase),
          deepEquityParallelExecutors.has("tradier-packet")
            ? collectTradierPacket(
                identityCtx,
                command,
                earningsEvent,
                runtime.collectTradierTermStructure === true,
              )
            : undefined,
        ])
      : [undefined, undefined];
  const deepExtendedResult =
    isDeepEquity && secTargetPacket !== undefined && tradierPacket !== undefined
      ? mergeDeepEquityProviderResults(identityCtx, secTargetPacket, extendedResult, tradierPacket)
      : extendedResult;
  const supplementalMarketResults =
    deepSupplementalMarketResults ??
    (await Promise.all(
      supplementalMarketAdapters.map((adapter) =>
        adapter.collect(marketCtx, resolvedMarketResult.marketSnapshots),
      ),
    ));
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
      ? entry.result.sourceGaps
      : entry.result.sourceGaps.map((gap) => ({
          ...gap,
          message: `${gap.message} for research representative ${entry.symbol}`,
          evidenceQualityImpact: "no-cap" as const,
        })),
  );

  progress("equity enrichment");
  const enrichmentResult = await collectEquityEnrichment({
    command,
    marketSnapshots: resolvedMarketResult.marketSnapshots,
    extendedEvidence: deepExtendedResult.extendedEvidence,
    extendedRawSnapshots: deepExtendedResult.rawSnapshots,
    verifiedMarketSnapshot: verifiedSnapshotResult?.snapshot,
    verifiedPriceHistory: verifiedSnapshotResult?.priceHistory ?? [],
    fetchedAt: ctx.fetchedAt,
    context: ctx,
    identityContext: identityCtx,
    preliminaryIdentityResult,
    now,
    peerUniverse: peerUniverseSeam,
    secTargetPacket,
    tradierPacket,
    fetchImpl: requestFetchImpl,
  });
  const analystExpectationsResult =
    isEquityTicker && command.depth === "deep"
      ? deriveAnalystExpectations(
          command.symbol,
          ctx.fetchedAt,
          deepExtendedResult.rawSnapshots,
          deepExtendedResult.sourceGaps,
        )
      : undefined;
  const institutionalOwnershipResult =
    isEquityTicker && command.depth === "deep"
      ? deriveInstitutionalOwnership(
          command.symbol,
          ctx.fetchedAt,
          deepExtendedResult.rawSnapshots,
          deepExtendedResult.sourceGaps,
        )
      : undefined;
  staleFallbackGaps.push(...enrichmentResult.earningsSourceGaps);
  const rawIdentity = enrichmentResult.identityResult?.identity;
  const sanitizedIdentity =
    rawIdentity === undefined
      ? undefined
      : sanitizeInstrumentIdentityMetadata(rawIdentity, "instrument-identity");
  const resolvedInstrumentIdentity = sanitizedIdentity?.identity;

  const collected = {
    rawSnapshots: [
      ...resolvedMarketResult.rawSnapshots,
      ...newsResult.rawSnapshots,
      ...deepExtendedResult.rawSnapshots,
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
      ...deepExtendedResult.sources,
      ...(enrichmentResult.valuationCompsResult?.sources ?? []),
      ...enrichmentResult.valuationWorkbenchSources,
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
    ...(secTargetPacket !== undefined ? { secTargetPacket } : {}),
    ...(tradierPacket !== undefined ? { tradierPacket } : {}),
    ...(enrichmentResult.earningsSetup !== undefined
      ? { earningsSetup: enrichmentResult.earningsSetup }
      : {}),
    ...(analystExpectationsResult?.artifact !== undefined
      ? { analystExpectations: analystExpectationsResult.artifact }
      : {}),
    ...(analystExpectationsResult !== undefined
      ? { analystExpectationsSignal: analystExpectationsResult.signal }
      : {}),
    ...(institutionalOwnershipResult?.artifact !== undefined
      ? { institutionalOwnership: institutionalOwnershipResult.artifact }
      : {}),
    ...(institutionalOwnershipResult !== undefined
      ? { institutionalOwnershipSignal: institutionalOwnershipResult.signal }
      : {}),
    ...(enrichmentResult.valuationCompsResult?.artifact !== undefined
      ? { valuationComps: enrichmentResult.valuationCompsResult.artifact }
      : {}),
    ...(enrichmentResult.valuationWorkbench !== undefined
      ? { valuationWorkbench: enrichmentResult.valuationWorkbench }
      : {}),
    ...(enrichmentResult.reverseDcf !== undefined
      ? { reverseDcf: enrichmentResult.reverseDcf }
      : {}),
    ...(enrichmentResult.financialLensResult.artifact !== undefined
      ? { financialLenses: enrichmentResult.financialLensResult.artifact }
      : {}),
    ...(enrichmentResult.fundamentalHistory !== undefined
      ? { fundamentalHistory: enrichmentResult.fundamentalHistory }
      : {}),
    ...(enrichmentResult.financialStatements !== undefined
      ? { financialStatements: enrichmentResult.financialStatements }
      : {}),
    ...(enrichmentResult.reportingFreshness !== undefined
      ? { reportingFreshness: enrichmentResult.reportingFreshness }
      : {}),
    ...(enrichmentResult.subsequentFinancing !== undefined
      ? { subsequentFinancing: enrichmentResult.subsequentFinancing }
      : {}),
    ...(enrichmentResult.capitalOwnership !== undefined
      ? { capitalOwnership: enrichmentResult.capitalOwnership }
      : {}),
    ...(enrichmentResult.businessFrameworkResult.artifact !== undefined
      ? { businessFramework: enrichmentResult.businessFrameworkResult.artifact }
      : {}),
    sourceGaps: [
      ...resolvedMarketResult.sourceGaps,
      ...newsResult.sourceGaps,
      ...deepExtendedResult.sourceGaps,
      ...enrichmentResult.valuationResult.sourceGaps,
      ...(enrichmentResult.valuationCompsResult?.gaps ?? []),
      ...enrichmentResult.valuationCompsSkippedGaps,
      ...enrichmentResult.valuationWorkbenchSourceGaps,
      ...enrichmentResult.financialLensResult.sourceGaps,
      ...enrichmentResult.businessFrameworkResult.sourceGaps,
      ...enrichmentResult.packetFailureGaps,
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
  progress(
    `sources collected: ${String(collected.rawSnapshots.length)} snapshot(s), ${String(
      collected.newsSources.length,
    )} news, ${String(collected.sourceGaps.length)} gap(s)`,
  );
  return collected;
}
