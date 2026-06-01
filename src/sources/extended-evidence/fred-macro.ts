import type { SourceGap } from "../../domain/types";
import {
  buildFredMacroMetrics,
  FRED_SERIES,
  fredObservationsUrl,
  isFredBaseMetricKey,
} from "../fred";
import { isFetchJsonResult, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";

export async function collectFred(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.fredApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
    };
  }
  const { fredApiKey } = ctx;
  const urls = FRED_SERIES.map((seriesId) => fredObservationsUrl(seriesId, fredApiKey, 2));
  const results = await Promise.all(
    urls.map((url, index) =>
      fetchOrGap(
        url,
        `fred-${FRED_SERIES[index]}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const metrics = buildFredMacroMetrics(
    fetched.map((result) => ({
      seriesId: result.rawSnapshot.adapter.replace("fred-", ""),
      payload: result.payload,
    })),
  );
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          collectedItem(
            "fred-macro",
            "FRED macro pack",
            `Latest FRED macro observations captured for ${Object.keys(metrics)
              .filter((key) => isFredBaseMetricKey(key))
              .join(", ")}.`,
            evidenceSource("extended-fred-macro", "FRED macro pack", "fred", command, fetchedAt),
            metrics,
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}
