import { afterEach, describe, expect, test } from "bun:test";
import {
  createYahooResilientFetch,
  isYahooFinanceUrl,
  prefetchYahooCredentials,
  resetYahooCredentialsForTests,
  yahooCredentialFetch,
  YAHOO_QUOTE_URL,
} from "../src/sources/yahoo-resilience";
import type { FetchLike } from "../src/sources/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetYahooCredentialsForTests();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

describe("yahoo-resilience", () => {
  test("detects Yahoo finance URLs", () => {
    expect(isYahooFinanceUrl(`${YAHOO_QUOTE_URL}?symbols=SPY`)).toBe(true);
    expect(isYahooFinanceUrl("https://query1.finance.yahoo.com/v8/finance/chart/SPY")).toBe(true);
    expect(isYahooFinanceUrl("https://example.test/quote")).toBe(false);
  });

  test("retries quote route with cookie and crumb after 401 up to three auth attempts", async () => {
    const requestedUrls: string[] = [];
    let quoteAttempts = 0;
    const fetchImpl: FetchLike = async (input, _init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url === "https://fc.yahoo.com") {
        return new Response("", {
          status: 404,
          headers: { "set-cookie": "A3=session-cookie; Path=/;" },
        });
      }

      if (url.includes("/v1/test/getcrumb")) {
        return new Response("crumb-token");
      }

      if (url.includes("/v7/finance/quote")) {
        quoteAttempts += 1;
        if (quoteAttempts < 2) {
          return new Response("unauthorized", { status: 401 });
        }
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
              },
            ],
          },
        });
      }

      return new Response("not found", { status: 404 });
    };

    const response = await yahooCredentialFetch(
      `${YAHOO_QUOTE_URL}?symbols=SPY`,
      { headers: { accept: "application/json" } },
      fetchImpl,
    );

    expect(response.ok).toBe(true);
    expect(requestedUrls.some((url) => url.includes("crumb=crumb-token"))).toBe(true);
    expect(quoteAttempts).toBe(2);
  });

  test("applies credential wrapper to chart and screener routes", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("/v8/finance/chart/")) {
        return jsonResponse({
          chart: {
            result: [
              {
                timestamp: [1_746_000_000],
                indicators: { quote: [{ close: [500] }] },
              },
            ],
          },
        });
      }

      if (url.includes("/v1/finance/screener/")) {
        return jsonResponse({ finance: { result: [{ quotes: [] }] } });
      }

      return new Response("not found", { status: 404 });
    };

    const resilientFetch = createYahooResilientFetch(fetchImpl);
    await resilientFetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=1&period2=2",
    );
    await resilientFetch(
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers&count=50",
    );

    expect(requestedUrls.some((url) => url.includes("/v8/finance/chart/SPY"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/v1/finance/screener/"))).toBe(true);
  });

  test("prefetchYahooCredentials warms cookie and crumb cache", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requestedUrls.push(String(input));
      if (String(input) === "https://fc.yahoo.com") {
        return new Response("", { headers: { "set-cookie": "A3=session; Path=/;" } });
      }
      return new Response("crumb-token");
    };

    await prefetchYahooCredentials(fetchImpl);
    await prefetchYahooCredentials(fetchImpl);

    expect(requestedUrls.filter((url) => url === "https://fc.yahoo.com")).toHaveLength(1);
    expect(requestedUrls.filter((url) => url.includes("/v1/test/getcrumb"))).toHaveLength(1);
  });
});
