import type { SourceGap } from "../../domain/sources";
import { isInstrumentCommand } from "../../cli/args";
import { sourceGap } from "../../domain/source-gaps";
import { isFetchJsonResult, latestRawSnapshotFetchedAt, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { encodeQuery, latestNumber } from "./utils";

const GLASSNODE_METRICS = [
  ["glassnode-1", "addresses/active_count"],
  ["glassnode-2", "transactions/count"],
  ["glassnode-3", "transactions/transfers_volume_exchanges_net"],
  ["glassnode-4", "market/mvrv"],
  ["glassnode-5", "fees/volume_sum"],
] as const;

export async function collectGlassnode(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt } = ctx;
  if (!isInstrumentCommand(command)) {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.glassnodeApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "glassnode-on-chain",
          message: "MARKET_BOT_GLASSNODE_API_KEY is not set",
          provider: "glassnode",
          capability: "extended-evidence",
          cause: "missing-credential",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  const { glassnodeApiKey } = ctx;
  const results = await Promise.all(
    GLASSNODE_METRICS.map(([adapter, metric]) =>
      ctx.request.json({
        url: `https://api.glassnode.com/v1/metrics/${metric}?${encodeQuery({
          a: command.symbol,
          api_key: glassnodeApiKey,
        })}`,
        adapter,
      }),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const metrics: Record<string, number> = {};
  for (const [index, result] of results.entries()) {
    if (isFetchJsonResult(result)) {
      const value = latestNumber(Array.isArray(result.payload) ? result.payload : [], ["v"]);
      if (value !== undefined) {
        metrics[GLASSNODE_METRICS[index]?.[1].replaceAll("/", ".") ?? `metric${String(index)}`] =
          value;
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
