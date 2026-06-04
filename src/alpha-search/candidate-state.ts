import type { ResearchReport } from "../domain/types";
import type { AlphaValidationFile, AlphaValidationHorizon } from "./validation";
import type { AlphaSearchDiscoverySource, AlphaSearchSecFiling } from "./candidates";
import { readAlphaSearchLeads } from "./report-extras";

export type AlphaCandidateSourceGroup = "apewisdom-only" | "sec-only" | "apewisdom+sec";

export interface AlphaCandidateProfile {
  readonly symbol: string;
  readonly name?: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly discoverySources: readonly AlphaSearchDiscoverySource[];
  readonly sourceGroup: AlphaCandidateSourceGroup;
  readonly sourceIds: readonly string[];
  readonly exchange: string;
  readonly price: number;
  readonly volume: number;
  readonly marketCap: number;
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly mentions?: number;
  readonly upvotes?: number;
  readonly secCik?: string;
  readonly secCompanyName?: string;
  readonly recentSecFilings?: readonly AlphaSearchSecFiling[];
}

export interface AlphaCandidateDelta {
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly priceChange?: number;
  readonly marketCapChange?: number;
  readonly socialRankChange?: number;
  readonly socialMomentumScoreChange?: number;
  readonly addedDiscoverySources: readonly AlphaSearchDiscoverySource[];
  readonly removedDiscoverySources: readonly AlphaSearchDiscoverySource[];
  readonly newSecFilings: readonly AlphaSearchSecFiling[];
}

export interface AlphaCandidateWatchlistItem {
  readonly symbol: string;
  readonly name?: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly seenCount: number;
  readonly runIds: readonly string[];
  readonly latestProfile: AlphaCandidateProfile;
  readonly delta?: AlphaCandidateDelta;
  readonly latestValidation: readonly AlphaValidationHorizon[];
}

