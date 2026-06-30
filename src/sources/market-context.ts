import {
  isMarketUpdateJobType,
  type MarketContext,
  type Source,
  type SourceGap,
} from "../domain/types";
import { marketContextGap, sourceGap } from "../domain/source-gaps";
import {
  buildFredMacroMetrics,
  FRED_SERIES,
  fredObservationsUrl,
  isFredBaseMetricKey,
} from "./fred";
import {
  isFetchJsonResult,
  latestRawSnapshotFetchedAt,
  type CollectContext,
  type MarketContextAdapter,
  type MarketContextCollectionResult,
  type RawSourceSnapshot,
} from "./types";

function marketContextSource(ctx: CollectContext, fetchedAt: string): Source {
  return {
    id: "market-context-fred-macro",
    title: "FRED macro Market Context",
    fetchedAt,
    kind: "market-context",
    assetClass: ctx.command.assetClass,
    provider: "fred",
  };
}

function emptyMarketContext(ctx: CollectContext, gaps: readonly SourceGap[]): MarketContext {
  return {
    assetClass: ctx.command.assetClass,
    items: [],
    gaps: gaps.map((gap) => marketContextGap(gap)),
  };
}

async function collectFredMarketContext(
  ctx: CollectContext,
): Promise<MarketContextCollectionResult> {
  if (!isMarketUpdateJobType(ctx.command.jobType)) {
    return { rawSnapshots: [], sources: [], sourceGaps: [] };
  }
  if (ctx.command.assetClass === "crypto") {
    return { rawSnapshots: [], sources: [], sourceGaps: [] };
  }
  if (ctx.fredApiKey === undefined) {
    const gaps = [
      sourceGap({
        source: "fred-macro",
        message: "MARKET_BOT_FRED_API_KEY is not set",
        provider: "fred",
        capability: "market-context",
        cause: "missing-credential",
        evidenceQualityImpact: "no-cap",
      }),
    ];
    return {
      rawSnapshots: [],
      marketContext: emptyMarketContext(ctx, gaps),
      sources: [],
      sourceGaps: gaps,
    };
  }

  const { fredApiKey } = ctx;
  const results = await Promise.all(
    FRED_SERIES.map((seriesId) =>
      ctx.request.json({
        url: fredObservationsUrl(seriesId, fredApiKey, 2),
        adapter: `fred-${seriesId}`,
      }),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results
    .filter((result): result is SourceGap => !isFetchJsonResult(result))
    .map((gap) => marketContextGap(gap));
  const metrics = buildFredMacroMetrics(
    fetched.map((result) => ({
      seriesId: result.rawSnapshot.adapter.replace("fred-", ""),
      payload: result.payload,
    })),
  );
  const outputFetchedAt = latestRawSnapshotFetchedAt(
    fetched.map((result) => result.rawSnapshot),
    ctx.fetchedAt,
  );
  const source = marketContextSource(ctx, outputFetchedAt);
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          {
            category: "fred-macro" as const,
            title: "FRED macro Market Context",
            summary: `Latest FRED macro observations captured for ${Object.keys(metrics)
              .filter((key) => isFredBaseMetricKey(key))
              .join(", ")}.`,
            sourceIds: [source.id],
            observedAt: outputFetchedAt,
            metrics,
          },
        ];

  return {
    rawSnapshots: fetched.map((result): RawSourceSnapshot => result.rawSnapshot),
    marketContext: {
      assetClass: ctx.command.assetClass,
      items,
      gaps,
    },
    sources: items.length === 0 ? [] : [source],
    sourceGaps: gaps,
  };
}

export const marketContextAdapter: MarketContextAdapter = {
  name: "market-context",
  collect: collectFredMarketContext,
};
