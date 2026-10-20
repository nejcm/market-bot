import type { FinancialLensName } from "./financial-lens-metrics";

export const FINANCIAL_LENS_ORDER: readonly FinancialLensName[] = [
  "Quality",
  "Growth",
  "Financial Strength",
  "Value",
  "Momentum",
];

export function financialLensMetricSectionId(name: FinancialLensName): string {
  return `financial-lens-${name.toLowerCase().replaceAll(" ", "-")}`;
}

export function financialLensNameFromSectionId(id: string): FinancialLensName | undefined {
  return FINANCIAL_LENS_ORDER.find((name) => financialLensMetricSectionId(name) === id);
}
