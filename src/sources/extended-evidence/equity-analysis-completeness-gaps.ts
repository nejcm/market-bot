import type { EquityAnalysisCompleteness, SourceGap } from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";
import type { EquityReportingFreshness } from "./equity-analysis-completeness";

// Freshness-negative reason codes only, as an allowlist: a denylist would emit material gaps for
// Informational codes (`annual-as-current` rides along on a `complete` dimension) and for
// Reporting-surface facts that say nothing about currency (`sbc-history-missing` and friends).
export const EQUITY_FRESHNESS_GAP_REASON_CODES: readonly string[] = [
  "current-annual-statement-missing",
  "annual-history-insufficient",
  "latest-due-interim-missing",
  "quarterly-periods-insufficient",
  "semiannual-comparison-missing",
  "irregular-comparison-missing",
  "ttm-unreconciled",
  "cadence-unestablished",
  "per-share-evidence-missing",
  "current-primary-statements-incomplete",
  "untagged-interim-evidence",
  "reporting-currency-missing",
  "reporting-currency-incompatible",
  "subsequent-financing-unreconciled",
];

const FRESHNESS_GAP_REASON_CODES = new Set(EQUITY_FRESHNESS_GAP_REASON_CODES);

function freshnessDetail(freshness: EquityReportingFreshness | undefined): string {
  if (freshness === undefined) {
    return "no reported financial statement period is available";
  }
  return [
    `interim cadence ${freshness.interimCadence}`,
    `latest reported period end ${freshness.latestReportedPeriodEnd}`,
    ...(freshness.latestDuePeriodEnd === undefined
      ? []
      : [`expected due period end ${freshness.latestDuePeriodEnd}`]),
  ].join("; ");
}

// Freshness defects the model must see while it is still writing, as canonical Source Gaps.
// `no-cap` by design: an unfiled quarter is an incomplete reporting surface, not a sourcing
// Failure, so it must not dock Evidence Quality. `SourceGap` has no `code` field, so the reason
// Code is a deterministic message prefix.
export function equityAnalysisCompletenessGaps(
  completeness: EquityAnalysisCompleteness,
  freshness: EquityReportingFreshness | undefined,
  symbol: string | undefined,
): readonly SourceGap[] {
  const detail = freshnessDetail(freshness);
  const subject = symbol?.toUpperCase() ?? "the subject";
  return [
    ...new Set(
      Object.values(completeness.dimensions).flatMap((dimension) => dimension.reasonCodes),
    ),
  ]
    .filter((code) => FRESHNESS_GAP_REASON_CODES.has(code))
    .map((code) =>
      sourceGap({
        source: "equity-analysis-completeness",
        message: `${code}: ${subject} reporting surface is not current (${detail})`,
        ...(symbol !== undefined ? { symbol } : {}),
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
        triage: "material",
      }),
    );
}
