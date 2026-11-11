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

export function isFreshPeriodEnd(periodEnd: string, generatedAt: string): boolean {
  const periodMs = Date.parse(periodEnd);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(periodMs) || !Number.isFinite(generatedMs)) {
    return false;
  }
  const ageMs = generatedMs - periodMs;
  return ageMs >= 0 && ageMs <= SEC_FRESHNESS_DAYS * DAY_MS;
}
