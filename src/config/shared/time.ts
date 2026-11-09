export const DAY_MS = 86_400_000;
export const SEC_FRESHNESS_DAYS = 180;

export function daysBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? (endMs - startMs) / DAY_MS
    : undefined;
}

export function roundedDaysAfter(later: string, earlier: string): number {
  return Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);
}
