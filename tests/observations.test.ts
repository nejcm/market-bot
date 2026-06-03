import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createObservationRepository } from "../src/scoring/observations";
import type { ResearchReport } from "../src/domain/types";
import { researchReport } from "./support/fixtures";
import { recordingFetch } from "./support/mocks";

let tmpDir = "";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "observation-repo-test-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(sources: ResearchReport["sources"] = []): ResearchReport {
  return researchReport({ assetClass: "crypto", sources });
}

describe("ObservationRepository point routing", () => {
  test("routes FRED point requests to FRED observations", async () => {
    const { calls, fetch: stub } = recordingFetch(() => ({
      observations: [{ value: "4.1" }, { value: "4.2" }],
    }));
    globalThis.fetch = stub;
    const repo = createObservationRepository({ report: report(), fredApiKey: "fred-key" });

    const result = await repo.point(
      { kind: "fred", subject: "DGS10", observationSubject: "FRED:DGS10" },
      "equity",
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(result).toEqual({ subject: "FRED:DGS10", date: "2026-05-19", value: 4.2 });
    expect(calls[0]).toContain("series_id=DGS10");
    expect(calls[0]).toContain("api_key=fred-key");
  });

  test("passes observation labels to injected point fetches", async () => {
    const seenSubjects: string[] = [];
    const repo = createObservationRepository({
      report: report(),
      fetchClose: async (subject) => {
        seenSubjects.push(subject);
        return 4.2;
      },
    });

    const result = await repo.point(
      { kind: "fred", subject: "DGS10", observationSubject: "FRED:DGS10" },
      "equity",
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(result).toEqual({ subject: "FRED:DGS10", date: "2026-05-19", value: 4.2 });
    expect(seenSubjects).toEqual(["FRED:DGS10"]);
  });

  test("routes IV equity point requests to Tradier", async () => {
    const date = new Date("2026-05-19T00:00:00.000Z");
    const { calls, fetch: stub } = recordingFetch((url) =>
      url.includes("/expirations?")
        ? { expirations: { date: ["2026-06-20"] } }
        : {
            options: {
              option: [
                { greeks: { mid_iv: 0.3 } },
                { greeks: { mid_iv: 0.38 } },
                { greeks: { mid_iv: 0.5 } },
              ],
            },
          },
    );
    globalThis.fetch = stub;
    const repo = createObservationRepository({
      report: report(),
      tradierApiToken: "tradier-token",
      now: date,
    });

    const result = await repo.point(
      { kind: "iv", subject: "AAPL", observationSubject: "IV:AAPL" },
      "equity",
      date,
    );

    expect(result).toEqual({ subject: "IV:AAPL", date: "2026-05-19", value: 0.38 });
    expect(calls).toHaveLength(2);
  });

  test("does not fetch IV observations for crypto", async () => {
    const { calls, fetch: stub } = recordingFetch(() => ({}));
    globalThis.fetch = stub;
    const repo = createObservationRepository({
      report: report(),
      tradierApiToken: "tradier-token",
    });

    const result = await repo.point(
      { kind: "iv", subject: "ETH", observationSubject: "IV:ETH" },
      "crypto",
      new Date("2026-05-19T00:00:00.000Z"),
    );

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe("ObservationRepository window routing", () => {
  test("uses report Instrument Identity for CoinGecko window coin id", async () => {
    const { calls, fetch: stub } = recordingFetch(() => ({
      prices: [[Date.parse("2026-05-19T00:00:00.000Z"), 68_000]],
    }));
    globalThis.fetch = stub;
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

    const result = await repo.window(
      "BTC",
      "crypto",
      new Date("2026-05-19T00:00:00.000Z"),
      new Date("2026-05-20T00:00:00.000Z"),
    );

    expect(result).toContainEqual({ subject: "BTC", date: "2026-05-19", value: 68_000 });
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
  });

  test("uses BTC fallback and leaves unknown crypto windows unresolved", async () => {
    const { calls, fetch: stub } = recordingFetch(() => ({
      prices: [[Date.parse("2026-05-19T00:00:00.000Z"), 68_000]],
    }));
    globalThis.fetch = stub;
    const repo = createObservationRepository({ report: report() });
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-20T00:00:00.000Z");

    const btc = await repo.window("BTC", "crypto", from, to);
    const unknown = await repo.window("DOGE", "crypto", from, to);

    expect(btc).toContainEqual({ subject: "BTC", date: "2026-05-19", value: 68_000 });
    expect(unknown).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/coins/bitcoin/market_chart/range");
  });
});

describe("ObservationRepository caching", () => {
  test("a second point call for the same observation subject and date hits the cache", async () => {
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
    const request = { kind: "fred", subject: "DGS10", observationSubject: "FRED:DGS10" } as const;

    const first = await repo.point(request, "equity", date);
    const second = await repo.point(request, "equity", date);

    expect(first?.value).toBe(500);
    expect(first?.subject).toBe("FRED:DGS10");
    expect(second?.value).toBe(500);
    expect(calls).toBe(1);
  });

  test("a second window call for the same subject and range hits the cache", async () => {
    let calls = 0;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const repo = createObservationRepository({
      report: report(),
      cacheDir: tmpDir,
      fetchWindow: async () => {
        calls += 1;
        return [
          { subject: "SPY", date: "2026-05-19", value: 500 },
          { subject: "SPY", date: "2026-05-20", value: 505 },
        ];
      },
    });

    const first = await repo.window("SPY", "equity", from, to);
    const second = await repo.window("SPY", "equity", from, to);

    expect(first).toEqual(second);
    expect(calls).toBe(1);
  });
});
