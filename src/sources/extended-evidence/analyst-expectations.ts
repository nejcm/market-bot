import { isInstrumentCommand } from "../../cli/args";
import { sourceGap, sourceGapStatusCode } from "../../domain/source-gaps";
import type { Source, SourceGap } from "../../domain/types";
import { isRecord, readNumber, readString } from "../../guards";
import { isUsListing } from "../instrument-capability";
import { isFetchJsonResult, type CollectContext, type RawSourceSnapshot } from "../types";
import { collectedItem, evidenceSource, type CollectedItem, type ProviderResult } from "./common";
import { encodeQuery, readArray } from "./utils";

export type AnalystEstimateKind = "eps" | "revenue" | "ebitda";

export interface AnalystEstimateConsensus {
  readonly period?: string;
  readonly mean?: number;
  readonly median?: number;
  readonly high?: number;
  readonly low?: number;
  readonly count?: number;
}

export interface AnalystEstimateSeries {
  readonly provider: "finnhub";
  readonly consensus: readonly AnalystEstimateConsensus[];
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
}

export interface ExternalAnalystRangeDistribution {
  readonly mean?: number;
  readonly median?: number;
  readonly high?: number;
  readonly low?: number;
  readonly count?: number;
}

export interface AnalystExpectationsArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly estimates: {
    readonly eps?: AnalystEstimateSeries;
    readonly revenue?: AnalystEstimateSeries;
    readonly ebitda?: AnalystEstimateSeries;
  };
  readonly externalContext?: {
    readonly provider: "finnhub";
    readonly distribution: ExternalAnalystRangeDistribution;
    readonly sourceIds: readonly string[];
    readonly observedAt: string;
  };
}

export interface AnalystExpectationsSignal {
  readonly status: "available" | "forbidden" | "missing-credential";
  readonly sourceIds: readonly string[];
}

export interface AnalystExpectationsProviderResult extends ProviderResult {
  readonly artifact?: AnalystExpectationsArtifact;
  readonly signal: AnalystExpectationsSignal;
}

interface RouteDefinition {
  readonly adapter: string;
  readonly endpoint: string;
  readonly label: string;
  readonly kind?: AnalystEstimateKind;
}

const EPS_ROUTE: RouteDefinition = {
  adapter: "finnhub-eps-estimate",
  endpoint: "/stock/eps-estimate",
  label: "EPS estimate",
  kind: "eps",
};
const REVENUE_ROUTE: RouteDefinition = {
  adapter: "finnhub-revenue-estimate",
  endpoint: "/stock/revenue-estimate",
  label: "revenue estimate",
  kind: "revenue",
};
const EBITDA_ROUTE: RouteDefinition = {
  adapter: "finnhub-ebitda-estimate",
  endpoint: "/stock/ebitda-estimate",
  label: "EBITDA estimate",
  kind: "ebitda",
};
const CONTEXT_ROUTE: RouteDefinition = {
  adapter: "finnhub-analyst-range",
  endpoint: "/stock/price-target",
  label: "external analyst range",
};
const ROUTES: readonly RouteDefinition[] = [EPS_ROUTE, REVENUE_ROUTE, EBITDA_ROUTE, CONTEXT_ROUTE];

const ESTIMATE_ADAPTERS = new Set(
  ROUTES.flatMap((route) => (route.kind === undefined ? [] : [route.adapter])),
);

const FIELD_PREFIXES: Readonly<Record<AnalystEstimateKind, string>> = {
  eps: "eps",
  revenue: "revenue",
  ebitda: "ebitda",
};

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function distributionPresent(value: {
  readonly mean?: number;
  readonly median?: number;
  readonly high?: number;
  readonly low?: number;
  readonly count?: number;
}): boolean {
  return Object.values(value).some((entry) => typeof entry === "number");
}

export function parseEstimateConsensus(
  payload: unknown,
  kind: AnalystEstimateKind,
): readonly AnalystEstimateConsensus[] {
  const prefix = FIELD_PREFIXES[kind];
  const rows = Array.isArray(payload) ? payload : readArray(payload, "data");
  return rows.flatMap((row): readonly AnalystEstimateConsensus[] => {
    if (!isRecord(row)) {
      return [];
    }
    const period = readString(row, "period");
    const mean = firstNumber(row, [`${prefix}Avg`, `${prefix}Mean`, "mean", "avg"]);
    const median = firstNumber(row, [`${prefix}Median`, "median"]);
    const high = firstNumber(row, [`${prefix}High`, "high"]);
    const low = firstNumber(row, [`${prefix}Low`, "low"]);
    const count = firstNumber(row, ["numberAnalysts", "analystCount", "count"]);
    const consensus = {
      ...(period !== undefined ? { period } : {}),
      ...(mean !== undefined ? { mean } : {}),
      ...(median !== undefined ? { median } : {}),
      ...(high !== undefined ? { high } : {}),
      ...(low !== undefined ? { low } : {}),
      ...(count !== undefined ? { count } : {}),
    };
    return distributionPresent(consensus) ? [consensus] : [];
  });
}

