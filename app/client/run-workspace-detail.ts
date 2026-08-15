import type { RunDetail } from "../types";
import type { MarketSnapshot, MarketSnapshotPriceAsOf } from "../../src/domain/types";
import type {
  FinancialLensName,
  FinancialLensPosture,
} from "../../src/sources/extended-evidence/financial-lens";
import { projectEquityReader, type EquityReaderProjection } from "../../src/report/equity-reader";
import { financialLensStatTiles, textItems, type FinancialLensStatTile } from "./view-model";

export interface RunWorkspaceTextItem {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

export type RunWorkspaceCaseKey = "bullCase" | "bearCase" | "risks" | "catalysts";

export interface RunWorkspaceCaseSection {
  readonly key: RunWorkspaceCaseKey;
  readonly title: string;
  readonly items: readonly RunWorkspaceTextItem[];
}

export interface RunWorkspaceFinancialLensGroup {
  readonly lens: FinancialLensName;
  readonly posture: FinancialLensPosture;
  readonly sourceIds: readonly string[];
  readonly tiles: readonly FinancialLensStatTile[];
}

export function priceAsOfLabel(priceAsOf: MarketSnapshotPriceAsOf): string {
  return `${priceAsOf.kind === "quote-time" ? "quote time" : "fetch time"} ${priceAsOf.instant}`;
}

const CASE_SECTIONS: readonly {
  readonly key: RunWorkspaceCaseKey;
  readonly title: string;
}[] = [
  { key: "bullCase", title: "Bull case" },
  { key: "bearCase", title: "Bear case" },
  { key: "risks", title: "Risks" },
  { key: "catalysts", title: "Catalysts" },
];

export function matchingMarketSnapshot(detail: RunDetail): MarketSnapshot | undefined {
  const { assetClass, symbol } = detail.summary;
  if (assetClass !== "equity" || symbol === undefined) {
    return undefined;
  }
  const normalizedSymbol = symbol.toUpperCase();
  return detail.marketSnapshots?.find(
    (snapshot) =>
      snapshot.assetClass === assetClass && snapshot.symbol.toUpperCase() === normalizedSymbol,
  );
}

export function projectEquityReaderForDetail(detail: RunDetail): EquityReaderProjection {
  const marketSnapshot = matchingMarketSnapshot(detail);
  return projectEquityReader({
    report: detail.report,
    ...(marketSnapshot === undefined ? {} : { marketSnapshot }),
    ...(detail.fundamentalHistory === undefined
      ? {}
      : { fundamentalHistory: detail.fundamentalHistory }),
    ...(detail.financialStatements === undefined
      ? {}
      : { financialStatements: detail.financialStatements }),
    ...(detail.valuationWorkbench === undefined
      ? {}
      : { valuationWorkbench: detail.valuationWorkbench }),
    ...(detail.peerImpliedRange === undefined ? {} : { peerImpliedRange: detail.peerImpliedRange }),
    ...(detail.sourceGaps === undefined ? {} : { sourceGaps: detail.sourceGaps }),
  });
}

export function uniqueSourceIds(sourceIds: readonly string[]): readonly string[] {
  return [...new Set(sourceIds.filter((sourceId) => sourceId.trim() !== ""))];
}

export function financialLensGroupViews(
  detail: RunDetail,
): readonly RunWorkspaceFinancialLensGroup[] {
  const financialLensStats = financialLensStatTiles(
    detail.financialLenses,
    detail.marketSnapshots ?? [],
  );
  return (
    detail.financialLenses?.lenses.map(
      (lens): RunWorkspaceFinancialLensGroup => ({
        lens: lens.name,
        posture: lens.posture,
        sourceIds: lens.sourceIds,
        tiles: financialLensStats.filter((tile) => tile.lens === lens.name),
      }),
    ) ?? []
  );
}

export function reportCaseSections(
  report: Record<string, unknown> | undefined,
): readonly RunWorkspaceCaseSection[] {
  return CASE_SECTIONS.map((section) => ({
    ...section,
    items: textItems(report, section.key),
  })).filter((section) => section.items.length > 0);
}
