import { isRecord, optionalString, readNumber } from "../src/guards";
import { encodeQuery } from "../src/sources/extended-evidence/utils";
import type { InstrumentProfile } from "./types";

const FINNHUB_PROFILE_URL = "https://finnhub.io/api/v1/stock/profile2";
const PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROFILE_FETCH_TIMEOUT_MS = 10_000;

export type FinnhubProfileResult =
  | {
      readonly ok: true;
      readonly profile: InstrumentProfile;
      readonly payload: unknown;
      readonly fetchedAt: string;
    }
  | { readonly ok: false; readonly message: string };

function buildFinnhubProfileUrl(symbol: string, token: string): string {
  return `${FINNHUB_PROFILE_URL}?${encodeQuery({ symbol, token })}`;
}

export function normalizeFinnhubProfile(
  payload: unknown,
): Omit<InstrumentProfile, "fetchedAt"> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const name = optionalString(payload, "name");
  const ticker = optionalString(payload, "ticker")?.toUpperCase();
  if (name === undefined || ticker === undefined) {
    return undefined;
  }
  const exchange = optionalString(payload, "exchange");
  const industry = optionalString(payload, "finnhubIndustry");
  // Finnhub reports market cap and shares in millions of the profile currency.
  const marketCap = readNumber(payload, "marketCapitalization");
  const shareOutstanding = readNumber(payload, "shareOutstanding");
  const ipo = optionalString(payload, "ipo");
  const currency = optionalString(payload, "currency");
  const country = optionalString(payload, "country");
  return {
    name,
    ticker,
    ...(exchange !== undefined ? { exchange } : {}),
    ...(industry !== undefined ? { industry } : {}),
    ...(marketCap !== undefined ? { marketCap: marketCap * 1e6 } : {}),
    ...(shareOutstanding !== undefined ? { shareOutstanding: shareOutstanding * 1e6 } : {}),
    ...(ipo !== undefined ? { ipo } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(country !== undefined ? { country } : {}),
  };
}

export function profileIsFresh(fetchedAt: string, now: Date): boolean {
  const fetchedTime = new Date(fetchedAt).getTime();
  return !Number.isNaN(fetchedTime) && now.getTime() - fetchedTime <= PROFILE_CACHE_TTL_MS;
}

export async function fetchFinnhubProfile(
  symbol: string,
  token: string | undefined,
  fetchFn: typeof fetch,
  now: Date = new Date(),
): Promise<FinnhubProfileResult> {
  if (token === undefined) {
    return { ok: false, message: "profile unavailable: missing Finnhub token" };
  }
  try {
    const response = await fetchFn(buildFinnhubProfileUrl(symbol, token), {
      signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        ok: false,
        message: `profile unavailable: provider returned ${String(response.status)}`,
      };
    }
    const payload = (await response.json()) as unknown;
    const profile = normalizeFinnhubProfile(payload);
    if (profile === undefined) {
      return {
        ok: false,
        message: "profile unavailable: provider response was empty or malformed",
      };
    }
    const fetchedAt = now.toISOString();
    return { ok: true, profile: { ...profile, fetchedAt }, payload, fetchedAt };
  } catch (error: unknown) {
    return {
      ok: false,
      message: `profile unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