export function parsePriceTargetDistribution(
  payload: unknown,
): ExternalAnalystRangeDistribution | undefined {
  if (!isRecord(payload)) {
    return;
  }
  const mean = firstNumber(payload, ["targetMean", "mean"]);
  const median = firstNumber(payload, ["targetMedian", "median"]);
  const high = firstNumber(payload, ["targetHigh", "high"]);
  const low = firstNumber(payload, ["targetLow", "low"]);
  const count = firstNumber(payload, ["numberAnalysts", "analystCount", "count"]);
  const distribution = {
    ...(mean !== undefined ? { mean } : {}),
    ...(median !== undefined ? { median } : {}),
    ...(high !== undefined ? { high } : {}),
    ...(low !== undefined ? { low } : {}),
    ...(count !== undefined ? { count } : {}),
  };
  return distributionPresent(distribution) ? distribution : undefined;
}

function routeSourceId(symbol: string, route: RouteDefinition): string {
  const suffix = route.kind ?? "context";
  return `extended-finnhub-analyst-${symbol.toLowerCase()}-${suffix}`;
}

function routeSource(context: CollectContext, route: RouteDefinition, observedAt: string): Source {
  if (!isInstrumentCommand(context.command)) {
    throw new Error("Analyst expectation evidence requires an instrument command");
  }
  const title =
    route.kind === undefined
      ? `${context.command.symbol} external analyst range context`
      : `${context.command.symbol} external ${route.label} consensus`;
  return evidenceSource(
    routeSourceId(context.command.symbol, route),
    title,
    "finnhub",
    context.command,
    observedAt,
  );
}

