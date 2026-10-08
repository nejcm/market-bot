export interface StatementFiscalPeriod {
  readonly periodEnd: string;
  readonly form: string;
  readonly fiscalPeriod: string;
}

// Calendar-year labels fit calendar filers and BNS-style Oct-31 years.
// Jan-31 retailers may call 2018-01-31 FY2017 while this yields 2018; that still beats the reported fy frame.
export function calendarYearFromPeriodEnd(periodEnd: string): number | undefined {
  const year = Number.parseInt(periodEnd.slice(0, 4), 10);
  return Number.isFinite(year) ? year : undefined;
}

export function statementFiscalPeriodKey(period: StatementFiscalPeriod): string {
  const year = calendarYearFromPeriodEnd(period.periodEnd);
  return period.form === "10-K"
    ? `${period.periodEnd}|${period.form}|${String(year ?? "")}`
    : `${period.periodEnd}|${period.form}|${String(year ?? "")}|${period.fiscalPeriod}`;
}

const GROSS_DEBT_CALIBRATION_TOLERANCE = 0.05;

// Gross principal stands in for net debt only when fresher and within tolerance of net at net's own period end.
export function grossPrincipalDebtFallbackApplies(
  net: { readonly periodEnd: string; readonly value: number },
  latestGrossPeriodEnd: string,
  grossAtNetPeriodEnd: number | undefined,
): boolean {
  return (
    latestGrossPeriodEnd > net.periodEnd &&
    grossAtNetPeriodEnd !== undefined &&
    Math.abs(grossAtNetPeriodEnd - net.value) <=
      GROSS_DEBT_CALIBRATION_TOLERANCE * Math.abs(net.value)
  );
}
