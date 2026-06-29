import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../sources/guards";
import {
  validatePeerUniverse,
  type ProposalAudit,
  type PeerUniverse,
  type PeerUniversePeer,
  type PeerUniverseSource,
} from "./peer-universe";

const CACHE_VERSION = 1;
const DAY_MS = 86_400_000;
export const DEFAULT_PEER_UNIVERSE_TTL_DAYS = 90;

export interface PeerUniverseLearnedEntry {
  readonly targetSymbol: string;
  readonly provenance: "model-proposed-validated";
  readonly peers: readonly PeerUniversePeer[];
  readonly sources: readonly PeerUniverseSource[];
  readonly proposedAt: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly audit: ProposalAudit;
}

interface PeerUniverseLearnedIndex {
  readonly version: 1;
  readonly entries: readonly PeerUniverseLearnedEntry[];
}

function isStale(entry: PeerUniverseLearnedEntry, now: Date, ttlDays: number): boolean {
  const proposedMs = Date.parse(entry.proposedAt);
  if (!Number.isFinite(proposedMs)) {
    return true;
  }
  return now.getTime() - proposedMs > ttlDays * DAY_MS;
}

function readPeer(value: unknown): PeerUniversePeer | undefined {
  if (
    !isRecord(value) ||
    typeof value.symbol !== "string" ||
    (value.role !== "core" && value.role !== "secondary") ||
    typeof value.rationale !== "string" ||
    !Array.isArray(value.sourceIds) ||
    !value.sourceIds.every((id: unknown) => typeof id === "string")
  ) {
    return undefined;
  }
  return {
    symbol: value.symbol,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    role: value.role,
    rationale: value.rationale,
    sourceIds: value.sourceIds as readonly string[],
  };
}

function readSource(value: unknown): PeerUniverseSource | undefined {
  if (!isRecord(value) || typeof value.sourceId !== "string" || typeof value.title !== "string") {
    return undefined;
  }
  return {
    sourceId: value.sourceId,
    title: value.title,
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  };
}

function readAudit(value: unknown): ProposalAudit | undefined {
  if (
    !isRecord(value) ||
    typeof value.proposed !== "number" ||
    typeof value.survived !== "number" ||
    typeof value.rejectedByDirectory !== "number" ||
    typeof value.rejectedByEtf !== "number" ||
    typeof value.rejectedByListing !== "number" ||
    typeof value.modelId !== "string"
  ) {
    return undefined;
  }
  return {
    proposed: value.proposed,
    survived: value.survived,
    rejectedByDirectory: value.rejectedByDirectory,
    rejectedByEtf: value.rejectedByEtf,
    rejectedByListing: value.rejectedByListing,
    modelId: value.modelId,
  };
}

function readEntry(value: unknown): PeerUniverseLearnedEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.targetSymbol !== "string" ||
    value.provenance !== "model-proposed-validated" ||
    !Array.isArray(value.peers) ||
    !Array.isArray(value.sources) ||
    typeof value.proposedAt !== "string" ||
    typeof value.modelId !== "string" ||
    typeof value.providerName !== "string"
  ) {
    return undefined;
  }
  const peers = value.peers.map(readPeer).filter((p): p is PeerUniversePeer => p !== undefined);
  const sources = value.sources
    .map(readSource)
    .filter((s): s is PeerUniverseSource => s !== undefined);
  const audit = readAudit(value.audit);
  if (peers.length === 0 || sources.length === 0 || audit === undefined) {
    return undefined;
  }
  return {
    targetSymbol: value.targetSymbol,
    provenance: "model-proposed-validated",
    peers,
    sources,
    proposedAt: value.proposedAt,
    modelId: value.modelId,
    providerName: value.providerName,
    audit,
  };
}

async function readIndex(path: string): Promise<readonly PeerUniverseLearnedEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries) || parsed.version !== CACHE_VERSION) {
      return [];
    }
    return parsed.entries
      .map(readEntry)
      .filter((e): e is PeerUniverseLearnedEntry => e !== undefined);
  } catch {
    return [];
  }
}

async function writeIndex(path: string, index: PeerUniverseLearnedIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

// Returns a cache-reader function that resolves a cached peer universe for the
// Given symbol. Performs a staleness check and re-validates on every read (poison
// Guard). Resolves undefined on miss, stale entry, or validation failure.
export function makePeerUniverseCacheReader(
  path: string,
  ttlDays: number = DEFAULT_PEER_UNIVERSE_TTL_DAYS,
  now: Date = new Date(),
): (symbol: string) => Promise<PeerUniverse | undefined> {
  return async (symbol: string): Promise<PeerUniverse | undefined> => {
    const entries = await readIndex(path);
    const target = symbol.trim().toUpperCase();
    const entry = entries.find((e) => e.targetSymbol === target);
    if (entry === undefined) {
      return undefined;
    }
    if (isStale(entry, now, ttlDays)) {
      return undefined;
    }
    const universe: PeerUniverse = {
      targetSymbol: target,
      provenance: "model-proposed-validated",
      peers: entry.peers,
      sources: entry.sources,
    };
    const validation = validatePeerUniverse(universe);
    if (!validation.valid) {
      return undefined;
    }
    return universe;
  };
}

// Returns a cache-writer function that persists a validated peer universe for the
// Given symbol. Prunes stale entries and sorts by symbol for stable diffs. Uses an
// Atomic temp-file write to avoid partial writes.
export function makePeerUniverseCacheWriter(
  path: string,
  ttlDays: number = DEFAULT_PEER_UNIVERSE_TTL_DAYS,
  providerName = "unknown",
): (symbol: string, universe: PeerUniverse, audit: ProposalAudit) => Promise<void> {
  return async (symbol: string, universe: PeerUniverse, audit: ProposalAudit): Promise<void> => {
    const now = new Date();
    const entries = await readIndex(path);
    const target = symbol.trim().toUpperCase();
    // Prune stale entries and remove any existing entry for this symbol (upsert)
    const pruned = entries.filter((e) => e.targetSymbol !== target && !isStale(e, now, ttlDays));
    const newEntry: PeerUniverseLearnedEntry = {
      targetSymbol: target,
      provenance: "model-proposed-validated",
      peers: universe.peers,
      sources: universe.sources,
      proposedAt: now.toISOString(),
      modelId: audit.modelId,
      providerName,
      audit,
    };
    const upserted = [...pruned, newEntry].toSorted((a, b) =>
      a.targetSymbol.localeCompare(b.targetSymbol),
    );
    await writeIndex(path, { version: CACHE_VERSION, entries: upserted });
  };
}