function normalizeGap(gap: SourceGap): SourceGap {
  if (sourceGapStatusCode(gap.message) !== "403") {
    return gap;
  }
  const route = ROUTES.find((candidate) => candidate.adapter === gap.source);
  return sourceGap({
    source: gap.source,
    message: `Finnhub ${route?.label ?? "analyst expectation"} endpoint is unavailable for the configured token (status 403)`,
    provider: "finnhub",
    capability: "extended-evidence",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function unavailableGaps(
  cause: "missing-credential" | "unsupported-coverage",
  message: (route: RouteDefinition) => string,
): readonly SourceGap[] {
  return ROUTES.map((route) =>
    sourceGap({
      source: route.adapter,
      message: message(route),
      provider: "finnhub",
      capability: "extended-evidence",
      cause,
      evidenceQualityImpact: "extended-evidence-cap",
    }),
  );
}

function estimateSeries(
  symbol: string,
  route: RouteDefinition,
  snapshot: RawSourceSnapshot | undefined,
): AnalystEstimateSeries | undefined {
  if (route.kind === undefined || snapshot === undefined) {
    return;
  }
  return {
    provider: "finnhub",
    consensus: parseEstimateConsensus(snapshot.payload, route.kind),
    sourceIds: [routeSourceId(symbol, route)],
    observedAt: snapshot.fetchedAt,
  };
}

function signalFrom(
  artifact: AnalystExpectationsArtifact | undefined,
  gaps: readonly SourceGap[],
): AnalystExpectationsSignal {
  const estimateGaps = gaps.filter((gap) => ESTIMATE_ADAPTERS.has(gap.source));
  if (estimateGaps.some((gap) => gap.cause === "missing-credential")) {
    return { status: "missing-credential", sourceIds: [] };
  }
  if (
    estimateGaps.some(
      (gap) => gap.cause === "unsupported-coverage" && sourceGapStatusCode(gap.message) === "403",
    )
  ) {
    return { status: "forbidden", sourceIds: [] };
  }
  return {
    status: "available",
    sourceIds: [
      ...(artifact?.estimates.eps?.sourceIds ?? []),
      ...(artifact?.estimates.revenue?.sourceIds ?? []),
      ...(artifact?.estimates.ebitda?.sourceIds ?? []),
    ],
  };
}

export function deriveAnalystExpectations(
  symbol: string,
  generatedAt: string,
  rawSnapshots: readonly RawSourceSnapshot[],
  gaps: readonly SourceGap[],
): {
  readonly artifact?: AnalystExpectationsArtifact;
  readonly signal: AnalystExpectationsSignal;
} {
  const snapshots = new Map(
    rawSnapshots
      .filter((snapshot) => ROUTES.some((route) => route.adapter === snapshot.adapter))
      .map((snapshot) => [snapshot.adapter, snapshot]),
  );
  const eps = estimateSeries(symbol, EPS_ROUTE, snapshots.get(EPS_ROUTE.adapter));
  const revenue = estimateSeries(symbol, REVENUE_ROUTE, snapshots.get(REVENUE_ROUTE.adapter));
  const ebitda = estimateSeries(symbol, EBITDA_ROUTE, snapshots.get(EBITDA_ROUTE.adapter));
  const contextSnapshot = snapshots.get(CONTEXT_ROUTE.adapter);
  const distribution =
    contextSnapshot === undefined
      ? undefined
      : parsePriceTargetDistribution(contextSnapshot.payload);
  const artifact =
    snapshots.size === 0
      ? undefined
      : {
          version: 1 as const,
          generatedAt,
          symbol,
          estimates: {
            ...(eps !== undefined ? { eps } : {}),
            ...(revenue !== undefined ? { revenue } : {}),
            ...(ebitda !== undefined ? { ebitda } : {}),
          },
          ...(distribution !== undefined && contextSnapshot !== undefined
            ? {
                externalContext: {
                  provider: "finnhub" as const,
                  distribution,
                  sourceIds: [routeSourceId(symbol, CONTEXT_ROUTE)],
                  observedAt: contextSnapshot.fetchedAt,
                },
              }
            : {}),
        };
  return { ...(artifact !== undefined ? { artifact } : {}), signal: signalFrom(artifact, gaps) };
}

function seriesMetrics(
  consensus: AnalystEstimateConsensus | undefined,
): Record<string, number | string> | undefined {
  if (consensus === undefined) {
    return;
  }
  return {
    ...(consensus.period !== undefined ? { period: consensus.period } : {}),
    ...(consensus.mean !== undefined ? { mean: consensus.mean } : {}),
    ...(consensus.median !== undefined ? { median: consensus.median } : {}),
    ...(consensus.high !== undefined ? { high: consensus.high } : {}),
    ...(consensus.low !== undefined ? { low: consensus.low } : {}),
    ...(consensus.count !== undefined ? { count: consensus.count } : {}),
  };
}

function evidenceItems(
  context: CollectContext,
  artifact: AnalystExpectationsArtifact | undefined,
): readonly CollectedItem[] {
  if (artifact === undefined || !isInstrumentCommand(context.command)) {
    return [];
  }
  const estimateItems = ROUTES.flatMap((route): readonly CollectedItem[] => {
    if (route.kind === undefined) {
      return [];
    }
    const series = artifact.estimates[route.kind];
    if (series === undefined) {
      return [];
    }
    const source = routeSource(context, route, series.observedAt);
    return [
      collectedItem(
        "analyst-estimates",
        source.title,
        `Finnhub returned ${String(series.consensus.length)} ${route.label} consensus ${series.consensus.length === 1 ? "record" : "records"}.`,
        source,
        seriesMetrics(series.consensus[0]),
      ),
    ];
  });
  if (artifact.externalContext === undefined) {
    return estimateItems;
  }
  const source = routeSource(context, CONTEXT_ROUTE, artifact.externalContext.observedAt);
  return [
    ...estimateItems,
    collectedItem(
      "analyst-estimate-context",
      source.title,
      "External analyst estimate range from Finnhub (context only, not market-bot authored).",
      source,
      { ...artifact.externalContext.distribution, provider: "finnhub" },
    ),
  ];
}

export async function collectAnalystExpectations(
  context: CollectContext,
): Promise<AnalystExpectationsProviderResult> {
  const { command } = context;
  if (
    !isInstrumentCommand(command) ||
    command.assetClass !== "equity" ||
    command.depth !== "deep"
  ) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [],
      signal: { status: "available", sourceIds: [] },
    };
  }
  if (!isUsListing(command.symbol, context.instrumentIdentity)) {
    const gaps = unavailableGaps(
      "unsupported-coverage",
      (route) => `Finnhub ${route.label} endpoint does not support ${command.symbol}`,
    );
    return {
      rawSnapshots: [],
      items: [],
      gaps,
      signal: { status: "available", sourceIds: [] },
    };
  }
  if (context.finnhubApiToken === undefined) {
    const gaps = unavailableGaps(
      "missing-credential",
      (route) => `MARKET_BOT_FINNHUB_API_TOKEN is not set for the Finnhub ${route.label} endpoint`,
    );
    return {
      rawSnapshots: [],
      items: [],
      gaps,
      signal: { status: "missing-credential", sourceIds: [] },
    };
  }

  const results = await Promise.all(
    ROUTES.map((route) =>
      context.request.json({
        url: `https://finnhub.io/api/v1${route.endpoint}?${encodeQuery({
          symbol: command.symbol,
          token: context.finnhubApiToken as string,
        })}`,
        adapter: route.adapter,
      }),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results
    .filter((result): result is SourceGap => !isFetchJsonResult(result))
    .map((gap) => normalizeGap(gap));
  const derived = deriveAnalystExpectations(
    command.symbol,
    context.fetchedAt,
    fetched.map((result) => result.rawSnapshot),
    gaps,
  );
  return {
    rawSnapshots: fetched.map((result) => result.rawSnapshot),
    items: evidenceItems(context, derived.artifact),
    gaps,
    ...(derived.artifact !== undefined ? { artifact: derived.artifact } : {}),
    signal: derived.signal,
  };
}
