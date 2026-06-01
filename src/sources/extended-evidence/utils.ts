import { isRecord, readNumber, readString } from "../guards";

export function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function daysFrom(fetchedAt: string, days: number): string {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function latestNumber(
  values: readonly unknown[],
  keys: readonly string[],
): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!isRecord(value)) {
      continue;
    }
    for (const key of keys) {
      const n = readNumber(value, key);
      if (n !== undefined) {
        return n;
      }
      const s = readString(value, key);
      if (s !== undefined) {
        const parsed = Number(s);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

export function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}
