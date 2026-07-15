import { isRecord, readNumber, readString, readStringArray } from "../guards";
import { isAlphaCandidateProfile, type AlphaCandidateWatchlist } from "./candidate-state";
import { isAlphaSearchRejectedCandidate, type AlphaSearchRejectedCandidate } from "./report-extras";
import type {
  AlphaValidationFile,
  AlphaValidationHorizon,
  AlphaValidationMetrics,
} from "./validation";

export interface AlphaRejectedCandidateCohort {
  readonly reason: string;
  readonly rejectedCount: number;
  readonly uniqueSymbolCount: number;
  readonly laterValidatedSymbolCount: number;
  readonly discoverySources: Readonly<Record<string, number>>;
  readonly validation: Readonly<Record<string, AlphaValidationMetrics>>;
}

export interface AlphaStaleLeadCohort {
  readonly ageBucket: string;
  readonly unbriefedLeadCount: number;
  readonly validation: Readonly<Record<string, AlphaValidationMetrics>>;
}

export interface AlphaLeadCohortSummary {
  readonly generatedAt: string;
  readonly benchmarkSymbol: string;
  readonly rejectedCandidateCount: number;
  readonly rejectedUniqueSymbolCount: number;
  readonly watchlistCandidateCount: number;
  readonly tickerBriefedLeadCount: number;
  readonly unbriefedLeadCount: number;
  readonly rejectionBuckets: readonly AlphaRejectedCandidateCohort[];
  readonly staleLeadDecay: readonly AlphaStaleLeadCohort[];
}

interface MetricAccumulator {
  totalCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  outperformedCount: number;
  excessReturnTotal: number;
}

const STALE_BUCKETS = [
  { label: "0-7d", maxDays: 7 },
  { label: "8-30d", maxDays: 30 },
  { label: "31+d", maxDays: Number.POSITIVE_INFINITY },
] as const;

function emptyAccumulator(): MetricAccumulator {
  return {
    totalCount: 0,
    resolvedCount: 0,
    unresolvedCount: 0,
    outperformedCount: 0,
    excessReturnTotal: 0,
  };
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function metricFromAccumulator(accumulator: MetricAccumulator): AlphaValidationMetrics {
  return {
    totalCount: accumulator.totalCount,
    resolvedCount: accumulator.resolvedCount,
    unresolvedCount: accumulator.unresolvedCount,
    outperformedCount: accumulator.outperformedCount,
    ...(accumulator.resolvedCount > 0
      ? {
          hitRate: roundMetric(accumulator.outperformedCount / accumulator.resolvedCount),
          averageExcessReturn: roundMetric(
            accumulator.excessReturnTotal / accumulator.resolvedCount,
          ),
        }
      : {}),
  };
}

function addHorizon(target: Map<number, MetricAccumulator>, horizon: AlphaValidationHorizon): void {
  const current = target.get(horizon.horizonTradingDays) ?? emptyAccumulator();
  current.totalCount += 1;
  if (horizon.status === "unresolved") {
    current.unresolvedCount += 1;
  } else {
    current.resolvedCount += 1;
    current.excessReturnTotal += horizon.excessReturn;
    if (horizon.outcome === "outperformed") {
      current.outperformedCount += 1;
    }
  }
  target.set(horizon.horizonTradingDays, current);
}

function metricsByHorizon(
  horizons: readonly AlphaValidationHorizon[],
): Readonly<Record<string, AlphaValidationMetrics>> {
  const accumulators = new Map<number, MetricAccumulator>();
  for (const horizon of horizons) {
    addHorizon(accumulators, horizon);
  }
  return Object.fromEntries(
    [...accumulators.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([horizon, accumulator]) => [String(horizon), metricFromAccumulator(accumulator)]),
  );
}

function horizonsBySymbol(
  validations: readonly AlphaValidationFile[],
): ReadonlyMap<string, readonly AlphaValidationHorizon[]> {
  const result = new Map<string, readonly AlphaValidationHorizon[]>();
  for (const validation of validations) {
    for (const lead of validation.leads) {
      result.set(lead.symbol, [...(result.get(lead.symbol) ?? []), ...lead.horizons]);
    }
  }
  return result;
}

function countByDiscoverySource(
  candidates: readonly AlphaSearchRejectedCandidate[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    for (const source of candidate.discoverySources) {
      counts[source] = (counts[source] ?? 0) + 1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function buildRejectionBuckets(
  rejectedCandidates: readonly AlphaSearchRejectedCandidate[],
  validationBySymbol: ReadonlyMap<string, readonly AlphaValidationHorizon[]>,
): readonly AlphaRejectedCandidateCohort[] {
  const byReason = new Map<string, AlphaSearchRejectedCandidate[]>();
  for (const candidate of rejectedCandidates) {
    byReason.set(candidate.reason, [...(byReason.get(candidate.reason) ?? []), candidate]);
  }

  return [...byReason.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([reason, candidates]) => {
      const symbols = [...new Set(candidates.map((candidate) => candidate.symbol))];
      const horizons = symbols.flatMap((symbol) => validationBySymbol.get(symbol) ?? []);
      return {
        reason,
        rejectedCount: candidates.length,
        uniqueSymbolCount: symbols.length,
        laterValidatedSymbolCount: symbols.filter((symbol) => validationBySymbol.has(symbol))
          .length,
        discoverySources: countByDiscoverySource(candidates),
        validation: metricsByHorizon(horizons),
      };
    });
}

function daysBetween(fromIso: string, to: Date): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) {
    return 0;
  }
  return Math.max(0, Math.floor((to.getTime() - from) / (24 * 60 * 60 * 1000)));
}

function staleBucket(days: number): string {
  return STALE_BUCKETS.find((bucket) => days <= bucket.maxDays)?.label ?? "31+d";
}

function buildStaleLeadDecay(input: {
  readonly watchlist: AlphaCandidateWatchlist | undefined;
  readonly tickerBriefSymbols: ReadonlySet<string>;
  readonly validationBySymbol: ReadonlyMap<string, readonly AlphaValidationHorizon[]>;
  readonly now: Date;
}): readonly AlphaStaleLeadCohort[] {
  const { watchlist } = input;
  if (watchlist === undefined) {
    return [];
  }

  const byBucket = new Map<string, string[]>();
  for (const candidate of watchlist.candidates) {
    if (input.tickerBriefSymbols.has(candidate.symbol)) {
      continue;
    }
    const bucket = staleBucket(daysBetween(candidate.firstSeenAt, input.now));
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), candidate.symbol]);
  }

  return STALE_BUCKETS.flatMap((bucket) => {
    const symbols = byBucket.get(bucket.label) ?? [];
    if (symbols.length === 0) {
      return [];
    }
    const horizons = symbols.flatMap((symbol) => input.validationBySymbol.get(symbol) ?? []);
    return [
      {
        ageBucket: bucket.label,
        unbriefedLeadCount: symbols.length,
        validation: metricsByHorizon(horizons),
      },
    ];
  });
}

