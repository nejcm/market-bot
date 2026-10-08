import { RESEARCH_SUBJECT_SYMBOL_RE } from "../config/shared";
import {
  DEFAULT_RESEARCH_SUBJECT_REGISTRY,
  type ResearchSubjectRegistryEntry,
  type ResearchSubjectSource,
} from "./subject-registry";

export const MAX_PEERS = 8;
export const MIN_PROPOSED_PEERS = 3;

type PeerRole = "core" | "secondary";
type PeerUniverseProvenance = "ticker-mapping" | "subject-registry" | "model-proposed-validated";

export interface PeerUniversePeer {
  readonly symbol: string;
  readonly name?: string;
  readonly role: PeerRole;
  readonly rationale: string;
  readonly sourceIds: readonly string[];
}

export interface PeerUniverseSource {
  readonly sourceId: string;
  readonly title: string;
  readonly url?: string;
}

export interface PeerUniverse {
  readonly targetSymbol: string;
  readonly provenance: PeerUniverseProvenance;
  readonly peers: readonly PeerUniversePeer[];
  readonly sources: readonly PeerUniverseSource[];
}

export interface PeerUniverseResolution {
  readonly targetSymbol: string;
  readonly status: "resolved" | "unresolved";
  readonly universe?: PeerUniverse;
  readonly reason: string;
  readonly learnedGeneration?: string;
  readonly refresh?: PeerUniverseRefreshNote;
}

export interface PeerUniverseRefreshNote {
  readonly outcome:
    | "insufficient"
    | "claim-lost"
    | "claim-error"
    | "allowance-used"
    | "missing-target-inputs"
    | "unavailable";
  readonly audit?: ProposalAudit;
  readonly allowanceReleased?: boolean;
}

export interface PeerUniverseValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export type PeerUniverseMapping = Readonly<Record<string, PeerUniverse>>;

export interface ProposalAudit {
  readonly proposed: number;
  readonly survived: number;
  readonly rejectedByDirectory: number;
  readonly rejectedByEtf: number;
  readonly rejectedByListing: number;
  readonly modelId: string;
}

export interface LearnedPeerUniverse {
  readonly universe?: PeerUniverse;
  readonly generation: string;
  readonly refresh: "due" | "used" | "not-needed";
}

// `unavailable` marks a proposal that could not run (directory or model failure), not a weak one.
export interface PeerUniverseProposal {
  readonly universe?: PeerUniverse;
  readonly audit: ProposalAudit;
  readonly unavailable?: boolean;
}

export interface PeerUniverseTargetInputs {
  readonly marketCap?: number;
  readonly sic?: string;
  readonly annualizedRevenue?: number;
}

export interface PeerUniverseFallbackContext {
  readonly cacheRead: (symbol: string) => Promise<LearnedPeerUniverse | undefined>;
  readonly cacheWrite: (
    symbol: string,
    universe: PeerUniverse,
    audit: ProposalAudit,
    observedGeneration?: string,
    claimed?: boolean,
  ) => Promise<string | undefined>;
  readonly propose: (
    symbol: string,
    target?: PeerUniverseTargetInputs,
  ) => Promise<PeerUniverseProposal>;
  readonly claimRefresh: (symbol: string, generation: string) => Promise<boolean>;
  readonly releaseRefresh?: (symbol: string, generation: string) => Promise<boolean>;
  readonly recordEvaluation?: (
    symbol: string,
    generation: string,
    usablePeerCount: number,
  ) => Promise<void>;
}

