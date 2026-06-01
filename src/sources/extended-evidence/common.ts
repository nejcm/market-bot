import type { ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidenceCategory,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../../domain/types";
import type { CollectContext, RawSourceSnapshot } from "../types";

export interface CollectedItem {
  readonly item: ExtendedEvidenceItem;
  readonly source: Source;
  readonly sources?: readonly Source[];
}

export interface ProviderResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly items: readonly CollectedItem[];
  readonly gaps: readonly SourceGap[];
}

export type ProviderCollector = (ctx: CollectContext) => Promise<ProviderResult>;

export function evidenceSource(
  id: string,
  title: string,
  provider: string,
  command: ResearchCommand,
  fetchedAt: string,
  url?: string,
  identity?: InstrumentIdentity,
): Source {
  return {
    id,
    title,
    ...(url !== undefined ? { url } : {}),
    fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    ...(command.jobType === "ticker" ? { symbol: command.symbol } : {}),
    provider,
    ...(identity !== undefined ? { identity } : {}),
  };
}

export function collectedItem(
  category: ExtendedEvidenceCategory,
  title: string,
  summary: string,
  source: Source,
  metrics?: Record<string, number | string>,
): CollectedItem {
  return {
    source,
    item: {
      category,
      title,
      summary,
      sourceIds: [source.id],
      observedAt: source.fetchedAt,
      ...(metrics !== undefined ? { metrics } : {}),
      ...(source.identity !== undefined ? { identity: source.identity } : {}),
    },
  };
}
