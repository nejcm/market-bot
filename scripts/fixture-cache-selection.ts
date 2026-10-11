export interface CacheEntry {
  readonly cacheKey: string;
  readonly adapter: string;
  readonly fetchedAt: string;
  readonly payload: unknown;
}

// A run's freshness budget can serve same-day entries another run fetched earlier; the latest fetch
// Per request wins, and accession entries the caller appends later still override date-dir ones.
export function selectDateDirEntries(
  entries: readonly CacheEntry[],
  startedAt: string,
): CacheEntry[] {
  const latest = new Map<string, CacheEntry>();
  for (const entry of entries) {
    if (entry.fetchedAt > startedAt) {
      continue;
    }
    const existing = latest.get(entry.cacheKey);
    if (existing === undefined || entry.fetchedAt > existing.fetchedAt) {
      latest.set(entry.cacheKey, entry);
    }
  }
  return [...latest.values()];
}
