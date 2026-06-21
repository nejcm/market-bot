import type { ResearchCommand } from "../../cli/args";
import { sourceGap, sourceGapWithContext } from "../../domain/source-gaps";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  Source,
  SourceGap,
} from "../../domain/types";
import {
  resolvePeerUniverse,
  type PeerUniverse,
  type PeerUniverseMapping,
  type PeerUniversePeer,
} from "../../research/peer-universe";
import type { ResearchSubjectRegistryEntry } from "../../research/subject-registry";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import {
  normalizeYahooQuotePayload,
  requestJsonWithQuoteFallback,
  yahooQuoteSourceRequest,
} from "../yahoo";
import { evidenceSource } from "./common";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";

const SEC_FRESHNESS_DAYS = 180;
const MIN_USABLE_PEERS = 3;
const DAY_MS = 86_400_000;

export type ValuationSupportability = "screening-only" | "supported" | "not-supportable";

export interface ValuationCompsRow {
  readonly symbol: string;
  readonly name?: string;
  readonly role?: PeerUniversePeer["role"];
  readonly rationale?: string;
  readonly marketCap?: number;
  readonly cash?: number;
  readonly debt?: number;
  readonly netDebt?: number;
  readonly enterpriseValue?: number;
  readonly latestPeriodRevenue?: number;
  readonly revenuePeriodMonths?: number;
  readonly revenuePeriodEnd?: string;
  readonly annualizedRevenue?: number;
  readonly evToAnnualizedRevenue?: number;
  readonly quoteObservedAt?: string;
  readonly sourceIds: readonly string[];
  readonly usable: boolean;
}

export interface ExcludedValuationPeer {
  readonly symbol: string;
  readonly role: PeerUniversePeer["role"];
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

export interface ValuationCompsArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly target: ValuationCompsRow;
  readonly peers: readonly ValuationCompsRow[];
  readonly excludedPeers: readonly ExcludedValuationPeer[];
  readonly provenance?: PeerUniverse["provenance"];
  readonly peerUniverseSourceIds: readonly string[];
  readonly summary: {
    readonly corePeerCount: number;
    readonly secondaryPeerCount: number;
    readonly usablePeerCount: number;
    readonly targetEvToAnnualizedRevenue?: number;
    readonly peerMedianEvToAnnualizedRevenue?: number;
    readonly peerP25EvToAnnualizedRevenue?: number;
    readonly peerP75EvToAnnualizedRevenue?: number;
    readonly valuationSupportability: ValuationSupportability;
  };
  readonly sourceIds: readonly string[];
  readonly freshnessFlags: {
    readonly targetQuoteFresh: boolean;
    readonly targetSecFresh: boolean;
    readonly peerQuoteFresh: boolean;
    readonly peerSecFresh: boolean;
  };
}

export interface ValuationCompsResult {
  readonly extendedEvidence: ExtendedEvidence;
  readonly artifact: ValuationCompsArtifact;
  readonly sources: readonly Source[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly gaps: readonly SourceGap[];
}

export interface ValuationCompsOptions {
  readonly peerUniverseMappings?: PeerUniverseMapping;
  readonly subjectRegistry?: readonly ResearchSubjectRegistryEntry[];
}

interface PeerCollection {
  readonly peer: PeerUniversePeer;
  readonly quote: MarketSnapshot | undefined;
  readonly sec: Awaited<ReturnType<typeof fetchSecCompanyFactsForSymbol>>;
}

export async function collectValuationComps(
  ctx: CollectContext,
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence,
  options: ValuationCompsOptions = {},
): Promise<ValuationCompsResult> {
  const valuationItem = valuationEvidenceItem(extendedEvidence);
  if (valuationItem === undefined) {
    return emptyResult(ctx, command, extendedEvidence, "missing valuation item");
  }

  const targetSnapshot = marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === "equity" &&
      snapshot.symbol.toUpperCase() === command.symbol.toUpperCase(),
  );
  const target = targetRow(command.symbol, valuationItem, targetSnapshot, ctx.fetchedAt);
  const resolution = resolvePeerUniverse(
    command.symbol,
    options.peerUniverseMappings,
    options.subjectRegistry,
  );
  if (resolution.status !== "resolved" || resolution.universe === undefined) {
    const gap = valuationCompsGap(
      `Peer Universe unavailable for ${command.symbol}: ${resolution.reason}`,
      "unsupported-coverage",
    );
    const artifact = buildArtifact(ctx.fetchedAt, target, [], [], undefined, [gap], []);
    return {
      extendedEvidence: replaceValuationItem(
        extendedEvidence,
        enrichValuationItem(valuationItem, artifact),
        [gap],
      ),
      artifact,
      sources: [],
      rawSnapshots: [],
      gaps: [gap],
    };
  }

