import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../cli/args";
import {
  isMarketUpdateJobType,
  type ExtendedEvidence,
  type MarketSnapshot,
  type OhlcvBar,
  type Source,
  type SourceGap,
  type VerifiedMarketSnapshot,
} from "../domain/types";
import type { CollectContext, EarningsSetupCollected, FetchLike, RawSourceSnapshot } from "./types";
import { verifiedMarketSnapshotSourceId } from "./verified-market-snapshot";
import { deriveCanonicalInstrumentIdentity } from "./instrument-identity";
import { isUsListing } from "./instrument-capability";
import {
  deriveEquityReportingFreshness,
  type EquityReportingFreshness,
} from "./extended-evidence/equity-analysis-completeness";
import { addFinancialLensEvidence } from "./extended-evidence/financial-lens";
import { withCanonicalFinancialLensInputs } from "./extended-evidence/financial-lens-canonical";
import {
  collectSubsequentFinancingBridge,
  deriveSubsequentFinancingBridge,
  withSubsequentFinancingEvidence,
  type SubsequentFinancingBridgeArtifact,
} from "./extended-evidence/subsequent-financing";
import {
  collectCapitalOwnershipArtifact,
  deriveCapitalOwnershipArtifact,
  type CapitalOwnershipArtifact,
} from "./extended-evidence/capital-ownership";
import {
  deriveFundamentalHistory,
  fundamentalHistoryFromCompanyFacts,
  type FundamentalHistoryArtifact,
} from "./extended-evidence/fundamental-history";
import { deriveFundamentalHistoryFromFinancialStatements } from "./extended-evidence/fundamental-history-canonical";
import type { SecCompanyFactsResult } from "./extended-evidence/sec-edgar";
import {
  collectFinancialStatements,
  deriveFinancialStatements,
} from "./extended-evidence/financial-statements";
import type { FinancialStatementsArtifact } from "./extended-evidence/financial-statements-contract";
import { addBusinessFrameworkEvidence } from "./extended-evidence/business-framework";
import { addValuationEvidence } from "./extended-evidence/valuation";
import { buildYahooFundamentals } from "./extended-evidence/yahoo-fundamentals";
import {
  collectValuationComps,
  valuationCompsSkippedGap,
} from "./extended-evidence/valuation-comps";
import { collectValuationWorkbench } from "./extended-evidence/valuation-workbench";
import { depositoryIssuerSic } from "./extended-evidence/industry-classification";
import type { ValuationWorkbenchArtifact } from "./extended-evidence/valuation-workbench-contract";
import { buildReverseDcf, type ReverseDcfArtifact } from "./extended-evidence/reverse-dcf";
import { createPeerUniverseProposer } from "../research/peer-universe-proposal";
import {
  makePeerUniverseCacheReader,
  makePeerUniverseCacheWriter,
} from "../research/peer-universe-cache";
import { parseNearEarningsEvent, computeImpliedMove } from "./extended-evidence/earnings-setup";
import { evidenceSource } from "./extended-evidence/common";
import type { ModelProvider } from "../model/types";
import type { PeerUniverseFallbackContext } from "../research/peer-universe";
import { type SecTargetPacket } from "./sec-target-packet";
import { deriveTradierImpliedMove, type TradierPacket } from "./tradier-packet";
import { sourceGap } from "../domain/source-gaps";

export interface PeerUniverseSeam {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly cachePath: string;
  readonly ttlDays?: number;
}

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
  readonly verifiedPriceHistory: readonly Pick<OhlcvBar, "date" | "close">[];
  readonly fetchedAt: string;
  readonly context: CollectContext;
  readonly identityContext: CollectContext;
  readonly preliminaryIdentityResult: InstrumentIdentityResult | undefined;
  readonly now: Date;
  readonly peerUniverse: PeerUniverseSeam | undefined;
  readonly secTargetPacket: SecTargetPacket | undefined;
  readonly tradierPacket: TradierPacket | undefined;
  readonly fetchImpl: FetchLike;
}

interface EquityEnrichmentResult {
  readonly identityResult: InstrumentIdentityResult | undefined;
  readonly valuationResult: ValuationResult;
  readonly valuationCompsResult: ValuationCompsResult | undefined;
  readonly valuationCompsSkippedGaps: readonly SourceGap[];
  readonly valuationWorkbench: ValuationWorkbenchArtifact | undefined;
  readonly valuationWorkbenchSources: readonly Source[];
  readonly valuationWorkbenchSourceGaps: readonly SourceGap[];
  readonly reverseDcf: ReverseDcfArtifact | undefined;
  readonly financialLensResult: FinancialLensResult;
  readonly fundamentalHistory: FundamentalHistoryArtifact | undefined;
  readonly financialStatements: FinancialStatementsArtifact | undefined;
  readonly reportingFreshness: EquityReportingFreshness | undefined;
  readonly subsequentFinancing: SubsequentFinancingBridgeArtifact | undefined;
  readonly capitalOwnership: CapitalOwnershipArtifact | undefined;
  readonly businessFrameworkResult: BusinessFrameworkResult;
  readonly earningsSetup: EarningsSetupCollected | undefined;
  readonly earningsExtraSources: readonly Source[];
  readonly earningsSourceGaps: readonly SourceGap[];
  readonly packetFailureGaps: readonly SourceGap[];
}

