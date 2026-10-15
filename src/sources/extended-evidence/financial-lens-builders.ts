import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { secPeriod } from "./financial-lens-metrics";
import { isCurrentBalanceSheetPeriod } from "./valuation-comps-support";

export function currentRatioIsCurrent(
  secItem: ExtendedEvidenceItem | undefined,
  analysisAsOf: string,
): boolean {
  return (["currentAssets", "currentLiabilities"] as const).every((input) =>
    isCurrentBalanceSheetPeriod(
      secItem?.metrics,
      secPeriod(secItem, input).periodEnd,
      analysisAsOf,
    ),
  );
}
