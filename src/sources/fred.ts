import { isRecord, readNumber, readString } from "./guards";

export const FRED_SERIES = [
  "DGS10",
  "DGS2",
  "T10Y2Y",
  "FEDFUNDS",
  "CPIAUCSL",
  "UNRATE",
  "DTWEXBGS",
];

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function latestNumber(values: readonly unknown[], keys: readonly string[]): number | undefined {
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

export function readFredObservationValue(payload: unknown): number | undefined {
  return latestNumber(readArray(payload, "observations"), ["value"]);
}

export async function fetchFredObservation(
  seriesId: string,
  date: Date,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<number | undefined> {
  if (apiKey === undefined) {
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  try {
    const response = await fetchImpl(
      `https://api.stlouisfed.org/fred/series/observations?${encodeQuery({
        series_id: seriesId,
        api_key: apiKey,
        file_type: "json",
        observation_start: day,
        observation_end: day,
        limit: "1",
      })}`,
    );
    if (!response.ok) {
      return undefined;
    }
    return readFredObservationValue((await response.json()) as unknown);
  } catch {
    return undefined;
  }
}
