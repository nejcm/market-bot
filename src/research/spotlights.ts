import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AssetClass, MarketSnapshot, MoverFeatures } from "../domain/types";
import { rankMovers } from "../movers/ranking";
import { isRecord, readNumber, readString, stringArrayValue } from "../sources/guards";
import type { HistoricalResearchContext } from "./historical-context";

export interface SpotlightAlphaAnnotation {
  readonly seenCount: number;
  readonly lastSeenAt: string;
  readonly sourceGroup?: string;
  readonly discoverySources: readonly string[];
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly latestValidation: readonly string[];
}

export interface SpotlightAlphaWatchlist {
  readonly generatedAt: string;
  readonly candidates: readonly {
    readonly symbol: string;
    readonly annotation: SpotlightAlphaAnnotation;
  }[];
}

export interface SpotlightCandidate {
  readonly id: string;
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly name?: string;
  readonly sourceIds: readonly string[];
  readonly currentSnapshot: {
    readonly price: number;
    readonly changePercent24h: number;
    readonly volume: number;
    readonly marketCap?: number;
    readonly observedAt: string;
  };
  readonly benchmark?: {
    readonly symbol: string;
    readonly changePercent24h: number;
    readonly sourceId: string;
  };
  readonly mover: {
    readonly rank: number;
    readonly score: number;
    readonly features: MoverFeatures;
  };
  readonly history: {
    readonly tickerRunIds: readonly string[];
    readonly marketRunIds: readonly string[];
  };
  readonly alpha?: SpotlightAlphaAnnotation;
}

export interface SelectedSpotlight {
  readonly symbol: string;
  readonly rationale: string;
  readonly sourceIds: readonly string[];
  readonly candidate: SpotlightCandidate;
}

export type SpotlightSelectionRejectionReason =
  | "malformed-json"
  | "malformed-selection"
  | "unknown-symbol"
  | "duplicate-symbol"
  | "cap-overflow"
  | "unknown-source-id";

export interface SpotlightSelectionRejection {
  readonly reason: SpotlightSelectionRejectionReason;
  readonly symbol?: string;
  readonly message: string;
}

export interface SpotlightSelectionResult {
  readonly rationale?: string;
  readonly selected: readonly SelectedSpotlight[];
  readonly rejected: readonly SpotlightSelectionRejection[];
  readonly audit: {
    readonly cap: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly rejectedCount: number;
    readonly malformed: boolean;
  };
}

function alphaWatchlistPath(dataDir: string): string {
  const dataRoot = basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
  return join(dataRoot, "alpha-search", "watchlist.json");
}

function readLatestValidation(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const status = readString(entry, "status");
    const horizon = readNumber(entry, "horizonTradingDays");
    if (status === undefined || horizon === undefined) {
      return [];
    }
    return [`${String(horizon)}d:${status}`];
  });
}

export function parseAlphaWatchlistForSpotlights(
  value: unknown,
): SpotlightAlphaWatchlist | undefined {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    return undefined;
  }

  const generatedAt = readString(value, "generatedAt") ?? "";
  const candidates = value.candidates
    .map((item): SpotlightAlphaWatchlist["candidates"][number] | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const symbol = readString(item, "symbol")?.toUpperCase();
      const seenCount = readNumber(item, "seenCount");
      const lastSeenAt = readString(item, "lastSeenAt");
      const latestProfile = isRecord(item.latestProfile) ? item.latestProfile : {};
      if (symbol === undefined || seenCount === undefined || lastSeenAt === undefined) {
        return undefined;
      }
      const sourceGroup = readString(latestProfile, "sourceGroup");
      const socialRank = readNumber(latestProfile, "socialRank");
      const socialMomentumScore = readNumber(latestProfile, "socialMomentumScore");
      return {
        symbol,
        annotation: {
          seenCount,
          lastSeenAt,
          ...(sourceGroup !== undefined ? { sourceGroup } : {}),
          discoverySources: stringArrayValue(latestProfile.discoverySources),
          ...(socialRank !== undefined ? { socialRank } : {}),
          ...(socialMomentumScore !== undefined ? { socialMomentumScore } : {}),
          latestValidation: readLatestValidation(item.latestValidation),
        },
      };
    })
    .filter((item): item is SpotlightAlphaWatchlist["candidates"][number] => item !== undefined);

  return { generatedAt, candidates };
}

export async function loadAlphaWatchlistForSpotlights(dataDir: string): Promise<{
  readonly watchlist?: SpotlightAlphaWatchlist;
  readonly gap?: string;
}> {
  try {
    const parsed = JSON.parse(await readFile(alphaWatchlistPath(dataDir), "utf8")) as unknown;
    const watchlist = parseAlphaWatchlistForSpotlights(parsed);
    return watchlist === undefined
      ? { gap: "Malformed alpha-search watchlist ignored for spotlight enrichment" }
      : { watchlist };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {};
    }
    return { gap: "Unable to read alpha-search watchlist for spotlight enrichment" };
  }
}

function sourceIds(snapshot: MarketSnapshot): readonly string[] {
  return [
    snapshot.sourceId,
    ...(snapshot.benchmark === undefined ? [] : [snapshot.benchmark.sourceId]),
  ];
}

function historyForSymbol(
  symbol: string,
  historicalContext: HistoricalResearchContext | undefined,
): SpotlightCandidate["history"] {
  if (historicalContext === undefined) {
    return {
      tickerRunIds: [],
      marketRunIds: [],
    };
  }
  const normalized = symbol.toUpperCase();
  return {
    tickerRunIds: historicalContext.runs
      .filter((run) => run.jobType === "ticker" && run.symbol?.toUpperCase() === normalized)
      .map((run) => run.runId),
    marketRunIds: historicalContext.runs
      .filter((run) =>
        run.marketSnapshots.some((snapshot) => snapshot.symbol.toUpperCase() === normalized),
      )
      .map((run) => run.runId),
  };
}

