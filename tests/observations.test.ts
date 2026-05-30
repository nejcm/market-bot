import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createObservationRepository } from "../src/scoring/observations";
import type { ResearchReport } from "../src/domain/types";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "observation-repo-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function report(sources: ResearchReport["sources"] = []): ResearchReport {
  return {
    runId: "run-1",
    jobType: "daily",
    assetClass: "crypto",
    generatedAt: "2026-05-19T00:00:00.000Z",
    summary: "",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources,
    notFinancialAdvice: true,
  };
}

describe("ObservationRepository point routing", () => {
  test("routes FRED prefixed subjects to FRED observations", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      const url = String(input);
      calls.push(url);
      return Promise.resolve(jsonResponse({ observations: [{ value: "4.1" }, { value: "4.2" }] }));
    }) as typeof fetch;
    const repo = createObservationRepository({ report: report(), fredApiKey: "fred-key" });

    const result = await repo.point("FRED:DGS10", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toEqual({ subject: "FRED:DGS10", date: "2026-05-19", value: 4.2 });
    expect(calls[0]).toContain("series_id=DGS10");
    expect(calls[0]).toContain("api_key=fred-key");
  });

  test("routes IV prefixed equity subjects to Tradier", async () => {
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
    const repo = createObservationRepository({
      report: report(),
      tradierApiToken: "tradier-token",
      now: date,
    });

    const result = await repo.point("IV:AAPL", "equity", date);

    expect(result).toEqual({ subject: "IV:AAPL", date: "2026-05-19", value: 0.38 });
    expect(calls).toHaveLength(2);
  });

  test("does not fetch IV observations for crypto", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({}));
    }) as typeof fetch;
    const repo = createObservationRepository({
      report: report(),
      tradierApiToken: "tradier-token",
    });

    const result = await repo.point("IV:ETH", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("uses report Instrument Identity for CoinGecko coin id", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({ prices: [[0, 68_000]] }));
    }) as typeof fetch;
    const repo = createObservationRepository({
      report: report([
        {
          id: "market-btc",
          title: "BTC market snapshot",
          fetchedAt: "2026-05-19T00:00:00.000Z",
          kind: "market-data",
          assetClass: "crypto",
          symbol: "BTC",
          identity: {
            providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
          },
        },
      ]),
    });

    const result = await repo.point("BTC", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(result?.value).toBe(68_000);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
  });

  test("uses BTC fallback and leaves unknown crypto unresolved", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse({ prices: [[0, 68_000]] }));
    }) as typeof fetch;
    const repo = createObservationRepository({ report: report() });

    const btc = await repo.point("BTC", "crypto", new Date("2026-05-19T00:00:00.000Z"));
    const unknown = await repo.point("DOGE", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(btc?.value).toBe(68_000);
    expect(unknown).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
  });
});

describe("ObservationRepository caching", () => {
  test("a second point call for the same subject and date hits the cache", async () => {
    let calls = 0;
    const repo = createObservationRepository({
      report: report(),
      cacheDir: tmpDir,
      fetchClose: async () => {
        calls += 1;
        return 500;
      },
    });
    const date = new Date("2026-05-19T00:00:00.000Z");

    const first = await repo.point("SPY", "equity", date);
    const second = await repo.point("SPY", "equity", date);

    expect(first?.value).toBe(500);
    expect(second?.value).toBe(500);
    expect(calls).toBe(1);
  });
});
