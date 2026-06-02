import { sourceGap } from "../../domain/source-gaps";
import { selectTradierExpiration, summarizeTradierIv, tradierRequestInit } from "../tradier";
import { isFetchJsonResult, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { daysFrom, encodeQuery } from "./utils";

export async function collectTradierIv(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.tradierApiToken === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [
        sourceGap({
          source: "tradier-options",
          message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "missing-credential",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }
  const init = tradierRequestInit(ctx.tradierApiToken);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: command.symbol,
    includeAllRoots: "true",
  })}`;
  const expirations = await fetchOrGap(
    expirationsUrl,
    "tradier-expirations",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    init,
  );
  if (!isFetchJsonResult(expirations)) {
    return { rawSnapshots: [], items: [], gaps: [expirations] };
  }
  const expiration = selectTradierExpiration(expirations.payload, daysFrom(fetchedAt, 30));
  if (expiration === undefined) {
    return {
      rawSnapshots: [expirations.rawSnapshot],
      items: [],
      gaps: [
        sourceGap({
          source: "tradier-options",
          message: "No Tradier option expiration found",
          provider: "tradier",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
    };
  }

  const url = `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol: command.symbol,
    expiration,
    greeks: "true",
  })}`;
  const result = await fetchOrGap(
    url,
    "tradier-options",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    init,
  );
  if (!isFetchJsonResult(result)) {
    return { rawSnapshots: [expirations.rawSnapshot], items: [], gaps: [result] };
  }
  const summary = summarizeTradierIv(result.payload);
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "options-iv",
            `${command.symbol} options IV`,
            summary.summary,
            evidenceSource(
              `extended-tradier-iv-${command.symbol.toLowerCase()}`,
              `${command.symbol} options IV`,
              "tradier",
              command,
              fetchedAt,
              url,
            ),
            summary.metrics,
          ),
        ];
  return { rawSnapshots: [expirations.rawSnapshot, result.rawSnapshot], items, gaps: [] };
}
