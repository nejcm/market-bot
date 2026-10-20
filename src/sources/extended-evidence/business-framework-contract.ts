const BUSINESS_FRAMEWORK_GAP_CODES = [
  "business-description",
  "geographic-mix",
  "segment-mix",
  "customer-concentration",
  "purchase-recurrence",
  "management-track-record",
  "capital-allocation",
  "company-kpis",
  "risk-factors",
  "analyst-consensus",
  "pricing-power",
  "cyclicality",
] as const;

export type BusinessFrameworkGapCode = (typeof BUSINESS_FRAMEWORK_GAP_CODES)[number];

export function isBusinessFrameworkGapCode(value: string): value is BusinessFrameworkGapCode {
  return (BUSINESS_FRAMEWORK_GAP_CODES as readonly string[]).includes(value);
}