const PEER_UNIVERSE_MAPPINGS: PeerUniverseMapping = validateDefaultPeerUniverse({
  AAPL: tickerUniverse("AAPL", [
    peer("MSFT", "Microsoft", "core", "large-cap platform ecosystem and services peer", [
      "nasdaq-msft",
    ]),
    peer("GOOGL", "Alphabet", "core", "large-cap digital advertising and platform peer", [
      "nasdaq-googl",
    ]),
    peer("AMZN", "Amazon", "core", "large-cap cloud and consumer ecosystem peer", ["nasdaq-amzn"]),
    peer("META", "Meta Platforms", "core", "large-cap digital platform peer", ["nasdaq-meta"]),
    peer("DELL", "Dell Technologies", "secondary", "hardware and ecosystem peer", ["nyse-dell"]),
  ]),
  NVDA: tickerUniverse("NVDA", [
    peer("AMD", "Advanced Micro Devices", "core", "GPU and accelerator semiconductor peer", [
      "nasdaq-amd",
    ]),
    peer("AVGO", "Broadcom", "core", "large-cap semiconductor infrastructure peer", [
      "nasdaq-avgo",
    ]),
    peer("ANET", "Arista Networks", "secondary", "AI infrastructure demand peer", ["nyse-anet"]),
    peer("VRT", "Vertiv", "secondary", "AI data-center infrastructure peer", ["nyse-vrt"]),
  ]),
  AMD: tickerUniverse("AMD", [
    peer("NVDA", "NVIDIA", "core", "GPU and accelerator semiconductor peer", ["nasdaq-nvda"]),
    peer("AVGO", "Broadcom", "core", "large-cap semiconductor infrastructure peer", [
      "nasdaq-avgo",
    ]),
    peer("INTC", "Intel", "secondary", "CPU and data-center semiconductor peer", ["nasdaq-intc"]),
  ]),
  CRM: tickerUniverse("CRM", [
    peer("MSFT", "Microsoft", "core", "large-cap enterprise software peer", ["nasdaq-msft"]),
    peer("ADBE", "Adobe", "core", "application software peer", ["nasdaq-adbe"]),
    peer("NOW", "ServiceNow", "secondary", "enterprise workflow software peer", ["nyse-now"]),
  ]),
  MSFT: tickerUniverse("MSFT", [
    peer("CRM", "Salesforce", "core", "enterprise software peer", ["nyse-crm"]),
    peer("ADBE", "Adobe", "core", "application software peer", ["nasdaq-adbe"]),
    peer("NOW", "ServiceNow", "secondary", "enterprise workflow software peer", ["nyse-now"]),
  ]),
  PANW: tickerUniverse("PANW", [
    peer("CRWD", "CrowdStrike", "core", "cybersecurity software peer", ["nasdaq-crwd"]),
    peer("FTNT", "Fortinet", "core", "cybersecurity platform peer", ["nasdaq-ftnt"]),
    peer("ZS", "Zscaler", "secondary", "cloud security software peer", ["nasdaq-zs"]),
  ]),
});

export function resolvePeerUniverse(
  targetSymbol: string,
  mappings: PeerUniverseMapping = PEER_UNIVERSE_MAPPINGS,
  registry: readonly ResearchSubjectRegistryEntry[] = DEFAULT_RESEARCH_SUBJECT_REGISTRY,
): PeerUniverseResolution {
  const target = normalizeSymbol(targetSymbol);
  const mapped = mappings[target];
  if (mapped !== undefined) {
    return resolvedPeerUniverse(
      target,
      { ...mapped, peers: mapped.peers.slice(0, MAX_PEERS) },
      "Resolved from checked-in ticker peer mapping",
    );
  }

  const subject = registry.find((entry) =>
    entry.representativeInstruments.some((instrument) => instrument.symbol === target),
  );
  if (subject === undefined) {
    return {
      targetSymbol: target,
      status: "unresolved",
      reason: "No checked-in peer mapping or subject-registry representative match",
    };
  }

  const peers = subject.representativeInstruments
    .filter(
      (instrument) => instrument.symbol !== target && instrument.instrumentType === "listed-stock",
    )
    .slice(0, MAX_PEERS)
    .map(
      (instrument): PeerUniversePeer => ({
        symbol: instrument.symbol,
        ...(instrument.name !== undefined ? { name: instrument.name } : {}),
        role: "core",
        rationale: `shares subject ${subject.displayName}`,
        sourceIds: instrument.sourceIds,
      }),
    );

  if (peers.length === 0) {
    return {
      targetSymbol: target,
      status: "unresolved",
      reason: "Subject-registry match has no listed-stock peers",
    };
  }

  return resolvedPeerUniverse(
    target,
    {
      targetSymbol: target,
      provenance: "subject-registry",
      peers,
      sources: subject.sources.map(toPeerUniverseSource),
    },
    "Resolved from research subject registry representatives",
  );
}

