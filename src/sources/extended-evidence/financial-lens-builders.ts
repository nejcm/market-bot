import type { ExtendedEvidenceItem } from "../../domain/evidence";
import {
  canonicalFinancialLensDerivedMetric,
  type CanonicalDerivedMetricKey,
  type SecFactMetricKey,
} from "./financial-lens-canonical";
import { secPeriod } from "./financial-lens-metrics";
import { isCurrentBalanceSheetPeriod } from "./valuation-comps-support";

// Canonical metrics carry one paired period; the legacy fallback must validate every input.
function nonCurrentPeriods(
  secItem: ExtendedEvidenceItem | undefined,
  key: CanonicalDerivedMetricKey | undefined,
  inputs: readonly SecFactMetricKey[],
  analysisAsOf: string,
): readonly (string | undefined)[] {
  const selected =
    key === undefined ? undefined : canonicalFinancialLensDerivedMetric(secItem, key);
  const periods =
    selected === undefined
      ? inputs.map((input) => secPeriod(secItem, input).periodEnd)
      : [selected.periodEnd];
  return periods.filter(
    (periodEnd) => !isCurrentBalanceSheetPeriod(secItem?.metrics, periodEnd, analysisAsOf),
  );
}

export function currentRatioIsCurrent(
  secItem: ExtendedEvidenceItem | undefined,
  analysisAsOf: string,
): boolean {
  return (
    nonCurrentPeriods(
      secItem,
      "currentRatio",
      ["currentAssets", "currentLiabilities"],
      analysisAsOf,
    ).length === 0
  );
}