export function buildSpotlightCandidates(input: {
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly historicalContext?: HistoricalResearchContext;
  readonly alphaWatchlist?: SpotlightAlphaWatchlist;
}): readonly SpotlightCandidate[] {
  const alphaBySymbol = new Map(
    (input.alphaWatchlist?.candidates ?? []).map((item) => [item.symbol, item.annotation]),
  );
  const seen = new Set<string>();

  return rankMovers(input.marketSnapshots, input.marketSnapshots.length)
    .map((mover): SpotlightCandidate | undefined => {
      const symbol = mover.snapshot.symbol.toUpperCase();
      if (seen.has(symbol)) {
        return undefined;
      }
      seen.add(symbol);
      const alpha = alphaBySymbol.get(symbol);
      return {
        id: `spotlight-${symbol}`,
        symbol,
        assetClass: mover.snapshot.assetClass,
        ...(mover.snapshot.name !== undefined ? { name: mover.snapshot.name } : {}),
        sourceIds: sourceIds(mover.snapshot),
        currentSnapshot: {
          price: mover.snapshot.price,
          changePercent24h: mover.snapshot.changePercent24h,
          volume: mover.snapshot.volume,
          ...(mover.snapshot.marketCap !== undefined
            ? { marketCap: mover.snapshot.marketCap }
            : {}),
          observedAt: mover.snapshot.observedAt,
        },
        ...(mover.snapshot.benchmark !== undefined
          ? {
              benchmark: {
                symbol: mover.snapshot.benchmark.symbol,
                changePercent24h: mover.snapshot.benchmark.changePercent24h,
                sourceId: mover.snapshot.benchmark.sourceId,
              },
            }
          : {}),
        mover: {
          rank: mover.rank,
          score: mover.score,
          features: mover.features,
        },
        history: historyForSymbol(symbol, input.historicalContext),
        ...(alpha !== undefined ? { alpha } : {}),
      };
    })
    .filter((candidate): candidate is SpotlightCandidate => candidate !== undefined);
}

function selectionArray(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Array.isArray(value.selections) ? value.selections : undefined;
}

function rejection(
  reason: SpotlightSelectionRejectionReason,
  message: string,
  symbol?: string,
): SpotlightSelectionRejection {
  return {
    reason,
    message,
    ...(symbol !== undefined ? { symbol } : {}),
  };
}

export function parseSpotlightSelection(
  content: string,
  candidates: readonly SpotlightCandidate[],
  cap: number,
): SpotlightSelectionResult {
  const normalizedCap = Math.max(0, cap);
  const candidateBySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
  const rejected: SpotlightSelectionRejection[] = [];
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    rejected.push(rejection("malformed-json", "Spotlight selector returned malformed JSON"));
    return {
      selected: [],
      rejected,
      audit: {
        cap: normalizedCap,
        candidateCount: candidates.length,
        selectedCount: 0,
        rejectedCount: rejected.length,
        malformed: true,
      },
    };
  }

  const selections = selectionArray(parsed);
  if (selections === undefined) {
    rejected.push(rejection("malformed-json", "Spotlight selector JSON must include selections[]"));
    return {
      selected: [],
      rejected,
      audit: {
        cap: normalizedCap,
        candidateCount: candidates.length,
        selectedCount: 0,
        rejectedCount: rejected.length,
        malformed: true,
      },
    };
  }

  const seen = new Set<string>();
  const selected: SelectedSpotlight[] = [];
  for (const item of selections) {
    if (!isRecord(item)) {
      rejected.push(rejection("malformed-selection", "Selection entry must be an object"));
      continue;
    }
    const symbol = readString(item, "symbol")?.toUpperCase();
    if (symbol === undefined) {
      rejected.push(rejection("malformed-selection", "Selection entry is missing symbol"));
      continue;
    }
    const candidate = candidateBySymbol.get(symbol);
    if (candidate === undefined) {
      rejected.push(rejection("unknown-symbol", `Unknown spotlight symbol ${symbol}`, symbol));
      continue;
    }
    if (seen.has(symbol)) {
      rejected.push(rejection("duplicate-symbol", `Duplicate spotlight symbol ${symbol}`, symbol));
      continue;
    }

    const sourceIdsRaw =
      item.sourceIds === undefined ? candidate.sourceIds : stringArrayValue(item.sourceIds);
    if (sourceIdsRaw.length === 0) {
      rejected.push(rejection("malformed-selection", "Selection entry has no sourceIds", symbol));
      continue;
    }
    const allowedSources = new Set(candidate.sourceIds);
    const unknownSource = sourceIdsRaw.find((sourceId) => !allowedSources.has(sourceId));
    if (unknownSource !== undefined) {
      rejected.push(
        rejection("unknown-source-id", `Unknown sourceId ${unknownSource} for ${symbol}`, symbol),
      );
      continue;
    }
    if (selected.length >= normalizedCap) {
      rejected.push(rejection("cap-overflow", `Spotlight cap exceeded for ${symbol}`, symbol));
      continue;
    }

    seen.add(symbol);
    selected.push({
      symbol,
      rationale: readString(item, "rationale") ?? "",
      sourceIds: [...new Set(sourceIdsRaw)],
      candidate,
    });
  }

  const rationale = isRecord(parsed) ? readString(parsed, "rationale") : undefined;
  return {
    ...(rationale !== undefined ? { rationale } : {}),
    selected,
    rejected,
    audit: {
      cap: normalizedCap,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      rejectedCount: rejected.length,
      malformed: false,
    },
  };
}
