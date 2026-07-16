import type { AlphaCandidateProfile } from "./candidate-state";
import type {
  AlphaValidationFile,
  AlphaValidationHorizon,
  AlphaValidationMetrics,
} from "./validation";

export type AlphaFeatureName =
  | "sourceGroup"
  | "price"
  | "volume"
  | "marketCap"
  | "socialRank"
  | "socialMomentumScore"
  | "mentions"
  | "upvotesPerMention"
  | "secFilingForm"
  | "revenueDeltaPercent"
  | "netIncome"
  | "operatingCashFlow"
  | "debtToMarketCap";

export interface AlphaFeatureAttributionBucket {
  readonly label: string;
  readonly horizons: Readonly<Record<string, AlphaValidationMetrics>>;
}

export interface AlphaFeatureAttributionFeature {
  readonly buckets: Readonly<Record<string, AlphaFeatureAttributionBucket>>;
}

export interface AlphaFeatureAttribution {
  readonly generatedAt: string;
  readonly benchmarkSymbol: string;
  readonly runCount: number;
  readonly profileCount: number;
  readonly validatedProfileCount: number;
  readonly features: Partial<Readonly<Record<AlphaFeatureName, AlphaFeatureAttributionFeature>>>;
}

interface MetricAccumulator {
  totalCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  outperformedCount: number;
  excessReturnTotal: number;
}

interface MatchedProfile {
  readonly profile: AlphaCandidateProfile;
  readonly horizons: readonly AlphaValidationHorizon[];
}

interface BucketAssignment {
  readonly feature: AlphaFeatureName;
  readonly key: string;
  readonly label: string;
}

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

function addHorizon(accumulator: MetricAccumulator, horizon: AlphaValidationHorizon): void {
  accumulator.totalCount += 1;
  if (horizon.status === "unresolved") {
    accumulator.unresolvedCount += 1;
    return;
  }

  accumulator.resolvedCount += 1;
  accumulator.excessReturnTotal += horizon.excessReturn;
  if (horizon.outcome === "outperformed") {
    accumulator.outperformedCount += 1;
  }
}

function validationKey(runId: string, symbol: string): string {
  return `${runId}:${symbol}`;
}

function validationByRunSymbol(
  validations: readonly AlphaValidationFile[],
): ReadonlyMap<string, readonly AlphaValidationHorizon[]> {
  const result = new Map<string, readonly AlphaValidationHorizon[]>();
  for (const validation of validations) {
    for (const lead of validation.leads) {
      result.set(validationKey(validation.runId, lead.symbol), lead.horizons);
    }
  }
  return result;
}

function numericBucket(
  feature: AlphaFeatureName,
  value: number | undefined,
  buckets: readonly (readonly [number, string, string])[],
  fallback: string,
): BucketAssignment {
  if (value === undefined) {
    return { feature, key: "missing", label: fallback };
  }

  const bucket = buckets.find(([limit]) => value < limit);
  if (bucket !== undefined) {
    return { feature, key: bucket[1], label: bucket[2] };
  }
  const last = buckets.at(-1);
  return last === undefined
    ? { feature, key: "present", label: "present" }
    : { feature, key: last[1], label: last[2] };
}

function signedBucket(
  feature: AlphaFeatureName,
  value: number | undefined,
  missingLabel: string,
): BucketAssignment {
  if (value === undefined) {
    return { feature, key: "missing", label: missingLabel };
  }
  return value < 0
    ? { feature, key: "negative", label: "negative" }
    : { feature, key: "nonnegative", label: "nonnegative" };
}

function socialMomentumScoreBucket(profile: AlphaCandidateProfile): BucketAssignment {
  const bucket = numericBucket(
    "socialMomentumScore",
    profile.socialMomentumScore,
    [
      [50, "lt-50", "< 50"],
      [75, "50-to-75", "50-75"],
      [Number.POSITIVE_INFINITY, "gte-75", ">= 75"],
    ],
    "social score missing",
  );
  if (bucket.key === "missing") {
    return bucket;
  }
  const version = profile.socialScoringVersion ?? 1;
  return {
    ...bucket,
    key: `v${String(version)}:${bucket.key}`,
    label: `v${String(version)}:${bucket.label}`,
  };
}

