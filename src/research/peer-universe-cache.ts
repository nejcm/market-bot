import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileAtomic } from "../artifacts";
import { withFileLock } from "../shared-state-lock";
import { DAY_MS } from "../config/shared";
import { isRecord } from "../guards";
import { isSourceGapCause } from "../domain/source-gaps";
import { MIN_USABLE_PEERS } from "../sources/extended-evidence/valuation-comps-contract";
import { PROPOSER_REVISION } from "./peer-universe-proposal";
import {
  MAX_PEERS,
  validatePeerUniverse,
  type LearnedPeerUniverse,
  type PeerExclusionFeedback,
  type ProposalAudit,
  type PeerUniverse,
  type PeerUniversePeer,
  type PeerUniverseSource,
} from "./peer-universe";

const CACHE_VERSION = 1;
const DEFAULT_PEER_UNIVERSE_TTL_DAYS = 90;

interface PeerUniverseLearnedEntry {
  readonly targetSymbol: string;
  readonly provenance: "model-proposed-validated";
  readonly peers: readonly PeerUniversePeer[];
  readonly sources: readonly PeerUniverseSource[];
  readonly proposedAt: string;
  readonly modelId: string;
  readonly providerName: string;
  readonly audit: ProposalAudit;
  readonly windowStartedAt?: string;
  readonly refreshAttemptedAt?: string;
  readonly refreshProposerRevision?: number;
  readonly evaluation?: PeerUniverseEvaluation;
}

interface PeerUniverseEvaluation {
  readonly usablePeerCount: number;
  readonly evaluatedAt: string;
  readonly exclusions?: readonly PeerExclusionFeedback[];
}

interface PeerUniverseLearnedIndex {
  readonly version: 1;
  readonly entries: readonly PeerUniverseLearnedEntry[];
}

function isStale(entry: PeerUniverseLearnedEntry, now: Date, ttlDays: number): boolean {
  return isExpired(entry.proposedAt, now, ttlDays);
}

function isExpired(at: string, now: Date, ttlDays: number): boolean {
  const ms = Date.parse(at);
  return !Number.isFinite(ms) || now.getTime() - ms > ttlDays * DAY_MS;
}

function refreshWindowAnchor(entry: PeerUniverseLearnedEntry): string {
  return entry.windowStartedAt ?? entry.proposedAt;
}

function refreshAllowed(
  entry: PeerUniverseLearnedEntry,
  now: Date,
  ttlDays: number,
  revision: number,
): boolean {
  return (
    entry.refreshAttemptedAt === undefined ||
    (entry.refreshProposerRevision ?? 0) < revision ||
    isExpired(refreshWindowAnchor(entry), now, ttlDays)
  );
}

function usableUniverse(
  entry: PeerUniverseLearnedEntry,
  now: Date,
  ttlDays: number,
): PeerUniverse | undefined {
  if (isStale(entry, now, ttlDays)) {
    return undefined;
  }
  const universe: PeerUniverse = {
    targetSymbol: entry.targetSymbol,
    provenance: "model-proposed-validated",
    peers: entry.peers,
    sources: entry.sources,
  };
  return validatePeerUniverse(universe).valid ? universe : undefined;
}

// An expired or invalid entry re-proposes like a miss; the per-window cap guards quality refreshes.
function refreshState(
  entry: PeerUniverseLearnedEntry,
  now: Date,
  ttlDays: number,
  revision: number,
): LearnedPeerUniverse["refresh"] {
  if (usableUniverse(entry, now, ttlDays) === undefined) {
    return "due";
  }
  if (entry.evaluation === undefined || entry.evaluation.usablePeerCount >= MIN_USABLE_PEERS) {
    return "not-needed";
  }
  return refreshAllowed(entry, now, ttlDays, revision) ? "due" : "used";
}

function readEvaluation(value: unknown): PeerUniverseEvaluation | undefined {
  if (
    !isRecord(value) ||
    typeof value.usablePeerCount !== "number" ||
    typeof value.evaluatedAt !== "string"
  ) {
    return undefined;
  }
  return {
    usablePeerCount: value.usablePeerCount,
    evaluatedAt: value.evaluatedAt,
    ...(Array.isArray(value.exclusions)
      ? { exclusions: boundedExclusions(value.exclusions.filter(isPeerExclusionFeedback)) }
      : {}),
  };
}

