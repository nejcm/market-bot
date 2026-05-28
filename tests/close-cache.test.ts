import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchCloseWithCache } from "../src/scoring/close-cache";

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
});