function profileBuckets(profile: AlphaCandidateProfile): readonly BucketAssignment[] {
  const upvotesPerMention =
    profile.upvotes === undefined || profile.mentions === undefined
      ? undefined
      : profile.upvotes / Math.max(1, profile.mentions);
  const secFilingForms =
    profile.recentSecFilings === undefined
      ? []
      : [...new Set(profile.recentSecFilings.map((filing) => filing.form))];
  const fundamentals = profile.fundamentals?.metrics;
  const debtToMarketCap =
    fundamentals?.debt === undefined || profile.marketCap <= 0
      ? undefined
      : fundamentals.debt / profile.marketCap;
  return [
    { feature: "sourceGroup", key: profile.sourceGroup, label: profile.sourceGroup },
    numericBucket(
      "price",
      profile.price,
      [
        [5, "lt-5", "< $5"],
        [20, "5-to-20", "$5-$20"],
        [Number.POSITIVE_INFINITY, "gte-20", ">= $20"],
      ],
      "price missing",
    ),
    numericBucket(
      "volume",
      profile.volume,
      [
        [500_000, "lt-500k", "< 500k"],
        [2_000_000, "500k-to-2m", "500k-2m"],
        [Number.POSITIVE_INFINITY, "gte-2m", ">= 2m"],
      ],
      "volume missing",
    ),
    numericBucket(
      "marketCap",
      profile.marketCap,
      [
        [300_000_000, "lt-300m", "< $300M"],
        [2_000_000_000, "300m-to-2b", "$300M-$2B"],
        [Number.POSITIVE_INFINITY, "gte-2b", ">= $2B"],
      ],
      "market cap missing",
    ),
    numericBucket(
      "socialRank",
      profile.socialRank,
      [
        [11, "1-to-10", "1-10"],
        [26, "11-to-25", "11-25"],
        [Number.POSITIVE_INFINITY, "gte-26", ">= 26"],
      ],
      "social rank missing",
    ),
    socialMomentumScoreBucket(profile),
    numericBucket(
      "mentions",
      profile.mentions,
      [
        [100, "lt-100", "< 100"],
        [1000, "100-to-1k", "100-1k"],
        [Number.POSITIVE_INFINITY, "gte-1k", ">= 1k"],
      ],
      "mentions missing",
    ),
    numericBucket(
      "upvotesPerMention",
      upvotesPerMention,
      [
        [1, "lt-1", "< 1"],
        [5, "1-to-5", "1-5"],
        [Number.POSITIVE_INFINITY, "gte-5", ">= 5"],
      ],
      "upvotes/mention missing",
    ),
    ...(secFilingForms.length === 0
      ? [{ feature: "secFilingForm" as const, key: "missing", label: "SEC filing missing" }]
      : secFilingForms.map((form) => ({
          feature: "secFilingForm" as const,
          key: form,
          label: form,
        }))),
    numericBucket(
      "revenueDeltaPercent",
      fundamentals?.revenueDeltaPercent,
      [
        [0, "negative", "< 0%"],
        [20, "0-to-20", "0%-20%"],
        [Number.POSITIVE_INFINITY, "gte-20", ">= 20%"],
      ],
      "revenue delta missing",
    ),
    signedBucket("netIncome", fundamentals?.netIncome, "net income missing"),
    signedBucket(
      "operatingCashFlow",
      fundamentals?.operatingCashFlow,
      "operating cash flow missing",
    ),
    numericBucket(
      "debtToMarketCap",
      debtToMarketCap,
      [
        [0.25, "lt-25pct", "< 25%"],
        [0.75, "25-to-75pct", "25%-75%"],
        [Number.POSITIVE_INFINITY, "gte-75pct", ">= 75%"],
      ],
      "debt/market cap missing",
    ),
  ];
}

function matchedProfiles(input: {
  readonly profiles: readonly AlphaCandidateProfile[];
  readonly validations: readonly AlphaValidationFile[];
}): readonly MatchedProfile[] {
  const validations = validationByRunSymbol(input.validations);
  return input.profiles.flatMap((profile) => {
    const horizons = validations.get(validationKey(profile.runId, profile.symbol));
    return horizons === undefined ? [] : [{ profile, horizons }];
  });
}

function emptyFeatureMap(): Map<
  AlphaFeatureName,
  Map<string, { readonly label: string; readonly horizons: Map<number, MetricAccumulator> }>