function isPeerExclusionFeedback(value: unknown): value is PeerExclusionFeedback {
  return isRecord(value) && typeof value.symbol === "string" && isSourceGapCause(value.cause);
}

function boundedExclusions(
  exclusions: readonly PeerExclusionFeedback[],
): readonly PeerExclusionFeedback[] {
  return exclusions.slice(0, MAX_PEERS).map(({ symbol, cause }) => ({ symbol, cause }));
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
  const evaluation = readEvaluation(value.evaluation);
  return {
    targetSymbol: value.targetSymbol,
    provenance: "model-proposed-validated",
    peers,
    sources,
    proposedAt: value.proposedAt,
    modelId: value.modelId,
    providerName: value.providerName,
    audit,
    ...(typeof value.windowStartedAt === "string"
      ? { windowStartedAt: value.windowStartedAt }
      : {}),
    ...(typeof value.refreshAttemptedAt === "string"
      ? { refreshAttemptedAt: value.refreshAttemptedAt }
      : {}),
    ...(typeof value.refreshProposerRevision === "number"
      ? { refreshProposerRevision: value.refreshProposerRevision }
      : {}),
    ...(evaluation !== undefined ? { evaluation } : {}),
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
  await writeFileAtomic(path, `${JSON.stringify(index, null, 2)}\n`);
}

// Resolves the learned entry for a symbol, re-validated on every read (poison guard); an
// Expired or invalid entry resolves without a universe so a re-proposal can replace it.
export function makePeerUniverseCacheReader(
  path: string,
  ttlDays: number = DEFAULT_PEER_UNIVERSE_TTL_DAYS,
  now: Date = new Date(),
  revision: number = PROPOSER_REVISION,
): (symbol: string) => Promise<LearnedPeerUniverse | undefined> {
  return async (symbol: string): Promise<LearnedPeerUniverse | undefined> => {
    const entries = await readIndex(path);
    const target = symbol.trim().toUpperCase();
    const entry = entries.find((e) => e.targetSymbol === target);
    if (entry === undefined) {
      return undefined;
    }
    const universe = usableUniverse(entry, now, ttlDays);
    const exclusions = entry.evaluation?.exclusions;
    return {
      ...(universe !== undefined ? { universe } : {}),
      generation: entry.proposedAt,
      refresh: refreshState(entry, now, ttlDays, revision),
      ...(exclusions !== undefined ? { exclusions } : {}),
    };
  };
}

async function updateEntry(
  path: string,
  symbol: string,
  generation: string,
  update: (entry: PeerUniverseLearnedEntry) => PeerUniverseLearnedEntry | undefined,
): Promise<boolean> {
  const target = symbol.trim().toUpperCase();
  return withFileLock(`${path}.lock`, async () => {
    const entries = await readIndex(path);
    const current = entries.find((e) => e.targetSymbol === target && e.proposedAt === generation);
    const next = current === undefined ? undefined : update(current);
    if (next === undefined) {
      return false;
    }
    await writeIndex(path, {
      version: CACHE_VERSION,
      entries: entries.map((e) => (e === current ? next : e)),
    });
    return true;
  });
}

// Records the valuation run's usable-peer count and exclusions against the generation it evaluated.
export function makePeerUniverseEvaluationRecorder(
  path: string,
  now: Date = new Date(),
): (
  symbol: string,
  generation: string,
  usablePeerCount: number,
  exclusions: readonly PeerExclusionFeedback[],
) => Promise<void> {
  return async (symbol, generation, usablePeerCount, exclusions) => {
    await updateEntry(path, symbol, generation, (entry) =>
      entry.evaluation !== undefined && Date.parse(entry.evaluation.evaluatedAt) > now.getTime()
        ? undefined
        : {
            ...entry,
            evaluation: {
              usablePeerCount,
              evaluatedAt: now.toISOString(),
              exclusions: boundedExclusions(exclusions),
            },
          },
    );
  };
}

// Consumes the one refresh allowed per TTL window; true only for the run that claimed it.
export function makePeerUniverseRefreshClaimer(
  path: string,
  ttlDays: number = DEFAULT_PEER_UNIVERSE_TTL_DAYS,
  now: Date = new Date(),
  revision: number = PROPOSER_REVISION,
): (symbol: string, generation: string) => Promise<boolean> {
  return async (symbol, generation) =>
    updateEntry(path, symbol, generation, (entry) =>
      usableUniverse(entry, now, ttlDays) !== undefined &&
      refreshState(entry, now, ttlDays, revision) === "due"
        ? {
            ...entry,
            windowStartedAt: isExpired(refreshWindowAnchor(entry), now, ttlDays)
              ? now.toISOString()
              : refreshWindowAnchor(entry),
            refreshAttemptedAt: now.toISOString(),
            refreshProposerRevision: revision,
          }
        : undefined,
    );
}

// Returns the allowance this run claimed when the proposal could not run at all.
export function makePeerUniverseRefreshReleaser(
  path: string,
  now: Date = new Date(),
  revision: number = PROPOSER_REVISION,
): (symbol: string, generation: string) => Promise<boolean> {
  return async (symbol, generation) =>
    updateEntry(path, symbol, generation, (entry) => {
      if (!ownsClaim(entry, now, revision)) {
        return undefined;
      }
      const {
        refreshAttemptedAt: _attempt,
        refreshProposerRevision: _revision,
        ...released
      } = entry;
      return released;
    });
}

function ownsClaim(entry: PeerUniverseLearnedEntry, now: Date, revision: number): boolean {
  return (
    entry.refreshAttemptedAt === now.toISOString() && entry.refreshProposerRevision === revision
  );
}

function carriedRefreshWindow(
  previous: PeerUniverseLearnedEntry | undefined,
  now: Date,
  ttlDays: number,
): Pick<
  PeerUniverseLearnedEntry,
  "windowStartedAt" | "refreshAttemptedAt" | "refreshProposerRevision"
> {
  if (previous === undefined || isExpired(refreshWindowAnchor(previous), now, ttlDays)) {
    return {};
  }
  return {
    windowStartedAt: refreshWindowAnchor(previous),
    ...(previous.refreshAttemptedAt !== undefined
      ? { refreshAttemptedAt: previous.refreshAttemptedAt }
      : {}),
    ...(previous.refreshProposerRevision !== undefined
      ? { refreshProposerRevision: previous.refreshProposerRevision }
      : {}),
  };
}

// Compare-and-set against the entry observed before proposing, and against this run's claim.
export function makePeerUniverseCacheWriter(
  path: string,
  ttlDays: number = DEFAULT_PEER_UNIVERSE_TTL_DAYS,
  providerName = "unknown",
  now: Date = new Date(),
  revision: number = PROPOSER_REVISION,
): (
  symbol: string,
  universe: PeerUniverse,
  audit: ProposalAudit,
  observedGeneration?: string,
  claimed?: boolean,
) => Promise<string | undefined> {
  return async (symbol, universe, audit, observedGeneration, claimed) => {
    const validation = validatePeerUniverse(universe);
    if (!validation.valid) {
      throw new Error(`Invalid learned peer universe: ${validation.errors.join("; ")}`);
    }
    const target = symbol.trim().toUpperCase();
    if (universe.targetSymbol.trim().toUpperCase() !== target) {
      throw new Error(
        `Invalid learned peer universe: target mismatch ${universe.targetSymbol} != ${target}`,
      );
    }
    const proposedAt = now.toISOString();
    return withFileLock(`${path}.lock`, async () => {
      const entries = await readIndex(path);
      const previous = entries.find((e) => e.targetSymbol === target);
      // A concurrent writer may have pruned the expired entry this run observed; that is not a newer generation.
      const prunedAfterExpiry =
        previous === undefined &&
        observedGeneration !== undefined &&
        isExpired(observedGeneration, now, ttlDays);
      if (
        (previous?.proposedAt !== observedGeneration && !prunedAfterExpiry) ||
        (claimed === true && (previous === undefined || !ownsClaim(previous, now, revision)))
      ) {
        return;
      }
      const newEntry: PeerUniverseLearnedEntry = {
        targetSymbol: target,
        provenance: "model-proposed-validated",
        peers: universe.peers,
        sources: universe.sources,
        proposedAt,
        modelId: audit.modelId,
        providerName,
        audit,
        ...carriedRefreshWindow(previous, now, ttlDays),
      };
      const pruned = entries.filter((e) => e.targetSymbol !== target && !isStale(e, now, ttlDays));
      const upserted = [...pruned, newEntry].toSorted((a, b) =>
        a.targetSymbol.localeCompare(b.targetSymbol),
      );
      await writeIndex(path, { version: CACHE_VERSION, entries: upserted });
      return proposedAt;
    });
  };
}
