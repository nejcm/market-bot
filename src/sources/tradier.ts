import { isRecord, readNumber } from "./guards";
import type { FetchLike } from "./types";

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function daysFrom(fetchedAt: string, days: number): string {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function tradierRequestInit(token: string): RequestInit {
  return { headers: { accept: "application/json", authorization: `Bearer ${token}` } };
}

function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function readTradierExpirations(payload: unknown): readonly string[] {
  const expirations = isRecord(payload) ? payload.expirations : undefined;
  return readArray(expirations, "date")
    .filter((date): date is string => typeof date === "string")
    .toSorted();
}

export function selectTradierExpiration(payload: unknown, target: string): string | undefined {
  const expirations = readTradierExpirations(payload);
  return expirations.find((date) => date >= target) ?? expirations.at(-1);
}

export function summarizeTradierIv(
  payload: unknown,
): { summary: string; metrics: Record<string, number> } | undefined {
  const options =
    isRecord(payload) && isRecord(payload.options) ? readArray(payload.options, "option") : [];
  const ivs = options
    .filter((option) => isRecord(option))
    .map((option) => {
      const greeks = isRecord(option.greeks) ? option.greeks : undefined;
      return greeks !== undefined
        ? (readNumber(greeks, "mid_iv") ?? readNumber(greeks, "iv"))
        : undefined;
    })
    .filter((value): value is number => value !== undefined)
    .toSorted((a, b) => a - b);
  if (ivs.length === 0) {
    return undefined;
  }
  const median = ivs[Math.floor(ivs.length / 2)] as number;
  return {
    summary: `Near-term option chain median implied volatility is ${median.toFixed(3)}.`,
    metrics: { medianIv: median },
  };
}

export async function fetchTradierIvObservation(
  symbol: string,
  date: Date,
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<number | undefined> {
  if (token === undefined) {
    return undefined;
  }
  // Tradier option chains expose current chains; historical IV scoring is unavailable here.
  if (dateString(date) !== dateString(now)) {
    return undefined;
  }

  try {
    const init = tradierRequestInit(token);
    const expirationsResponse = await fetchImpl(
      `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
        symbol,
        includeAllRoots: "true",
      })}`,
      init,
    );
    if (!expirationsResponse.ok) {
      return undefined;
    }
    const expiration = selectTradierExpiration(
      (await expirationsResponse.json()) as unknown,
      daysFrom(date.toISOString(), 30),
    );
    if (expiration === undefined) {
      return undefined;
    }

    const response = await fetchImpl(
      `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
        symbol,
        expiration,
        greeks: "true",
      })}`,
      init,
    );
    if (!response.ok) {
      return undefined;
    }
    return summarizeTradierIv((await response.json()) as unknown)?.metrics.medianIv;
  } catch {
    return undefined;
  }
}