export function buildAlphaLeadCohortSummary(input: {
  readonly rejectedCandidates: readonly AlphaSearchRejectedCandidate[];
  readonly validations: readonly AlphaValidationFile[];
  readonly watchlist?: AlphaCandidateWatchlist;
  readonly tickerBriefSymbols?: ReadonlySet<string>;
  readonly now?: Date;
}): AlphaLeadCohortSummary {
  const now = input.now ?? new Date();
  const validationBySymbol = horizonsBySymbol(input.validations);
  const tickerBriefSymbols = input.tickerBriefSymbols ?? new Set<string>();
  const watchlistCandidates = input.watchlist?.candidates ?? [];
  const unbriefedLeadCount = watchlistCandidates.filter(
    (candidate) => !tickerBriefSymbols.has(candidate.symbol),
  ).length;

  return {
    generatedAt: now.toISOString(),
    benchmarkSymbol:
      input.validations.find((validation) => validation.benchmarkSymbol !== "")?.benchmarkSymbol ??
      "IWM",
    rejectedCandidateCount: input.rejectedCandidates.length,
    rejectedUniqueSymbolCount: new Set(
      input.rejectedCandidates.map((candidate) => candidate.symbol),
    ).size,
    watchlistCandidateCount: watchlistCandidates.length,
    tickerBriefedLeadCount: watchlistCandidates.length - unbriefedLeadCount,
    unbriefedLeadCount,
    rejectionBuckets: buildRejectionBuckets(input.rejectedCandidates, validationBySymbol),
    staleLeadDecay: buildStaleLeadDecay({
      watchlist: input.watchlist,
      tickerBriefSymbols,
      validationBySymbol,
      now,
    }),
  };
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatReturn(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function cohortMetricText(metrics: Readonly<Record<string, AlphaValidationMetrics>>): string {
  const rows = Object.entries(metrics)
    .toSorted(([left], [right]) => Number(left) - Number(right))
    .map(
      ([horizon, metric]) =>
        `${horizon}d ${formatRate(metric.hitRate)} hit, ${formatReturn(metric.averageExcessReturn)} avg excess (n=${String(metric.resolvedCount)})`,
    );
  return rows.length === 0 ? "n/a" : rows.join("; ");
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

export function renderAlphaLeadCohortMarkdown(summary: AlphaLeadCohortSummary): string {
  const rejectionRows =
    summary.rejectionBuckets.length === 0
      ? ["_No rejected candidates captured yet._"]
      : [
          "Reason | Rejected | Unique symbols | Later validated | Validation",
          "--- | ---: | ---: | ---: | ---",
          ...summary.rejectionBuckets.map((bucket) =>
            [
              markdownText(bucket.reason),
              String(bucket.rejectedCount),
              String(bucket.uniqueSymbolCount),
              String(bucket.laterValidatedSymbolCount),
              markdownText(cohortMetricText(bucket.validation)),
            ].join(" | "),
          ),
        ];
  const staleRows =
    summary.staleLeadDecay.length === 0
      ? ["_No unbriefed lead cohorts yet._"]
      : [
          "Age bucket | Unbriefed leads | Validation",
          "--- | ---: | ---",
          ...summary.staleLeadDecay.map((bucket) =>
            [
              bucket.ageBucket,
              String(bucket.unbriefedLeadCount),
              markdownText(cohortMetricText(bucket.validation)),
            ].join(" | "),
          ),
        ];

  return [
    "# Alpha Lead Cohorts",
    "",
    `Generated: ${summary.generatedAt}`,
    `Benchmark: ${summary.benchmarkSymbol}`,
    `Rejected candidates: ${String(summary.rejectedCandidateCount)}`,
    `Watchlist candidates: ${String(summary.watchlistCandidateCount)}`,
    `Ticker-briefed leads: ${String(summary.tickerBriefedLeadCount)}`,
    `Unbriefed leads: ${String(summary.unbriefedLeadCount)}`,
    "",
    "## Rejection Buckets",
    "",
    ...rejectionRows,
    "",
    "## Stale Lead Decay",
    "",
    ...staleRows,
    "",
  ].join("\n");
}

export function readAlphaRejectedCandidateFile(
  value: unknown,
): readonly AlphaSearchRejectedCandidate[] {
  return Array.isArray(value)
    ? value.filter((candidate) => isAlphaSearchRejectedCandidate(candidate))
    : [];
}

function isAlphaValidationHorizon(value: unknown): value is AlphaValidationHorizon {
  if (!isRecord(value)) {
    return false;
  }
  const status = readString(value, "status");
  const horizonTradingDays = readNumber(value, "horizonTradingDays");
  const benchmarkSymbol = readString(value, "benchmarkSymbol");
  if (horizonTradingDays === undefined || benchmarkSymbol === undefined) {
    return false;
  }
  if (status === "unresolved") {
    return readString(value, "reason") !== undefined;
  }
  return (
    status === "resolved" &&
    readNumber(value, "candidateClose0") !== undefined &&
    readNumber(value, "candidateCloseN") !== undefined &&
    readNumber(value, "benchmarkClose0") !== undefined &&
    readNumber(value, "benchmarkCloseN") !== undefined &&
    readString(value, "candidateDate0") !== undefined &&
    readString(value, "candidateDateN") !== undefined &&
    readString(value, "benchmarkDate0") !== undefined &&
    readString(value, "benchmarkDateN") !== undefined &&
    readNumber(value, "candidateReturn") !== undefined &&
    readNumber(value, "benchmarkReturn") !== undefined &&
    readNumber(value, "excessReturn") !== undefined &&
    (value.outcome === "outperformed" || value.outcome === "did-not-outperform")
  );
}

function readLatestValidation(value: unknown): readonly AlphaValidationHorizon[] {
  return Array.isArray(value) ? value.filter((entry) => isAlphaValidationHorizon(entry)) : [];
}

export function readAlphaCandidateWatchlist(value: unknown): AlphaCandidateWatchlist | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const generatedAt = readString(value, "generatedAt");
  const candidateCount = readNumber(value, "candidateCount");
  const { candidates } = value;
  if (generatedAt === undefined || candidateCount === undefined || !Array.isArray(candidates)) {
    return undefined;
  }

  return {
    generatedAt,
    candidateCount,
    candidates: candidates.flatMap((candidate) => {
      if (!isRecord(candidate) || !isRecord(candidate.latestProfile)) {
        return [];
      }
      const symbol = readString(candidate, "symbol");
      const firstSeenAt = readString(candidate, "firstSeenAt");
      const lastSeenAt = readString(candidate, "lastSeenAt");
      const seenCount = readNumber(candidate, "seenCount");
      const runIds = readStringArray(candidate, "runIds");
      const { latestProfile } = candidate;
      if (
        symbol === undefined ||
        firstSeenAt === undefined ||
        lastSeenAt === undefined ||
        seenCount === undefined ||
        runIds === undefined ||
        !isAlphaCandidateProfile(latestProfile)
      ) {
        return [];
      }
      return [
        {
          symbol,
          firstSeenAt,
          lastSeenAt,
          seenCount,
          runIds,
          latestProfile,
          latestValidation: readLatestValidation(candidate.latestValidation),
        },
      ];
    }),
  };
}