export async function resolvePeerUniverseWithFallback(
  targetSymbol: string,
  fallback?: PeerUniverseFallbackContext,
  mappings?: PeerUniverseMapping,
  registry?: readonly ResearchSubjectRegistryEntry[],
  targetInputs?: PeerUniverseTargetInputs,
): Promise<PeerUniverseResolution> {
  const resolution = resolvePeerUniverse(targetSymbol, mappings, registry);
  if (resolution.status === "resolved" || fallback === undefined) {
    return resolution;
  }
  const target = normalizeSymbol(targetSymbol);

  const cached = await fallback.cacheRead(target);
  if (cached === undefined) {
    const proposed = await proposeAndCache(
      target,
      fallback,
      targetInputs,
      "Resolved from model-proposed, code-validated peer universe",
    );
    return proposed.resolution ?? resolution;
  }

  const cachedResolution =
    cached.universe === undefined
      ? {
          ...resolution,
          reason: "Learned peer-universe entry expired or failed revalidation",
        }
      : learnedResolution(
          resolvedPeerUniverse(
            target,
            cached.universe,
            "Resolved from learned peer-universe cache",
          ),
          cached.generation,
        );
  const withRefresh = (refresh: PeerUniverseRefreshNote): PeerUniverseResolution => ({
    ...cachedResolution,
    refresh,
  });
  if (cached.refresh === "not-needed") {
    return cachedResolution;
  }
  if (cached.refresh === "used") {
    return withRefresh({ outcome: "allowance-used" });
  }
  // Without SIC and a positive cap, proposed peers cannot pass the gates, so defer at no cost.
  if (!hasPeerBandInputs(targetInputs)) {
    return withRefresh({ outcome: "missing-target-inputs" });
  }
  // Only a quality refresh of a usable universe spends the window allowance.
  if (cached.universe !== undefined) {
    let claimed: boolean;
    try {
      claimed = await fallback.claimRefresh(target, cached.generation);
    } catch {
      return withRefresh({ outcome: "claim-error" });
    }
    if (!claimed) {
      return withRefresh({ outcome: "claim-lost" });
    }
  }
  const proposed = await proposeAndCache(
    target,
    fallback,
    targetInputs,
    cached.universe === undefined
      ? "Resolved from model-proposed, code-validated peer universe"
      : "Resolved from refreshed model-proposed peer universe after too few usable peers",
    cached.generation,
    cached.universe !== undefined,
  );
  if (proposed.resolution?.status === "resolved") {
    return proposed.resolution;
  }
  if (!proposed.unavailable) {
    return withRefresh({ outcome: "insufficient", audit: proposed.audit });
  }
  if (cached.universe === undefined) {
    return withRefresh({ outcome: "unavailable" });
  }
  const allowanceReleased =
    (await fallback.releaseRefresh?.(target, cached.generation).catch(() => false)) === true;
  return withRefresh({ outcome: "unavailable", allowanceReleased });
}

// Target inputs that let a proposal and its feedback speak to the SIC and market-cap gates.
export function hasPeerBandInputs(inputs: PeerUniverseTargetInputs | undefined): boolean {
  return (
    inputs?.marketCap !== undefined &&
    Number.isFinite(inputs.marketCap) &&
    inputs.marketCap > 0 &&
    inputs.sic !== undefined &&
    /^\d{4}$/u.test(inputs.sic)
  );
}

async function proposeAndCache(
  target: string,
  fallback: PeerUniverseFallbackContext,
  targetInputs: PeerUniverseTargetInputs | undefined,
  reason: string,
  observedGeneration?: string,
  claimed = false,
): Promise<{
  resolution?: PeerUniverseResolution;
  audit: ProposalAudit;
  unavailable?: boolean;
}> {
  const { universe, audit, unavailable } = await fallback.propose(target, targetInputs);
  if (universe === undefined) {
    return { audit, ...(unavailable === true ? { unavailable } : {}) };
  }
  const proposedResolution = resolvedPeerUniverse(target, universe, reason);
  if (proposedResolution.status !== "resolved") {
    return { resolution: proposedResolution, audit };
  }
  let generation: string | undefined;
  try {
    generation = await fallback.cacheWrite(target, universe, audit, observedGeneration, claimed);
  } catch {
    // Swallow cache-write errors; run succeeds even when disk is unavailable
  }
  return { resolution: learnedResolution(proposedResolution, generation), audit };
}

function learnedResolution(
  resolution: PeerUniverseResolution,
  generation: string | undefined,
): PeerUniverseResolution {
  return resolution.status === "resolved" && generation !== undefined
    ? { ...resolution, learnedGeneration: generation }
    : resolution;
}

