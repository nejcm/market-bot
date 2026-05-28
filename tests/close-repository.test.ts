import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCloseRepository, repositoryFromFetchFn } from "../src/scoring/close-repository";

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "close-repo-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CloseRepository routing", () => {
  test("routes FRED: prefix to the FRED fetcher", async () => {
    const calls: string[] = [];
    const repo = repositoryFromFetchFn((symbol) => {
      calls.push(symbol);
      return Promise.resolve(4.2);
    });

    const result = await repo.closeAt("FRED:DGS10", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(4.2);
    expect(calls).toEqual(["FRED:DGS10"]);
  });

  test("routes IV: prefix on equity to the IV fetcher", async () => {
    const calls: string[] = [];
    const repo = repositoryFromFetchFn((symbol, assetClass) => {
      calls.push(`${assetClass}:${symbol}`);
      return Promise.resolve(0.38);
    });

    const result = await repo.closeAt("IV:AAPL", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(0.38);
    expect(calls).toEqual(["equity:IV:AAPL"]);
  });

  test("routes IV: prefix on crypto to undefined without making a provider call", async () => {
    const repo = createCloseRepository({});
    const result = await repo.closeAt("IV:ETH", "crypto", new Date("2026-05-19T00:00:00.000Z"));
    expect(result).toBeUndefined();
  });

  test("routes equity symbols (no prefix) to the Yahoo fetcher via stub", async () => {
    const calls: string[] = [];
    const repo = repositoryFromFetchFn((symbol, assetClass) => {
      calls.push(`${assetClass}:${symbol}`);
      return Promise.resolve(512.5);
    });

    const result = await repo.closeAt("SPY", "equity", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(512.5);
    expect(calls).toEqual(["equity:SPY"]);
  });

  test("routes crypto symbols (no prefix) to the CoinGecko fetcher via stub", async () => {
    const calls: string[] = [];
    const repo = repositoryFromFetchFn((symbol, assetClass) => {
      calls.push(`${assetClass}:${symbol}`);
      return Promise.resolve(68_000);
    });

    const result = await repo.closeAt("BTC", "crypto", new Date("2026-05-19T00:00:00.000Z"));

    expect(result).toBe(68_000);
    expect(calls).toEqual(["crypto:BTC"]);
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