  const { universe } = resolution;
  const quoteResult = await requestJsonWithQuoteFallback(
    ctx,
    yahooQuoteSourceRequest(
      universe.peers.map((peer) => peer.symbol),
      "yahoo-valuation-peers",
    ),
  );
  const quoteSnapshots = isFetchJsonResult(quoteResult)
    ? normalizeYahooQuotePayload(quoteResult.payload, "equity", quoteResult.rawSnapshot.fetchedAt)
    : [];
  const quoteBySymbol = new Map(quoteSnapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  const quoteGap = !isFetchJsonResult(quoteResult)
    ? [
        sourceGapWithContext(quoteResult, {
          capability: "market-data",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ]
    : [];
  const peerSecResults = await Promise.all(
    universe.peers.map(async (peer) => ({
      peer,
      quote: quoteBySymbol.get(peer.symbol),
      sec: await fetchSecCompanyFactsForSymbol(ctx, peer.symbol),
    })),
  );
  const peerSources = peerSecResults.flatMap((entry) => sourcesForPeer(command, entry));
  const peers = peerSecResults.map((entry) => peerRow(entry, ctx.fetchedAt));
  const excludedPeers = peers.flatMap((row) => excludedPeer(row, universe.peers, ctx.fetchedAt));
  const peerGaps = [
    ...quoteGap,
    ...peerSecResults.flatMap((entry) => entry.sec.gaps),
    ...excludedPeers.map((peer) =>
      valuationCompsGap(`Peer ${peer.symbol} excluded from valuation comps: ${peer.reason}`),
    ),
  ];
  const artifact = buildArtifact(
    ctx.fetchedAt,
    target,
    peers,
    excludedPeers,
    universe,
    peerGaps,
    peerSources.map((source) => source.id),
  );
  const supportabilityGaps =
    artifact.summary.valuationSupportability === "supported"
      ? []
      : [
          valuationCompsGap(
            `Valuation peer comps ${artifact.summary.valuationSupportability} for ${command.symbol}: ${artifact.summary.usablePeerCount} usable peers`,
          ),
        ];
  const allGaps = [...peerGaps, ...supportabilityGaps];
  return {
    extendedEvidence: replaceValuationItem(
      extendedEvidence,
      enrichValuationItem(valuationItem, artifact),
      allGaps,
    ),
    artifact,
    sources: peerSources,
    rawSnapshots: [
      ...(isFetchJsonResult(quoteResult) ? [quoteResult.rawSnapshot] : []),
      ...peerSecResults.flatMap((entry) => entry.sec.rawSnapshots),
    ],
    gaps: allGaps,
  };
}

function emptyResult(
  ctx: CollectContext,
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
  extendedEvidence: ExtendedEvidence,
  reason: string,
): ValuationCompsResult {
  const target = {
    symbol: command.symbol.toUpperCase(),
    sourceIds: [],
    usable: false,
  };
  const gap = valuationCompsGap(
    `Valuation peer comps unavailable for ${command.symbol}: ${reason}`,
  );
  return {
    extendedEvidence: { ...extendedEvidence, gaps: [...extendedEvidence.gaps, gap] },
    artifact: buildArtifact(ctx.fetchedAt, target, [], [], undefined, [gap], []),
    sources: [],
    rawSnapshots: [],
    gaps: [gap],
  };
}

function valuationEvidenceItem(evidence: ExtendedEvidence): ExtendedEvidenceItem | undefined {
  return evidence.items.find((item) => item.category === "valuation");
}

function readNumberMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): string | undefined {
  const value = metrics?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function targetRow(
  symbol: string,
  item: ExtendedEvidenceItem,
  snapshot: MarketSnapshot | undefined,
  generatedAt: string,
): ValuationCompsRow {
  const marketCap = readNumberMetric(item.metrics, "marketCap");
  const cash = readNumberMetric(item.metrics, "cash");
  const debt = readNumberMetric(item.metrics, "debt");
  const revenue = readNumberMetric(item.metrics, "latestPeriodRevenue");
  const annualizedRevenue = readNumberMetric(item.metrics, "annualizedRevenue");
  const enterpriseValue = readNumberMetric(item.metrics, "enterpriseValue");
  const evToAnnualizedRevenue = readNumberMetric(item.metrics, "evToAnnualizedRevenue");
  const netDebt = readNumberMetric(item.metrics, "netDebt");
  const revenuePeriodMonths = readNumberMetric(item.metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(item.metrics, "revenuePeriodEnd");
  const usable =
    isFreshDate(snapshot?.observedAt, generatedAt) &&
    marketCap !== undefined &&
    cash !== undefined &&
    debt !== undefined &&
    revenue !== undefined &&
    annualizedRevenue !== undefined &&
    enterpriseValue !== undefined &&
    evToAnnualizedRevenue !== undefined &&
    revenuePeriodEnd !== undefined &&
    isFreshPeriodEnd(revenuePeriodEnd, generatedAt);
  return {
    symbol: symbol.toUpperCase(),
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(debt !== undefined ? { debt } : {}),
    ...(netDebt !== undefined ? { netDebt } : {}),
    ...(enterpriseValue !== undefined ? { enterpriseValue } : {}),
    ...(revenue !== undefined ? { latestPeriodRevenue: revenue } : {}),
    ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
    ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
    ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
    ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
    ...(snapshot?.observedAt !== undefined ? { quoteObservedAt: snapshot.observedAt } : {}),
    sourceIds: item.sourceIds,
    usable,
  };
}

function peerRow(entry: PeerCollection, generatedAt: string): ValuationCompsRow {
  const { peer, quote, sec } = entry;
  const { metrics } = sec;
  const marketCap = quote?.marketCap;
  const cash = readNumberMetric(metrics, "cash");
  const debt = readNumberMetric(metrics, "debt");
  const revenue = readNumberMetric(metrics, "revenue");
  const revenuePeriodMonths = readNumberMetric(metrics, "revenuePeriodMonths");
  const revenuePeriodEnd = readStringMetric(metrics, "revenuePeriodEnd");
  const annualizedRevenue =
    revenue !== undefined
      ? revenue *
        (revenuePeriodMonths !== undefined && revenuePeriodMonths > 0
          ? 12 / revenuePeriodMonths
          : 1)
      : undefined;
  const enterpriseValue =
    marketCap !== undefined && cash !== undefined && debt !== undefined
      ? marketCap + debt - cash
      : undefined;
  const evToAnnualizedRevenue =
    enterpriseValue !== undefined && annualizedRevenue !== undefined && annualizedRevenue > 0
      ? enterpriseValue / annualizedRevenue
      : undefined;
  const sourceIds = unique([
    ...(quote?.sourceId !== undefined ? [quote.sourceId] : []),
    ...(sec.sourceId !== undefined ? [sec.sourceId] : []),
  ]);
  const usable =
    isFreshDate(quote?.observedAt, generatedAt) &&
    marketCap !== undefined &&
    cash !== undefined &&
    debt !== undefined &&
    revenue !== undefined &&
    revenuePeriodEnd !== undefined &&
    isFreshPeriodEnd(revenuePeriodEnd, generatedAt) &&
    evToAnnualizedRevenue !== undefined &&
    Number.isFinite(evToAnnualizedRevenue);
  return {
    symbol: peer.symbol,
    ...(peer.name !== undefined ? { name: peer.name } : {}),
    role: peer.role,
    rationale: peer.rationale,
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(cash !== undefined ? { cash } : {}),
    ...(debt !== undefined ? { debt } : {}),
    ...(cash !== undefined && debt !== undefined ? { netDebt: debt - cash } : {}),
    ...(enterpriseValue !== undefined ? { enterpriseValue } : {}),
    ...(revenue !== undefined ? { latestPeriodRevenue: revenue } : {}),
    ...(revenuePeriodMonths !== undefined ? { revenuePeriodMonths } : {}),
    ...(revenuePeriodEnd !== undefined ? { revenuePeriodEnd } : {}),
    ...(annualizedRevenue !== undefined ? { annualizedRevenue } : {}),
    ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
    ...(quote?.observedAt !== undefined ? { quoteObservedAt: quote.observedAt } : {}),
    sourceIds,
    usable,
  };
}

function excludedPeer(
  row: ValuationCompsRow,
  peers: readonly PeerUniversePeer[],
  generatedAt: string,
): readonly ExcludedValuationPeer[] {
  if (row.usable) {
    return [];
  }
  const peer = peers.find((entry) => entry.symbol === row.symbol);
  if (peer === undefined) {
    return [];
  }
  return [
    {
      symbol: row.symbol,
      role: peer.role,
      reason: exclusionReason(row, generatedAt),
      sourceIds: row.sourceIds,
    },
  ];
}

function exclusionReason(row: ValuationCompsRow, generatedAt: string): string {
  if (row.quoteObservedAt === undefined) {
    return "missing quote";
  }
  if (row.marketCap === undefined) {
    return "missing market cap";
  }
  if (row.latestPeriodRevenue === undefined) {
    return "missing SEC revenue";
  }
  if (row.cash === undefined) {
    return "missing SEC cash";
  }
  if (row.debt === undefined) {
    return "missing SEC debt";
  }
  if (row.revenuePeriodEnd === undefined) {
    return "missing SEC revenue period end";
  }
  if (row.evToAnnualizedRevenue === undefined) {
    return "missing EV/revenue multiple";
  }
  if (!isFreshDate(row.quoteObservedAt, generatedAt)) {
    return "stale quote";
  }
  return "stale SEC revenue period";
}

function buildArtifact(
  generatedAt: string,
  target: ValuationCompsRow,
  peers: readonly ValuationCompsRow[],
  excludedPeers: readonly ExcludedValuationPeer[],
  universe: PeerUniverse | undefined,
  gaps: readonly SourceGap[],
  peerSourceIds: readonly string[],
): ValuationCompsArtifact {
  const usablePeers = peers.filter((peer) => peer.usable);
  const multiples = usablePeers.flatMap((peer) =>
    peer.evToAnnualizedRevenue === undefined ? [] : [peer.evToAnnualizedRevenue],
  );
  const supportability = supportabilityFor(target, usablePeers.length);
  return {
    version: 1,
    generatedAt,
    target,
    peers,
    excludedPeers,
    ...(universe !== undefined ? { provenance: universe.provenance } : {}),
    peerUniverseSourceIds: universe?.sources.map((source) => source.sourceId) ?? [],
    summary: {
      corePeerCount: usablePeers.filter((peer) => peer.role === "core").length,
      secondaryPeerCount: usablePeers.filter((peer) => peer.role === "secondary").length,
      usablePeerCount: usablePeers.length,
      ...(target.evToAnnualizedRevenue !== undefined
        ? { targetEvToAnnualizedRevenue: target.evToAnnualizedRevenue }
        : {}),
      ...(multiples.length >= MIN_USABLE_PEERS
        ? {
            peerMedianEvToAnnualizedRevenue: percentile(multiples, 0.5),
            peerP25EvToAnnualizedRevenue: percentile(multiples, 0.25),
            peerP75EvToAnnualizedRevenue: percentile(multiples, 0.75),
          }
        : {}),
      valuationSupportability: supportability,
    },
    sourceIds: unique([
      ...target.sourceIds,
      ...peers.flatMap((peer) => peer.sourceIds),
      ...peerSourceIds,
    ]),
    freshnessFlags: {
      targetQuoteFresh:
        target.quoteObservedAt !== undefined && isFreshDate(target.quoteObservedAt, generatedAt),
      targetSecFresh:
        target.revenuePeriodEnd !== undefined &&
        isFreshPeriodEnd(target.revenuePeriodEnd, generatedAt),
      peerQuoteFresh:
        peers.length > 0 &&
        peers.every(
          (peer) =>
            peer.quoteObservedAt !== undefined && isFreshDate(peer.quoteObservedAt, generatedAt),
        ),
      peerSecFresh:
        peers.length > 0 &&
        peers.every(
          (peer) =>
            peer.revenuePeriodEnd !== undefined &&
            isFreshPeriodEnd(peer.revenuePeriodEnd, generatedAt),
        ),
    },
  };
}

function supportabilityFor(
  target: ValuationCompsRow,
  usablePeerCount: number,
): ValuationSupportability {
  if (!target.usable) {
    return "not-supportable";
  }
  return usablePeerCount >= MIN_USABLE_PEERS ? "supported" : "screening-only";
}

function enrichValuationItem(
  item: ExtendedEvidenceItem,
  artifact: ValuationCompsArtifact,
): ExtendedEvidenceItem {
  const { summary } = artifact;
  const peerReadThrough =
    summary.peerMedianEvToAnnualizedRevenue === undefined
      ? ` Peer comps supportability: ${summary.valuationSupportability}; ${summary.usablePeerCount} usable peers.`
      : ` Peer comps supportability: ${summary.valuationSupportability}; median EV/annualized revenue ${summary.peerMedianEvToAnnualizedRevenue.toFixed(2)}x, IQR ${summary.peerP25EvToAnnualizedRevenue?.toFixed(2)}x-${summary.peerP75EvToAnnualizedRevenue?.toFixed(2)}x.`;
  return {
    ...item,
    summary: `${item.summary}${peerReadThrough}`,
    sourceIds: unique([...item.sourceIds, ...artifact.sourceIds]),
    metrics: {
      ...item.metrics,
      corePeerCount: summary.corePeerCount,
      ...(summary.peerMedianEvToAnnualizedRevenue !== undefined
        ? { peerMedianEvToAnnualizedRevenue: summary.peerMedianEvToAnnualizedRevenue }
        : {}),
      ...(summary.peerP25EvToAnnualizedRevenue !== undefined
        ? { peerP25EvToAnnualizedRevenue: summary.peerP25EvToAnnualizedRevenue }
        : {}),
      ...(summary.peerP75EvToAnnualizedRevenue !== undefined
        ? { peerP75EvToAnnualizedRevenue: summary.peerP75EvToAnnualizedRevenue }
        : {}),
      valuationSupportability: summary.valuationSupportability,
    },
  };
}

function replaceValuationItem(
  evidence: ExtendedEvidence,
  valuationItem: ExtendedEvidenceItem,
  gaps: readonly SourceGap[],
): ExtendedEvidence {
  return {
    ...evidence,
    items: evidence.items.map((item) => (item.category === "valuation" ? valuationItem : item)),
    gaps: [...evidence.gaps, ...gaps],
  };
}

function sourcesForPeer(
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
  entry: PeerCollection,
): readonly Source[] {
  const quoteSource =
    entry.quote === undefined
      ? undefined
      : {
          id: entry.quote.sourceId,
          title: `${entry.peer.symbol} Yahoo valuation peer quote`,
          fetchedAt: entry.quote.observedAt,
          kind: "market-data" as const,
          assetClass: "equity" as const,
          symbol: entry.peer.symbol,
          provider: "yahoo",
          ...(entry.quote.identity !== undefined ? { identity: entry.quote.identity } : {}),
        };
  const secSource =
    entry.sec.sourceId !== undefined && entry.sec.fetchedAt !== undefined
      ? evidenceSource(
          entry.sec.sourceId,
          `${entry.peer.symbol} SEC fundamentals`,
          "sec-edgar",
          { ...command, symbol: entry.peer.symbol },
          entry.sec.fetchedAt,
          entry.sec.sourceUrl,
          entry.sec.identity,
        )
      : undefined;
  return [quoteSource, secSource].filter((source): source is Source => source !== undefined);
}

function isFreshDate(observedAt: string | undefined, generatedAt: string): boolean {
  return observedAt !== undefined && observedAt.slice(0, 10) === generatedAt.slice(0, 10);
}

function isFreshPeriodEnd(periodEnd: string, generatedAt: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(periodMs) || !Number.isFinite(generatedMs)) {
    return false;
  }
  const ageMs = generatedMs - periodMs;
  return ageMs >= 0 && ageMs <= SEC_FRESHNESS_DAYS * DAY_MS;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function valuationCompsGap(
  message: string,
  cause: SourceGap["cause"] = "provider-data-missing",
): SourceGap {
  return sourceGap({
    source: "valuation",
    message,
    provider: "market-bot",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
