import {
  isMarketUpdateJobType,
  type MarketContext,
  type Source,
  type SourceGap,
} from "../domain/types";
import { buildFredMacroMetrics, FRED_SERIES, fredObservationsUrl } from "./fred";
import {
  isFetchJsonResult,
  type CollectContext,
  type MarketContextAdapter,
  type MarketContextCollectionResult,
  type RawSourceSnapshot,
} from "./types";

function marketContextSource(ctx: CollectContext): Source {
  return {
    id: "market-context-fred-macro",
    title: "FRED macro Market Context",
    fetchedAt: ctx.fetchedAt,
    kind: "market-context",
    assetClass: ctx.command.assetClass,
    provider: "fred",
  };
}

function emptyMarketContext(ctx: CollectContext, gaps: readonly SourceGap[]): MarketContext {
  return {
    assetClass: ctx.command.assetClass,
    items: [],
    gaps,
  };
}

async function collectFredMarketContext(
  ctx: CollectContext,
): Promise<MarketContextCollectionResult> {
  if (!isMarketUpdateJobType(ctx.command.jobType)) {
    return { rawSnapshots: [], sources: [], sourceGaps: [] };
  }
  if (ctx.fredApiKey === undefined) {
    const gaps = [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }];
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
      ctx.fetchOrGap(
        fredObservationsUrl(seriesId, fredApiKey, 2),
        `fred-${seriesId}`,
        ctx.fetchedAt,
        ctx.sourceTimeoutMs,
        ctx.fetchImpl,
        ctx.retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((result): result is SourceGap => !isFetchJsonResult(result));
  const metrics = buildFredMacroMetrics(
    fetched.map((result) => ({
      seriesId: result.rawSnapshot.adapter.replace("fred-", ""),
      payload: result.payload,
    })),
  );
  const source = marketContextSource(ctx);
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          {
            category: "fred-macro" as const,
            title: "FRED macro Market Context",
            summary: `Latest FRED macro observations captured for ${Object.keys(metrics)
              .filter(
                (key) => !key.endsWith("Change") && !key.endsWith("Date") && !key.endsWith("Prior"),
              )
              .join(", ")}.`,
            sourceIds: [source.id],
            observedAt: ctx.fetchedAt,
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
