import type { SourceGap } from "../../domain/types";
import { isFetchJsonResult, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { encodeQuery, latestNumber } from "./utils";

const GLASSNODE_METRICS = [
  "addresses/active_count",
  "transactions/count",
  "transactions/transfers_volume_exchanges_net",
  "market/mvrv",
  "fees/volume_sum",
];

export async function collectGlassnode(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.glassnodeApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "glassnode-on-chain", message: "MARKET_BOT_GLASSNODE_API_KEY is not set" }],
    };
  }
  const { glassnodeApiKey } = ctx;
  const urls = GLASSNODE_METRICS.map(
    (metric) =>
      `https://api.glassnode.com/v1/metrics/${metric}?${encodeQuery({
        a: command.symbol,
        api_key: glassnodeApiKey,
      })}`,
  );
  const results = await Promise.all(
    urls.map((url, index) =>
      fetchOrGap(
        url,
        `glassnode-${String(index + 1)}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const metrics: Record<string, number> = {};
  for (const [index, result] of results.entries()) {
    if (isFetchJsonResult(result)) {
      const value = latestNumber(Array.isArray(result.payload) ? result.payload : [], ["v"]);
      if (value !== undefined) {
        metrics[GLASSNODE_METRICS[index]?.replaceAll("/", ".") ?? `metric${String(index)}`] = value;
      }
    }
  }
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          collectedItem(
            "on-chain",
            `${command.symbol} on-chain metrics`,
            `Glassnode on-chain observations captured for ${Object.keys(metrics).join(", ")}.`,
            evidenceSource(
              `extended-glassnode-${command.symbol.toLowerCase()}`,
              `${command.symbol} on-chain metrics`,
              "glassnode",
              command,
              fetchedAt,
            ),
            metrics,
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}
