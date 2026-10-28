const DAY_MS = 86_400_000;

// Whole fiscal years: the end lands within a week of a same-month-day anniversary, else NaN.
export function yearsBetween(periodStart: string, periodEnd: string): number {
  const start = new Date(periodStart);
  const end = Date.parse(periodEnd);
  for (let years = 0; years <= 30; years += 1) {
    const anniversary = Date.UTC(
      start.getUTCFullYear() + years,
      start.getUTCMonth(),
      start.getUTCDate(),
    );
    if (Math.abs(end - anniversary) <= 7 * DAY_MS) {
      return years;
    }
  }
  return Number.NaN;
}
