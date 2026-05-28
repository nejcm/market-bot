import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCloseRepository, repositoryFromFetchFn } from "../src/scoring/close-repository";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "close-repo-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

describe("CloseRepository routing", () => {
  test("routes FRED: prefix to the FRED fetcher", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(jsonResponse({ observations: [{ value: "4.1" }, { value: "4.2" }] }));
    }) as typeof fetch;
    const repo = createCloseRepository({ fredApiKey: "fred-key" });

    const result = await repo.closeAt("FRED:DGS10", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(4.2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("api.stlouisfed.org/fred/series/observations");
    expect(calls[0]).toContain("series_id=DGS10");
    expect(calls[0]).toContain("api_key=fred-key");
  });

  test("routes IV: prefix on equity to the IV fetcher", async () => {
    const calls: string[] = [];
    const date = new Date("2026-05-19T00:00:00.000Z");
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/expirations?")) {
        return Promise.resolve(jsonResponse({ expirations: { date: ["2026-06-20"] } }));
      }
      return Promise.resolve(
        jsonResponse({
          options: {
            option: [
              { greeks: { mid_iv: 0.3 } },
              { greeks: { mid_iv: 0.38 } },
              { greeks: { mid_iv: 0.5 } },
            ],
          },
        }),
      );
    }) as typeof fetch;
    const repo = createCloseRepository({ tradierApiToken: "tradier-token", now: date });

    const result = await repo.closeAt("IV:AAPL", "equity", date);

    expect(result).toBe(0.38);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("api.tradier.com/v1/markets/options/expirations");
    expect(calls[0]).toContain("symbol=AAPL");
    expect(calls[1]).toContain("api.tradier.com/v1/markets/options/chains");
    expect(calls[1]).toContain("expiration=2026-06-20");
  });

  test("routes IV: prefix on crypto to undefined without making a provider call", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;
    const repo = createCloseRepository({ tradierApiToken: "tradier-token" });

    const result = await repo.closeAt("IV:ETH", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("routes equity symbols without prefixes to the Yahoo fetcher", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        jsonResponse({
          chart: {
            result: [{ indicators: { quote: [{ close: [510, 512.5] }] } }],
          },
        }),
      );
    }) as typeof fetch;
    const repo = createCloseRepository();

    const result = await repo.closeAt("SPY", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(512.5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("query1.finance.yahoo.com/v8/finance/chart/SPY");
  });

  test("routes crypto symbols without prefixes to the CoinGecko fetcher", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(
        jsonResponse({
          prices: [
            [0, 67_000],
            [1, 68_000],
          ],
        }),
      );
    }) as typeof fetch;
    const repo = createCloseRepository();

    const result = await repo.closeAt("BTC", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(68_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("api.coingecko.com/api/v3/coins/btc/market_chart/range");
  });
});

describe("CloseRepository caching", () => {
  test("a second closeAt call for the same symbol/date hits the cache, not the fetcher", async () => {
    let calls = 0;
    const repo = repositoryFromFetchFn(async () => {
      calls += 1;
      return 500;
    }, tmpDir);
    const date = new Date("2026-05-19T00:00:00.000Z");

    const first = await repo.closeAt("SPY", "equity", date);
    const second = await repo.closeAt("SPY", "equity", date);

    expect(first).toBe(500);
    expect(second).toBe(500);
    expect(calls).toBe(1);
  });

  test("undefined closes are not cached", async () => {
    let calls = 0;
    const repo = repositoryFromFetchFn(async (): Promise<number | undefined> => {
      calls += 1;
      return undefined;
    }, tmpDir);
    const date = new Date("2026-05-19T00:00:00.000Z");

    await repo.closeAt("BTC", "crypto", date);
    await repo.closeAt("BTC", "crypto", date);

    expect(calls).toBe(2);
  });
});
