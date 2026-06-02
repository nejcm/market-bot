import type { AssetClass, ExtendedEvidence } from "../domain/types";
import { extendedEvidenceGap } from "../domain/source-gaps";
import type {
  CollectContext,
  ExtendedEvidenceAdapter,
  ExtendedEvidenceCollectionResult,
} from "./types";
import { collectFinnhubEvents } from "./extended-evidence/finnhub-events";
import { collectFred } from "./extended-evidence/fred-macro";
import { collectGlassnode } from "./extended-evidence/glassnode-on-chain";
import { collectSec } from "./extended-evidence/sec-edgar";
import { collectTradierIv } from "./extended-evidence/tradier-options";
import type { ProviderCollector } from "./extended-evidence/common";

function emptyExtendedEvidence(): ExtendedEvidenceCollectionResult {
  return { rawSnapshots: [], sources: [], sourceGaps: [] };
}

async function collectProviderEvidence(
  ctx: CollectContext,
  assetClass: AssetClass,
  provider: ProviderCollector,
): Promise<ExtendedEvidenceCollectionResult> {
  if (ctx.command.jobType !== "ticker") {
    return emptyExtendedEvidence();
  }

  const result = await provider(ctx);
  const gaps = result.gaps.map(extendedEvidenceGap);
  const extendedEvidence: ExtendedEvidence = {
    instrument: { symbol: ctx.command.symbol, assetClass },
    items: result.items.map((item) => item.item),
    gaps,
  };
  return {
    rawSnapshots: result.rawSnapshots,
    sources: result.items.flatMap((item) => item.sources ?? [item.source]),
    extendedEvidence,
    sourceGaps: gaps,
  };
}

export function createProviderExtendedEvidenceAdapter(
  name: string,
  assetClass: AssetClass,
  provider: ProviderCollector,
): ExtendedEvidenceAdapter {
  return {
    name,
    collect: (ctx) => collectProviderEvidence(ctx, assetClass, provider),
  };
}

export function createMultiExtendedEvidenceAdapter(
  assetClass: AssetClass,
  adapters: readonly ExtendedEvidenceAdapter[],
): ExtendedEvidenceAdapter {
  return {
    name: `extended-evidence-${assetClass}`,
    collect: async (ctx) => {
      if (ctx.command.jobType !== "ticker") {
        return emptyExtendedEvidence();
      }

      const results = await Promise.all(adapters.map((adapter) => adapter.collect(ctx)));
      const items = results.flatMap((result) => result.extendedEvidence?.items ?? []);
      const gaps = results.flatMap((result) => result.sourceGaps);
      return {
        rawSnapshots: results.flatMap((result) => result.rawSnapshots),
        sources: results.flatMap((result) => result.sources),
        extendedEvidence: {
          instrument: { symbol: ctx.command.symbol, assetClass },
          items,
          gaps,
        },
        sourceGaps: gaps,
      };
    },
  };
}

export const secEdgarExtendedEvidenceAdapter = createProviderExtendedEvidenceAdapter(
  "extended-evidence-sec-edgar",
  "equity",
  collectSec,
);

export const finnhubEventsExtendedEvidenceAdapter = createProviderExtendedEvidenceAdapter(
  "extended-evidence-finnhub-events",
  "equity",
  collectFinnhubEvents,
);

export const fredExtendedEvidenceAdapter = createProviderExtendedEvidenceAdapter(
  "extended-evidence-fred-macro",
  "equity",
  collectFred,
);

export const tradierExtendedEvidenceAdapter = createProviderExtendedEvidenceAdapter(
  "extended-evidence-tradier-options",
  "equity",
  collectTradierIv,
);

export const glassnodeExtendedEvidenceAdapter = createProviderExtendedEvidenceAdapter(
  "extended-evidence-glassnode-on-chain",
  "crypto",
  collectGlassnode,
);

export const equityExtendedEvidenceAdapter = createMultiExtendedEvidenceAdapter("equity", [
  secEdgarExtendedEvidenceAdapter,
  finnhubEventsExtendedEvidenceAdapter,
  fredExtendedEvidenceAdapter,
  tradierExtendedEvidenceAdapter,
]);

export const cryptoExtendedEvidenceAdapter = createMultiExtendedEvidenceAdapter("crypto", [
  fredExtendedEvidenceAdapter,
  glassnodeExtendedEvidenceAdapter,
]);
