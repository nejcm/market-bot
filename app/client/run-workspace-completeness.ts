export const COMPLETENESS_REASON_CODE_LABELS: Readonly<Record<string, string>> = {
  "annual-as-current": "Annual statement remains current",
  "annual-history-insufficient": "Annual history is insufficient",
  "cadence-unestablished": "Reporting cadence is not established",
  "current-annual-statement-missing": "Current annual statement is missing",
  "current-annual-statement-unavailable": "Current annual statement evidence is unavailable",
  "current-primary-statements-incomplete": "Current primary statements are incomplete",
  "debt-maturity-untagged": "Debt maturity evidence is untagged",
  "diluted-share-history-missing": "Diluted-share history is missing",
  "expectations-evidence-missing": "Expectations evidence is missing",
  "expectations-inputs-incomplete": "Expectations inputs are incomplete",
  "expectations-provider-credential-missing": "Expectations provider credential is missing",
  "expectations-provider-entitlement-blocked": "Expectations provider access is restricted",
  "irregular-comparison-missing": "Comparable irregular-period evidence is missing",
  "latest-due-interim-missing": "Latest due interim statement is missing",
  "operating-kpi-not-applicable": "Operating KPIs are not applicable",
  "operating-kpi-not-applicable-evidence-missing":
    "Operating KPI non-applicability evidence is missing",
  "operating-kpi-registry-unconfigured": "Operating KPI registry is not configured",
  "operating-kpi-unverified": "Operating KPI is unverified",
  "ownership-external-context-available": "External ownership context is available",
  "ownership-provider-credential-missing": "Ownership provider credential is missing",
  "ownership-provider-entitlement-blocked": "Ownership provider access is restricted",
  "payout-evidence-missing": "Payout evidence is missing",
  "per-share-evidence-missing": "Per-share evidence is missing",
  "quarterly-periods-insufficient": "Quarterly history is insufficient",
  "reporting-currency-incompatible": "Reporting currency evidence is inconsistent",
  "reporting-currency-missing": "Reporting currency is missing",
  "sbc-history-missing": "Stock-based compensation history is missing",
  "semiannual-comparison-missing": "Comparable semiannual evidence is missing",
  "subsequent-financing-unreconciled": "Subsequent financing is unreconciled",
  "ttm-unreconciled": "Trailing twelve-month evidence is unreconciled",
  "untagged-interim-evidence": "Interim evidence is untagged",
  "valuation-evidence-missing": "Valuation evidence is missing",
  "valuation-inputs-incomplete": "Valuation inputs are incomplete",
};

function readableReasonCodeFragment(value: string): string {
  return value.replaceAll("-", " ").trim() || "Unspecified completeness detail";
}

export function completenessReasonCodeLabel(reasonCode: string): string {
  const exactLabel = COMPLETENESS_REASON_CODE_LABELS[reasonCode];
  if (exactLabel !== undefined) {
    return exactLabel;
  }
  const separatorIndex = reasonCode.indexOf(":");
  if (separatorIndex === -1) {
    return readableReasonCodeFragment(reasonCode);
  }
  const prefix = reasonCode.slice(0, separatorIndex);
  const suffix = reasonCode.slice(separatorIndex + 1);
  const prefixLabel = COMPLETENESS_REASON_CODE_LABELS[prefix] ?? readableReasonCodeFragment(prefix);
  return suffix.trim() === ""
    ? prefixLabel
    : `${prefixLabel}: ${readableReasonCodeFragment(suffix)}`;
}
