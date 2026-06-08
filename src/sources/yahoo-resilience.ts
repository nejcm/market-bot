import type { FetchLike } from "./types";
import { DEFAULT_RETRY_DELAYS_MS, isYahooAuthStatus, withTransientRetries } from "./retry-utils";

export const YAHOO_AUTH_MAX_RETRIES = 3;
export const YAHOO_CACHE_FALLBACK_DAYS = 2;

export const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";

interface YahooCredentials {
  readonly cookie: string;
  readonly crumb: string;
}

let yahooCredentialsPromise: Promise<YahooCredentials> | null = null;

function cookiePairs(headers: Headers): readonly string[] {
  const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = headersWithSetCookie.getSetCookie?.() ?? [];
  const fallback = headers.get("set-cookie");
  const setCookies = values.length > 0 ? values : [];
  const rawCookies = setCookies.length > 0 || fallback === null ? setCookies : [fallback];
  return rawCookies
    .map((value) => value.split(";")[0])
    .filter((value): value is string => value !== undefined && value.includes("="));
}

function headersWith(init: RequestInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(extra)) {
    headers.set(key, value);
  }
  return headers;
}

export function isYahooFinanceUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("finance.yahoo.com");
  } catch {
    return false;
  }
}

export function urlNeedsCrumb(url: string): boolean {
  return url.startsWith(YAHOO_QUOTE_URL);
}

function quoteUrlWithCrumb(url: string, crumb: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("crumb", crumb);
  return parsed.toString();
}

export function invalidateYahooCredentials(): void {
  yahooCredentialsPromise = null;
}

export function resetYahooCredentialsForTests(): void {
  invalidateYahooCredentials();
}

async function yahooCredentials(
  fetchImpl: FetchLike,
  init: RequestInit | undefined,
): Promise<YahooCredentials> {
  if (yahooCredentialsPromise !== null) {
    return yahooCredentialsPromise;
  }

  yahooCredentialsPromise = (async () => {
    const credentialInit = {
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      headers: headersWith(undefined, { "user-agent": "Mozilla/5.0 market-bot" }),
    };
    const cookieResponse = await fetchImpl("https://fc.yahoo.com", {
      ...credentialInit,
    });
    const cookie = cookiePairs(cookieResponse.headers).join("; ");
    const crumbInit = {
      ...(init?.signal !== undefined ? { signal: init.signal } : {}),
      headers: headersWith(
        undefined,
        cookie !== ""
          ? { cookie, "user-agent": "Mozilla/5.0 market-bot" }
          : { "user-agent": "Mozilla/5.0 market-bot" },
      ),
    };
    const crumbResponse = await fetchImpl("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      ...crumbInit,
    });
    if (!crumbResponse.ok) {
      throw new Error(`Yahoo crumb request failed with status ${crumbResponse.status}`);
    }
    const crumb = await crumbResponse.text();
    return { cookie, crumb: crumb.trim() };
  })();

  return yahooCredentialsPromise;
}

export async function prefetchYahooCredentials(
  fetchImpl: FetchLike,
  init?: RequestInit,
): Promise<void> {
  await yahooCredentials(fetchImpl, init);
}

async function retryYahooAuth(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: FetchLike,
  remainingAuthRetries: number,
): Promise<Response> {
  if (remainingAuthRetries <= 0) {
    return new Response(null, { status: 401 });
  }

  invalidateYahooCredentials();
  try {
    const credentials = await yahooCredentials(fetchImpl, init);
    const retryUrl = urlNeedsCrumb(url) ? quoteUrlWithCrumb(url, credentials.crumb) : url;
    const response = await fetchImpl(retryUrl, {
      ...init,
      headers: headersWith(init, credentials.cookie !== "" ? { cookie: credentials.cookie } : {}),
    });
    if (isYahooAuthStatus(response.status)) {
      return retryYahooAuth(url, init, fetchImpl, remainingAuthRetries - 1);
    }
    return response;
  } catch {
    invalidateYahooCredentials();
    return retryYahooAuth(url, init, fetchImpl, remainingAuthRetries - 1);
  }
}

export async function yahooCredentialFetch(
  input: string | URL | Request,
  init?: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const url = String(input);
  if (!isYahooFinanceUrl(url)) {
    return fetchImpl(input, init);
  }

  const response = await fetchImpl(input, init);
  if (!isYahooAuthStatus(response.status)) {
    return response;
  }

  return retryYahooAuth(url, init, fetchImpl, YAHOO_AUTH_MAX_RETRIES);
}

export function createYahooResilientFetch(baseFetch: FetchLike): FetchLike {
  return (input, init) => yahooCredentialFetch(input, init, baseFetch);
}

export function isYahooMarketDataAdapter(adapter: string): boolean {
  return adapter.startsWith("yahoo-") && adapter !== "yahoo-news";
}

export function yahooCacheFallbackDays(defaultFallbackDays: number): number {
  return Math.min(defaultFallbackDays, YAHOO_CACHE_FALLBACK_DAYS);
}

export async function fetchYahooResponseWithResilience(
  url: string,
  fetchImpl: FetchLike,
  init: RequestInit = {},
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<Response> {
  const resilientFetch = createYahooResilientFetch(fetchImpl);

  return withTransientRetries(async () => {
    const response = await resilientFetch(url, init);
    if (response.status >= 500 && response.status < 600) {
      throw new Error(`Yahoo request failed with status ${String(response.status)}`);
    }
    return response;
  }, retryDelaysMs);
}

export async function fetchYahooJsonWithResilience(
  url: string,
  fetchImpl: FetchLike,
  init: RequestInit = {},
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<{ readonly ok: true; readonly payload: unknown } | { readonly ok: false }> {
  try {
    const response = await fetchYahooResponseWithResilience(url, fetchImpl, init, retryDelaysMs);
    if (!response.ok) {
      return { ok: false };
    }
    return { ok: true, payload: (await response.json()) as unknown };
  } catch {
    return { ok: false };
  }
}
