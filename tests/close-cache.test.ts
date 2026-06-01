import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchCloseWithCache, fetchWindowWithCache } from "../src/scoring/close-cache";

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "close-cache-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("fetchCloseWithCache", () => {
  test("caches successful close fetches by symbol, asset class, and date", async () => {
    let calls = 0;
    const date = new Date("2026-05-19T00:00:00.000Z");
    const fetchClose = async () => {
      calls += 1;
      return 500;
    };

    const first = await fetchCloseWithCache("SPY", "equity", date, tmpDir, fetchClose);
    const second = await fetchCloseWithCache("SPY", "equity", date, tmpDir, fetchClose);

    expect(first).toBe(500);
    expect(second).toBe(500);
    expect(calls).toBe(1);
  });

  test("does not cache missing closes", async () => {
    let calls = 0;
    const date = new Date("2026-05-19T00:00:00.000Z");
    const fetchClose = async (): Promise<number | undefined> => {
      calls += 1;
      const close: number | undefined = undefined;
      return close;
    };

    await fetchCloseWithCache("BTC", "crypto", date, tmpDir, fetchClose);
    await fetchCloseWithCache("BTC", "crypto", date, tmpDir, fetchClose);

    expect(calls).toBe(2);
  });

  test("caches successful close windows by symbol, asset class, and date range", async () => {
    let calls = 0;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const fetchWindow = async () => {
      calls += 1;
      return [
        { subject: "SPY", date: "2026-05-19", value: 500 },
        { subject: "SPY", date: "2026-05-20", value: 505 },
      ];
    };

    const first = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, fetchWindow);
    const second = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, fetchWindow);

    expect(first).toEqual(second);
    expect(calls).toBe(1);
  });

  test("does not cache empty close windows", async () => {
    let calls = 0;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const fetchWindow = async () => {
      calls += 1;
      return [];
    };

    await fetchWindowWithCache("BTC", "crypto", from, to, tmpDir, fetchWindow);
    await fetchWindowWithCache("BTC", "crypto", from, to, tmpDir, fetchWindow);

    expect(calls).toBe(2);
  });
});
