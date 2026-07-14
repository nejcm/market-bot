import { isRecord, readNumber, readString } from "../guards";

export const FRED_SERIES = [
  "DGS10",
  "DGS2",
  "T10Y2Y",
  "FEDFUNDS",
  "CPIAUCSL",
  "UNRATE",
  "DTWEXBGS",
];

export function isFredBaseMetricKey(key: string): boolean {
  return !key.endsWith("Change") && !key.endsWith("Date") && !key.endsWith("Prior");
}

export function fredObservationsUrl(seriesId: string, apiKey: string, limit: number): string {
  return `https://api.stlouisfed.org/fred/series/observations?${encodeQuery({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    limit: String(limit),
  })}`;
}

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

interface FredMacroInput {
  readonly seriesId: string;
  readonly payload: unknown;
}

function readObservationValue(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const n = readNumber(value, "value");
  if (n !== undefined) {
    return n;
  }
  const s = readString(value, "value");
  if (s === undefined) {
    return undefined;
  }
  const parsed = Number(s);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readObservationDate(value: unknown): string | undefined {
  return isRecord(value) ? readString(value, "date") : undefined;
}

function normalizeDelta(value: number): number {
  return Number(value.toFixed(6));
}

export function buildFredMacroMetrics(
  inputs: readonly FredMacroInput[],
): Record<string, number | string> {
  const entries = inputs.flatMap(({ seriesId, payload }) => {
    const observations = readArray(payload, "observations");
    const latest = observations.find(
      (observation) => readObservationValue(observation) !== undefined,
    );
    if (latest === undefined) {
      return [];
    }
    const latestValue = readObservationValue(latest);
    if (latestValue === undefined) {
      return [];
    }
    const prior = observations
      .filter((observation) => observation !== latest)
      .find((observation) => readObservationValue(observation) !== undefined);
    const latestDate = readObservationDate(latest);
    const priorValue = prior === undefined ? undefined : readObservationValue(prior);
    const priorDate = prior === undefined ? undefined : readObservationDate(prior);
    return [
      [seriesId, latestValue],
      ...(priorValue !== undefined
        ? [[`${seriesId}Change`, normalizeDelta(latestValue - priorValue)]]
        : []),
      ...(latestDate !== undefined ? [[`${seriesId}Date`, latestDate]] : []),
      ...(priorValue !== undefined ? [[`${seriesId}Prior`, priorValue]] : []),
      ...(priorDate !== undefined ? [[`${seriesId}PriorDate`, priorDate]] : []),
    ];
  });
  return Object.fromEntries(entries) as Record<string, number | string>;
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