> {
  return new Map();
}

function addFeatureHorizon(
  features: ReturnType<typeof emptyFeatureMap>,
  assignment: BucketAssignment,
  horizon: AlphaValidationHorizon,
): void {
  const feature = features.get(assignment.feature) ?? new Map();
  const bucket = feature.get(assignment.key) ?? {
    label: assignment.label,
    horizons: new Map<number, MetricAccumulator>(),
  };
  const accumulator = bucket.horizons.get(horizon.horizonTradingDays) ?? emptyAccumulator();
  addHorizon(accumulator, horizon);
  bucket.horizons.set(horizon.horizonTradingDays, accumulator);
  feature.set(assignment.key, bucket);
  features.set(assignment.feature, feature);
}

function featureMapToRecord(
  features: ReturnType<typeof emptyFeatureMap>,
): AlphaFeatureAttribution["features"] {
  return Object.fromEntries(
    [...features.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([feature, buckets]) => [
        feature,
        {
          buckets: Object.fromEntries(
            [...buckets.entries()]
              .toSorted(([left], [right]) => left.localeCompare(right))
              .map(([bucket, value]) => [
                bucket,
                {
                  label: value.label,
                  horizons: Object.fromEntries(
                    [...value.horizons.entries()]
                      .toSorted(([left], [right]) => left - right)
                      .map(([horizon, accumulator]) => [
                        String(horizon),
                        metricFromAccumulator(accumulator),
                      ]),
                  ),
                },
              ]),
          ),
        },
      ]),
  );
}

export function buildAlphaFeatureAttribution(input: {
  readonly profiles: readonly AlphaCandidateProfile[];
  readonly validations: readonly AlphaValidationFile[];
  readonly now?: Date;
}): AlphaFeatureAttribution {
  const matched = matchedProfiles(input);
  const features = emptyFeatureMap();
  for (const item of matched) {
    const buckets = profileBuckets(item.profile);
    for (const horizon of item.horizons) {
      for (const bucket of buckets) {
        addFeatureHorizon(features, bucket, horizon);
      }
    }
  }

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    benchmarkSymbol:
      input.validations.find((validation) => validation.benchmarkSymbol !== "")?.benchmarkSymbol ??
      "IWM",
    runCount: new Set(input.profiles.map((profile) => profile.runId)).size,
    profileCount: input.profiles.length,
    validatedProfileCount: matched.length,
    features: featureMapToRecord(features),
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

function formatRate(value: number | undefined): string {
  return value === undefined ? "n/a" : `${String(Math.round(value * 1000) / 10)}%`;
}

function formatReturn(value: number | undefined): string {
  return value === undefined ? "n/a" : `${String(Math.round(value * 10_000) / 100)}%`;
}

function attributionRows(attribution: AlphaFeatureAttribution): readonly string[] {
  return Object.entries(attribution.features)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([feature, value]) =>
      Object.entries(value.buckets)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([bucket, bucketValue]) =>
          Object.entries(bucketValue.horizons)
            .toSorted(([left], [right]) => Number(left) - Number(right))
            .map(([horizon, metric]) =>
              [
                markdownText(feature),
                markdownText(bucketValue.label),
                markdownText(bucket),
                horizon,
                String(metric.totalCount),
                String(metric.resolvedCount),
                String(metric.unresolvedCount),
                formatRate(metric.hitRate),
                formatReturn(metric.averageExcessReturn),
              ].join(" | "),
            ),
        ),
    );
}

export function renderAlphaFeatureAttributionMarkdown(
  attribution: AlphaFeatureAttribution,
): string {
  const rows = attributionRows(attribution);
  return [
    "# Alpha Feature Attribution",
    "",
    `Generated: ${attribution.generatedAt}`,
    `Benchmark: ${attribution.benchmarkSymbol}`,
    `Runs: ${String(attribution.runCount)}`,
    `Profiles: ${String(attribution.profileCount)}`,
    `Validated profiles: ${String(attribution.validatedProfileCount)}`,
    "",
    ...(rows.length === 0
      ? ["_No alpha feature attribution outcomes yet._"]
      : [
          "Feature | Bucket | Bucket key | Horizon | Total | Resolved | Unresolved | Hit rate | Avg excess return",
          "--- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---:",
          ...rows,
        ]),
    "",
  ].join("\n");
}
