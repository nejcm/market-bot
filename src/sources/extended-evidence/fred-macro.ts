import type { SourceGap } from "../../domain/types";
import { isInstrumentCommand } from "../../cli/args";
import { sourceGap } from "../../domain/source-gaps";
import {
  buildFredMacroMetrics,
  FRED_SERIES,
  fredObservationsUrl,
  isFredBaseMetricKey,
} from "../fred";
import { isFetchJsonResult, latestRawSnapshotFetchedAt, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";

export async function collectFred(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.fredApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "fred-macro",
          message: "MARKET_BOT_FRED_API_KEY is not set",
          provider: "fred",
          capability: "extended-evidence",
          cause: "missing-credential",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  const { fredApiKey } = ctx;
  const urls = FRED_SERIES.map((seriesId) => fredObservationsUrl(seriesId, fredApiKey, 2));
  const results = await Promise.all(
    urls.map((url, index) =>
      ctx.request.json({
        url,
        adapter: `fred-${FRED_SERIES[index]}`,
      }),
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
            evidenceSource(
              "extended-fred-macro",
              "FRED macro pack",
              "fred",
              command,
              latestRawSnapshotFetchedAt(
                fetched.map((result) => result.rawSnapshot),
                fetchedAt,
              ),
            ),
            metrics,
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}