export function validatePeerUniverse(universe: PeerUniverse): PeerUniverseValidationResult {
  const errors: string[] = [];
  const target = normalizeSymbol(universe.targetSymbol);
  const sourceIds = new Set(universe.sources.map((source) => source.sourceId));
  const peerSymbols = new Set<string>();

  if (!RESEARCH_SUBJECT_SYMBOL_RE.test(target)) {
    errors.push(`${universe.targetSymbol}: invalid target symbol`);
  }
  if (
    universe.provenance !== "ticker-mapping" &&
    universe.provenance !== "subject-registry" &&
    universe.provenance !== "model-proposed-validated"
  ) {
    errors.push(`${target}: invalid provenance`);
  }
  if (universe.peers.length === 0) {
    errors.push(`${target}: peers must not be empty`);
  }
  universe.sources.forEach((source) => {
    if (source.sourceId.trim() === "" || source.title.trim() === "") {
      errors.push(`${target}: source provenance must include sourceId and title`);
    }
  });

  for (const peerEntry of universe.peers) {
    const symbol = normalizeSymbol(peerEntry.symbol);
    if (!RESEARCH_SUBJECT_SYMBOL_RE.test(symbol)) {
      errors.push(`${target}: invalid peer symbol ${peerEntry.symbol}`);
    }
    if (symbol === target) {
      errors.push(`${target}: peer cannot equal target`);
    }
    if (peerSymbols.has(symbol)) {
      errors.push(`${target}: duplicate peer symbol ${symbol}`);
    }
    peerSymbols.add(symbol);
    if (peerEntry.role !== "core" && peerEntry.role !== "secondary") {
      errors.push(`${target}: invalid role for ${symbol}`);
    }
    if (peerEntry.rationale.trim() === "") {
      errors.push(`${target}: peer ${symbol} rationale must not be empty`);
    }
    if (peerEntry.sourceIds.length === 0) {
      errors.push(`${target}: peer ${symbol} must cite sourceIds`);
    }
    peerEntry.sourceIds.forEach((sourceId) => {
      if (!sourceIds.has(sourceId)) {
        errors.push(`${target}: peer ${symbol} unknown sourceId ${sourceId}`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

function validateDefaultPeerUniverse(mappings: PeerUniverseMapping): PeerUniverseMapping {
  const errors = Object.values(mappings).flatMap(
    (universe) => validatePeerUniverse(universe).errors,
  );
  if (errors.length > 0) {
    throw new Error(`Invalid peer universe mappings: ${errors.join("; ")}`);
  }
  return mappings;
}

function resolvedPeerUniverse(
  targetSymbol: string,
  universe: PeerUniverse,
  reason: string,
): PeerUniverseResolution {
  if (normalizeSymbol(universe.targetSymbol) !== targetSymbol) {
    return {
      targetSymbol,
      status: "unresolved",
      reason: `Invalid Peer Universe: target mismatch ${universe.targetSymbol} != ${targetSymbol}`,
    };
  }
  const validation = validatePeerUniverse(universe);
  if (!validation.valid) {
    return {
      targetSymbol,
      status: "unresolved",
      reason: `Invalid Peer Universe: ${validation.errors.join("; ")}`,
    };
  }
  return {
    targetSymbol,
    status: "resolved",
    universe,
    reason,
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function tickerUniverse(targetSymbol: string, peers: readonly PeerUniversePeer[]): PeerUniverse {
  const sourceMap = new Map<string, PeerUniverseSource>();
  peers.forEach((peerEntry) => {
    peerEntry.sourceIds.forEach((sourceId) => {
      sourceMap.set(sourceId, sourceForId(sourceId));
    });
  });
  return {
    targetSymbol,
    provenance: "ticker-mapping",
    peers,
    sources: [...sourceMap.values()],
  };
}

function peer(
  symbol: string,
  name: string,
  role: PeerRole,
  rationale: string,
  sourceIds: readonly string[],
): PeerUniversePeer {
  return { symbol, name, role, rationale, sourceIds };
}

function sourceForId(sourceId: string): PeerUniverseSource {
  const [exchange, symbol] = sourceId.split("-");
  const normalizedSymbol = symbol?.toUpperCase() ?? sourceId.toUpperCase();
  const exchangeTitle = exchange === "nyse" ? "NYSE" : "Nasdaq";
  return { sourceId, title: `${exchangeTitle} listed symbol directory: ${normalizedSymbol}` };
}

function toPeerUniverseSource(source: ResearchSubjectSource): PeerUniverseSource {
  return {
    sourceId: source.sourceId,
    title: source.title,
    ...(source.url !== undefined ? { url: source.url } : {}),
  };
}
