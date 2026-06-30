import type { MarketOverviewCommand } from "../../src/cli/job-registry";
import type { AssetClass, Depth } from "../../src/domain/types";

export function legacyMarketOverviewCommand(
  legacyAlias: "daily" | "weekly",
  options: {
    readonly assetClass: AssetClass;
    readonly depth: Depth;
  },
): MarketOverviewCommand {
  return {
    jobType: "market-overview",
    assetClass: options.assetClass,
    depth: options.depth,
    horizonTradingDays: legacyAlias === "daily" ? 5 : 15,
    legacyAlias,
  };
}