export interface AlphaCandidateWatchlist {
  readonly generatedAt: string;
  readonly candidateCount: number;
  readonly candidates: readonly AlphaCandidateWatchlistItem[];
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sourceGroup(
  discoverySources: readonly AlphaSearchDiscoverySource[],
): AlphaCandidateSourceGroup {
  const sources = new Set(discoverySources);
  if (sources.has("apewisdom") && sources.has("sec-filings")) {
    return "apewisdom+sec";
  }
  if (sources.has("sec-filings")) {
    return "sec-only";
  }
  return "apewisdom-only";
}

function compareGeneratedAt(left: AlphaCandidateProfile, right: AlphaCandidateProfile): number {
  return left.generatedAt.localeCompare(right.generatedAt) || left.runId.localeCompare(right.runId);
}

function sourceDiff(
  left: readonly AlphaSearchDiscoverySource[],
  right: readonly AlphaSearchDiscoverySource[],
): readonly AlphaSearchDiscoverySource[] {
  const existing = new Set(left);
  return right.filter((source) => !existing.has(source));
}

function filingKey(filing: AlphaSearchSecFiling): string {
  return `${filing.form}:${filing.filingDate}:${filing.accessionNumber ?? ""}`;
}

function newSecFilings(
  previous: readonly AlphaSearchSecFiling[] | undefined,
  latest: readonly AlphaSearchSecFiling[] | undefined,
): readonly AlphaSearchSecFiling[] {
  const existing = new Set((previous ?? []).map((filing) => filingKey(filing)));
  return (latest ?? []).filter((filing) => !existing.has(filingKey(filing)));
}

function numericChange(
  previous: number | undefined,
  latest: number | undefined,
): number | undefined {
  if (previous === undefined || latest === undefined) {
    return undefined;
  }
  return roundMetric(latest - previous);
}

function buildDelta(
  previous: AlphaCandidateProfile | undefined,
  latest: AlphaCandidateProfile,
): AlphaCandidateDelta | undefined {
  if (previous === undefined) {
    return undefined;
  }

  const addedDiscoverySources = sourceDiff(previous.discoverySources, latest.discoverySources);
  const removedDiscoverySources = sourceDiff(latest.discoverySources, previous.discoverySources);
  const filings = newSecFilings(previous.recentSecFilings, latest.recentSecFilings);
  const priceChange = numericChange(previous.price, latest.price);
  const marketCapChange = numericChange(previous.marketCap, latest.marketCap);
  const socialRankChange = numericChange(previous.socialRank, latest.socialRank);
  const socialMomentumScoreChange = numericChange(
    previous.socialMomentumScore,
    latest.socialMomentumScore,
  );
  return {
    fromRunId: previous.runId,
    toRunId: latest.runId,
    ...(priceChange !== undefined ? { priceChange } : {}),
    ...(marketCapChange !== undefined ? { marketCapChange } : {}),
    ...(socialRankChange !== undefined ? { socialRankChange } : {}),
    ...(socialMomentumScoreChange !== undefined ? { socialMomentumScoreChange } : {}),
    addedDiscoverySources,
    removedDiscoverySources,
    newSecFilings: filings,
  };
}

export function buildAlphaCandidateProfiles(
  report: ResearchReport,
): readonly AlphaCandidateProfile[] {
  if (report.jobType !== "alpha-search") {
    return [];
  }

  return readAlphaSearchLeads(report.extras).map((lead) => ({
    symbol: lead.symbol,
    ...(lead.name !== undefined ? { name: lead.name } : {}),
    runId: report.runId,
    generatedAt: report.generatedAt,
    discoverySources: lead.discoverySources,
    sourceGroup: sourceGroup(lead.discoverySources),
    sourceIds: lead.sourceIds,
    exchange: lead.exchange,
    price: lead.price,
    volume: lead.volume,
    marketCap: lead.marketCap,
    ...(lead.socialRank !== undefined ? { socialRank: lead.socialRank } : {}),
    ...(lead.socialMomentumScore !== undefined
      ? { socialMomentumScore: lead.socialMomentumScore }
      : {}),
    ...(lead.mentions !== undefined ? { mentions: lead.mentions } : {}),
    ...(lead.upvotes !== undefined ? { upvotes: lead.upvotes } : {}),
    ...(lead.secCik !== undefined ? { secCik: lead.secCik } : {}),
    ...(lead.secCompanyName !== undefined ? { secCompanyName: lead.secCompanyName } : {}),
    ...(lead.recentSecFilings !== undefined ? { recentSecFilings: lead.recentSecFilings } : {}),
  }));
}

function latestValidationBySymbol(
  validations: readonly AlphaValidationFile[],
): ReadonlyMap<string, readonly AlphaValidationHorizon[]> {
  const bySymbol = new Map<
    string,
    {
      readonly generatedAt: string;
      readonly validatedAt: string;
      readonly horizons: readonly AlphaValidationHorizon[];
    }
  >();

  for (const validation of validations) {
    for (const lead of validation.leads) {
      const existing = bySymbol.get(lead.symbol);
      if (
        existing === undefined ||
        validation.generatedAt.localeCompare(existing.generatedAt) > 0 ||
        (validation.generatedAt === existing.generatedAt &&
          validation.validatedAt.localeCompare(existing.validatedAt) > 0)
      ) {
        bySymbol.set(lead.symbol, {
          generatedAt: validation.generatedAt,
          validatedAt: validation.validatedAt,
          horizons: lead.horizons,
        });
      }
    }
  }

  return new Map([...bySymbol.entries()].map(([symbol, entry]) => [symbol, entry.horizons]));
}

export function buildAlphaCandidateWatchlist(input: {
  readonly profiles: readonly AlphaCandidateProfile[];
  readonly validations?: readonly AlphaValidationFile[];
  readonly now?: Date;
}): AlphaCandidateWatchlist {
  const profilesBySymbol = new Map<string, AlphaCandidateProfile[]>();
  for (const profile of input.profiles) {
    profilesBySymbol.set(profile.symbol, [
      ...(profilesBySymbol.get(profile.symbol) ?? []),
      profile,
    ]);
  }

  const validationsBySymbol = latestValidationBySymbol(input.validations ?? []);
  const candidates = [...profilesBySymbol.entries()]
    .map(([symbol, profiles]) => {
      const sorted = profiles.toSorted(compareGeneratedAt);
      const latest = sorted.at(-1) as AlphaCandidateProfile;
      const previous = sorted.at(-2);
      const runIds = [...new Set(sorted.map((profile) => profile.runId))];
      const delta = buildDelta(previous, latest);
      return {
        symbol,
        ...(latest.name !== undefined ? { name: latest.name } : {}),
        firstSeenAt: (sorted[0] as AlphaCandidateProfile).generatedAt,
        lastSeenAt: latest.generatedAt,
        seenCount: sorted.length,
        runIds,
        latestProfile: latest,
        ...(delta !== undefined ? { delta } : {}),
        latestValidation: validationsBySymbol.get(symbol) ?? [],
      };
    })
    .toSorted(
      (left, right) =>
        right.lastSeenAt.localeCompare(left.lastSeenAt) || left.symbol.localeCompare(right.symbol),
    );

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    candidateCount: candidates.length,
    candidates,
  };
}