export async function collectEquityEnrichment(
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

  const collectStructuredSec = isUsListing(
    input.command.symbol,
    input.identityContext.instrumentIdentity,
  );
  const earningsResult =
    input.command.depth === "deep"
      ? await collectEarningsSetup(
          input.command,
          input.marketSnapshots,
          input.extendedRawSnapshots,
          input.context,
          input.tradierPacket,
        )
      : { earningsSetup: undefined, earningsExtraSources: [], earningsSourceGaps: [] };
  if (collectStructuredSec && input.secTargetPacket?.status === "failed") {
    return {
      ...noEquityEnrichment(identityResult, input.extendedEvidence),
      ...earningsResult,
      packetFailureGaps: secPacketDependencyGaps(input.command.symbol),
    };
  }
  const secFacts = input.secTargetPacket?.companyFacts;
  let financialStatements: FinancialStatementsArtifact | undefined = undefined;
  let fallbackCompanyFacts: SecCompanyFactsResult | undefined = undefined;
  if (collectStructuredSec && secFacts !== undefined) {
    financialStatements = deriveFinancialStatements(secFacts.payload, {
      symbol: input.command.symbol,
      generatedAt: input.fetchedAt,
      analysisAsOf: input.fetchedAt,
      sourceId: secFacts.sourceId,
      ...(secFacts.sourceUrl !== undefined ? { sourceUrl: secFacts.sourceUrl } : {}),
      ...(input.secTargetPacket?.submissions !== undefined
        ? {
            submissionsPayload: input.secTargetPacket.submissions.payload,
            submissionsSourceId: input.secTargetPacket.submissions.sourceId,
          }
        : {}),
    });
  } else if (collectStructuredSec) {
    const collected = await collectFinancialStatements(input.identityContext, input.command.symbol);
    financialStatements = collected.statements;
    fallbackCompanyFacts = collected.companyFacts;
  }
  let legacyFundamentalHistory: FundamentalHistoryArtifact | undefined = undefined;
  if (collectStructuredSec && financialStatements === undefined && secFacts !== undefined) {
    legacyFundamentalHistory = deriveFundamentalHistory(secFacts.payload, {
      symbol: input.command.symbol,
      generatedAt: input.fetchedAt,
      analysisAsOf: input.fetchedAt,
      sourceId: secFacts.sourceId,
      ...(secFacts.sourceUrl !== undefined ? { sourceUrl: secFacts.sourceUrl } : {}),
    });
  } else if (
    collectStructuredSec &&
    financialStatements === undefined &&
    fallbackCompanyFacts !== undefined
  ) {
    legacyFundamentalHistory = fundamentalHistoryFromCompanyFacts(
      input.identityContext,
      input.command.symbol,
      fallbackCompanyFacts,
    );
  }
  let subsequentFinancing: SubsequentFinancingBridgeArtifact | undefined = undefined;
  let capitalOwnership: CapitalOwnershipArtifact | undefined = undefined;
  if (financialStatements !== undefined) {
    subsequentFinancing =
      secFacts === undefined
        ? await collectSubsequentFinancingBridge(
            input.identityContext,
            input.command.symbol,
            financialStatements,
          )
        : deriveSubsequentFinancingBridge(secFacts.payload, financialStatements);
    capitalOwnership =
      secFacts === undefined
        ? await collectCapitalOwnershipArtifact(
            input.identityContext,
            input.command.symbol,
            financialStatements,
            subsequentFinancing,
          )
        : deriveCapitalOwnershipArtifact(
            secFacts.payload,
            financialStatements,
            subsequentFinancing,
          );
  }
  const valuationResult =
    financialStatements === undefined
      ? addValuationEvidence(input.command, input.marketSnapshots, input.extendedEvidence)
      : addValuationEvidence(
          input.command,
          input.marketSnapshots,
          withCanonicalFinancialLensInputs(
            input.extendedEvidence,
            financialStatements,
            input.secTargetPacket?.providerResult.sicClassification,
          ),
        );
  const peerUniverseFallback =
    input.command.depth === "deep"
      ? peerUniverseFallbackFor(input.peerUniverse, input.identityContext, input.now)
      : undefined;
  // Peer comps screen and rank on EV/revenue alone, so for a depository issuer there is nothing
  // Left to compare on; the workbench states the inapplicability rather than fetching peers whose
  // Only published multiple could not be used.
  const depositoryIssuer =
    depositoryIssuerSic(valuationResult.extendedEvidence ?? input.extendedEvidence) !== undefined;
  const valuationCompsResult =
    input.command.depth === "deep" &&
    !depositoryIssuer &&
    valuationResult.extendedEvidence?.items.some((item) => item.category === "valuation") === true
      ? await collectValuationComps(
          input.identityContext,
          input.command,
          input.marketSnapshots,
          valuationResult.extendedEvidence,
          {
            ...(peerUniverseFallback !== undefined ? { peerUniverseFallback } : {}),
            ...(input.secTargetPacket?.cikMapping !== undefined
              ? { secTickerPayload: input.secTargetPacket.cikMapping.payload }
              : {}),
          },
        )
      : undefined;
  // The skipped gap reads "target valuation unavailable", which is untrue for a depository issuer:
  // The workbench's peer comparison already states why the comparison does not apply.
  const valuationCompsSkippedGaps =
    input.command.depth === "deep" && valuationCompsResult === undefined && !depositoryIssuer
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
  const fundamentalHistory =
    financialStatements === undefined
      ? legacyFundamentalHistory
      : deriveFundamentalHistoryFromFinancialStatements(financialStatements);
  const financialLensEvidence =
    financialStatements === undefined
      ? evidenceWithYahooFundamentals
      : withSubsequentFinancingEvidence(
          withCanonicalFinancialLensInputs(
            evidenceWithYahooFundamentals,
            financialStatements,
            input.secTargetPacket?.providerResult.sicClassification,
          ),
          subsequentFinancing,
        );
  // Derived once here, with collection's timestamp, then carried on CollectedSources so the
  // Orchestrator's completeness gaps quote exactly the dates the lens metrics published.
  const reportingFreshness = deriveEquityReportingFreshness(financialStatements, input.fetchedAt);
  const financialLensResult = addFinancialLensEvidence(
    input.command,
    input.marketSnapshots,
    financialLensEvidence,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
    subsequentFinancing,
    reportingFreshness,
  );
  const businessFrameworkResult = addBusinessFrameworkEvidence(
    input.command,
    input.marketSnapshots,
    financialLensResult.extendedEvidence,
    input.verifiedMarketSnapshot,
    input.fetchedAt,
  );
  const valuationWorkbenchResult = await collectValuationWorkbench({
    generatedAt: input.fetchedAt,
    symbol: input.command.symbol,
    ...(financialStatements !== undefined ? { financialStatements } : {}),
    ...(valuationCompsResult?.artifact !== undefined
      ? { valuationComps: valuationCompsResult.artifact }
      : {}),
    priceHistory: input.verifiedPriceHistory,
    ...(input.verifiedMarketSnapshot !== undefined
      ? { priceSourceId: verifiedMarketSnapshotSourceId(input.command.symbol) }
      : {}),
    ...(identityResult?.identity?.quoteCurrency !== undefined
      ? { quoteCurrency: identityResult.identity.quoteCurrency }
      : {}),
    ...(businessFrameworkResult.extendedEvidence !== undefined
      ? { extendedEvidence: businessFrameworkResult.extendedEvidence }
      : {}),
    fetchImpl: input.fetchImpl,
  });
  const valuationWorkbench = valuationWorkbenchResult.artifact;
  const reverseDcf = buildReverseDcf({
    generatedAt: input.fetchedAt,
    symbol: input.command.symbol,
    valuationWorkbench,
    ...(businessFrameworkResult.extendedEvidence !== undefined
      ? { extendedEvidence: businessFrameworkResult.extendedEvidence }
      : {}),
  });

  return {
    identityResult,
    valuationResult,
    valuationCompsResult,
    valuationCompsSkippedGaps,
    valuationWorkbench,
    valuationWorkbenchSources: valuationWorkbenchResult.sources,
    valuationWorkbenchSourceGaps: valuationWorkbenchResult.sourceGaps,
    reverseDcf,
    fundamentalHistory,
    financialStatements,
    reportingFreshness,
    subsequentFinancing,
    capitalOwnership,
    financialLensResult,
    businessFrameworkResult,
    ...earningsResult,
    packetFailureGaps: [],
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
    valuationWorkbench: undefined,
    valuationWorkbenchSources: [],
    valuationWorkbenchSourceGaps: [],
    reverseDcf: undefined,
    fundamentalHistory: undefined,
    financialStatements: undefined,
    reportingFreshness: undefined,
    subsequentFinancing: undefined,
    capitalOwnership: undefined,
    financialLensResult,
    businessFrameworkResult,
    earningsSetup: undefined,
    earningsExtraSources: [],
    earningsSourceGaps: [],
    packetFailureGaps: [],
  };
}

function secPacketDependencyGaps(symbol: string): readonly SourceGap[] {
  return [
    "financial-statements",
    "fundamental-history",
    "financial-lenses",
    "subsequent-financing",
    "capital-ownership",
    "valuation",
    "business-framework",
  ].map((derivation) =>
    sourceGap({
      source: `sec-target-packet:${derivation}`,
      message: `${derivation} suppressed for ${symbol}: target SEC packet is unavailable`,
      provider: "sec-edgar",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
      symbol: symbol.toUpperCase(),
    }),
  );
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
  tradierPacket?: TradierPacket,
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

  const moveResult =
    tradierPacket === undefined
      ? await computeImpliedMove(context, event, spot)
      : deriveTradierImpliedMove(tradierPacket, event, spot);
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
