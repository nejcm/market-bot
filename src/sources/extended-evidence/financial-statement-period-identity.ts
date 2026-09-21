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

export function sameStatementFiscalPeriod(
  left: StatementFiscalPeriod,
  right: StatementFiscalPeriod,
): boolean {
  const leftYear = calendarYearFromPeriodEnd(left.periodEnd);
  const rightYear = calendarYearFromPeriodEnd(right.periodEnd);
  return (
    leftYear !== undefined &&
    leftYear === rightYear &&
    left.form === right.form &&
    (left.form === "10-K" || left.fiscalPeriod === right.fiscalPeriod)
  );
}

export function preferDirectStatementBasis(
  directPeriodEnd: string | undefined,
  compositePeriodEnd: string | undefined,
): boolean {
  if (compositePeriodEnd === undefined) {
    return true;
  }
  return directPeriodEnd !== undefined && directPeriodEnd >= compositePeriodEnd;
}
