import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(
      existsSync(
        join(
          tmpDir,
          "closes",
          "v2",
          "raw-close",
          "yahoo-massive",
          "equity",
          "spy",
          "2026-05-19.json",
        ),
      ),
    ).toBe(true);
  });

  test("ignores legacy v1 close files", async () => {
    let calls = 0;
    const date = new Date("2026-05-19T00:00:00.000Z");
    const legacyDir = join(tmpDir, "closes", "equity", "spy");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "2026-05-19.json"), JSON.stringify({ close: 400 }), "utf8");

    const close = await fetchCloseWithCache("SPY", "equity", date, tmpDir, async () => {
      calls += 1;
      return 500;
    });

    expect(close).toBe(500);
    expect(calls).toBe(1);
  });

  test("ignores invalid v2 close entries at the expected path", async () => {
    let calls = 0;
    const date = new Date("2026-05-19T00:00:00.000Z");
    const cacheDir = join(tmpDir, "closes", "v2", "raw-close", "yahoo-massive", "equity", "spy");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "2026-05-19.json"),
      JSON.stringify({
        schemaVersion: 1,
        symbol: "SPY",
        assetClass: "equity",
        providerSet: "yahoo-massive",
        priceMode: "raw-close",
        date: "2026-05-19",
        close: 400,
      }),
      "utf8",
    );

    const close = await fetchCloseWithCache("SPY", "equity", date, tmpDir, async () => {
      calls += 1;
      return 500;
    });

    expect(close).toBe(500);
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
    const to = new Date("2026-05-21T21:00:00.000Z");
    const earlier = new Date("2026-05-21T15:00:00.000Z");
    const fetchWindow = async () => {
      calls += 1;
      return [
        { subject: "SPY", date: "2026-05-19", value: 500 },
        { subject: "SPY", date: "2026-05-20", value: 505 },
      ];
    };

    const first = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, fetchWindow, to);
    const second = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, fetchWindow, to);
    // Same key, earlier cutoff: the 21:00 acquisition must not answer a 15:00 request.
    await fetchWindowWithCache("SPY", "equity", from, earlier, tmpDir, fetchWindow, earlier);

    expect(first).toEqual(second);
    expect(calls).toBe(2);
    expect(
      existsSync(
        join(
          tmpDir,
          "close-windows",
          "v3",
          "raw-close",
          "yahoo-massive",
          "equity",
          "spy",
          "2026-05-19_2026-05-21.json",
        ),
      ),
    ).toBe(true);
  });

  test("ignores invalid close window entries at the expected path", async () => {
    let calls = 0;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const cacheDir = join(
      tmpDir,
      "close-windows",
      "v3",
      "raw-close",
      "yahoo-massive",
      "equity",
      "spy",
    );
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "2026-05-19_2026-05-21.json"),
      JSON.stringify({
        schemaVersion: 1,
        symbol: "SPY",
        assetClass: "equity",
        providerSet: "yahoo-massive",
        priceMode: "raw-close",
        from: "2026-05-19",
        to: "2026-05-21",
        observations: [{ subject: "SPY", date: "2026-05-19", value: 400 }],
      }),
      "utf8",
    );

    const observations = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, async () => {
      calls += 1;
      return [{ subject: "SPY", date: "2026-05-19", value: 500 }];
    });

    expect(observations).toEqual([{ subject: "SPY", date: "2026-05-19", value: 500 }]);
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

  test("keeps policy-v3 split-adjusted windows separate from legacy raw windows", async () => {
    let calls = 0;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const fetchWindow = async () => {
      calls += 1;
      return [{ subject: "SPY", date: "2026-05-19", value: calls === 1 ? 500 : 250 }];
    };

    const legacy = await fetchWindowWithCache("SPY", "equity", from, to, tmpDir, fetchWindow);
    const policyV3 = await fetchWindowWithCache(
      "SPY",
      "equity",
      from,
      to,
      tmpDir,
      fetchWindow,
      new Date(),
      { scoringPolicyVersion: 3 },
    );

    expect(legacy[0]?.value).toBe(500);
    expect(policyV3[0]?.value).toBe(250);
    expect(calls).toBe(2);
    expect(
      existsSync(
        join(
          tmpDir,
          "close-windows",
          "v3",
          "split-adjusted-close",
          "yahoo",
          "equity",
          "spy",
          "2026-05-19_2026-05-21.json",
        ),
      ),
    ).toBe(true);
  });

  test("bypasses uncertified v2 split-adjusted windows without deleting them", async () => {
    const from = new Date("2026-10-07T00:00:00.000Z");
    const to = new Date("2026-10-08T21:00:00.000Z");
    const legacyDir = join(
      tmpDir,
      "close-windows",
      "v2",
      "split-adjusted-close",
      "yahoo",
      "equity",
      "clfd",
    );
    const legacyPath = join(legacyDir, "2026-10-07_2026-10-08.json");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        schemaVersion: 2,
        symbol: "CLFD",
        assetClass: "equity",
        providerSet: "yahoo",
        priceMode: "split-adjusted-close",
        from: "2026-10-07",
        to: "2026-10-08",
        observations: [{ subject: "CLFD", date: "2026-10-08", value: 32.45 }],
        cachedAt: "2026-10-08T15:58:52.674Z",
      }),
      "utf8",
    );

    const observations = await fetchWindowWithCache(
      "CLFD",
      "equity",
      from,
      to,
      tmpDir,
      async () => [{ subject: "CLFD", date: "2026-10-08", value: 33.1 }],
      new Date(),
      { scoringPolicyVersion: 3 },
    );

    expect(observations).toEqual([{ subject: "CLFD", date: "2026-10-08", value: 33.1 }]);
    expect(existsSync(legacyPath)).toBe(true);
  });

  test("never caches a window that withheld an unfinished session", async () => {
    let calls = 0;
    const from = new Date("2026-10-07T00:00:00.000Z");
    const to = new Date("2026-10-08T15:58:52.674Z");
    const fetchWindow = async () => {
      calls += 1;
      return Object.assign([{ subject: "CLFD", date: "2026-10-07", value: 32.9 }], {
        withheldSessions: [
          {
            date: "2026-10-08",
            status: "in-progress" as const,
            closesAt: "2026-10-08T20:00:00.000Z",
          },
        ],
      });
    };

    await fetchWindowWithCache("CLFD", "equity", from, to, tmpDir, fetchWindow);
    const second = await fetchWindowWithCache("CLFD", "equity", from, to, tmpDir, fetchWindow);

    expect(calls).toBe(2);
    expect(second.withheldSessions?.[0]?.date).toBe("2026-10-08");
  });
});