function markdownText(value: string): string {
  return value.replaceAll(/[\\[\]()*_#|<>]/gu, (char) => {
    if (char === "<") {
      return "&lt;";
    }
    if (char === ">") {
      return "&gt;";
    }
    return `${String.fromCodePoint(92)}${char}`;
  });
}

function validationSummary(horizons: readonly AlphaValidationHorizon[]): string {
  if (horizons.length === 0) {
    return "n/a";
  }
  return horizons
    .map((horizon) =>
      horizon.status === "resolved"
        ? `${String(horizon.horizonTradingDays)}d ${horizon.outcome} (${String(Math.round(horizon.excessReturn * 10_000) / 100)}%)`
        : `${String(horizon.horizonTradingDays)}d unresolved:${horizon.reason}`,
    )
    .join(", ");
}

function deltaSummary(delta: AlphaCandidateDelta | undefined): string {
  if (delta === undefined) {
    return "first sighting";
  }
  const parts = [
    delta.priceChange === undefined ? undefined : `price ${String(delta.priceChange)}`,
    delta.marketCapChange === undefined ? undefined : `market cap ${String(delta.marketCapChange)}`,
    delta.socialRankChange === undefined
      ? undefined
      : `social rank ${String(delta.socialRankChange)}`,
    delta.socialMomentumScoreChange === undefined
      ? undefined
      : `social score ${String(delta.socialMomentumScoreChange)}`,
    delta.addedDiscoverySources.length === 0
      ? undefined
      : `added sources ${delta.addedDiscoverySources.join(", ")}`,
    delta.newSecFilings.length === 0
      ? undefined
      : `new filings ${delta.newSecFilings.map((filing) => `${filing.form} ${filing.filingDate}`).join(", ")}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "no deterministic change" : parts.join("; ");
}

export function renderAlphaCandidateWatchlistMarkdown(watchlist: AlphaCandidateWatchlist): string {
  const rows =
    watchlist.candidates.length === 0
      ? ["_No alpha candidate profiles yet._"]
      : [
          "Symbol | Last seen | Seen | Sources | Delta | Latest validation",
          "--- | --- | ---: | --- | --- | ---",
          ...watchlist.candidates.map((candidate) =>
            [
              markdownText(candidate.symbol),
              candidate.lastSeenAt,
              String(candidate.seenCount),
              candidate.latestProfile.discoverySources.map(markdownText).join(", "),
              markdownText(deltaSummary(candidate.delta)),
              markdownText(validationSummary(candidate.latestValidation)),
            ].join(" | "),
          ),
        ];

  return [
    "# Alpha Candidate Watchlist",
    "",
    `Generated: ${watchlist.generatedAt}`,
    `Candidates: ${String(watchlist.candidateCount)}`,
    "",
    ...rows,
    "",
  ].join("\n");
}
