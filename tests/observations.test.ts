import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createObservationRepository } from "../src/scoring/observations";
import type { ResearchReport } from "../src/domain/types";
import {
  fetchYahooCloseWindow,
  fetchYahooSplitAdjustedCloseWindow,
  type YahooCloseWindowResult,
} from "../src/sources/yahoo";
import type { FetchLike } from "../src/sources/types";
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

function yahooChartPayload(closes: readonly unknown[], events?: Record<string, unknown>): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: [
            Date.parse("2026-05-19T00:00:00.000Z") / 1000,
            Date.parse("2026-05-20T00:00:00.000Z") / 1000,
            Date.parse("2026-05-21T00:00:00.000Z") / 1000,
          ],
          indicators: { quote: [{ close: closes }] },
          ...(events === undefined ? {} : { events }),
        },
      ],
    },
  };
}

function fetchPayload(payload: unknown): FetchLike {
  return async () => Response.json(payload);
}

const sessionOpen = (iso: string) => Date.parse(iso) / 1000;

const window = (fetchImpl: FetchLike, cutoff: string) =>
  fetchYahooSplitAdjustedCloseWindow(
    "CLFD",
    new Date("2026-10-06T00:00:00.000Z"),
    new Date(cutoff),
    fetchImpl,
  );

const yahooFailsAndMassiveThrows: FetchLike = async (input) => {
  if (String(input).includes("massive")) {
    throw new Error("massive network down");
  }
  return new Response("nope", { status: 404 });
};

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
  test("fetchYahooCloseWindow parses a chart payload with no meta key", async () => {
    const cassette = (await Bun.file(
      join(import.meta.dir, "fixtures", "runs", "equity-aapl-brief", "data-cassette.json"),
    ).json()) as {
      readonly entries: Readonly<Record<string, { readonly body: string }>>;
    };
    const body = Object.entries(cassette.entries).find(([key]) =>
      key.includes("/v8/finance/chart/AAPL?"),
    )?.[1].body;
    expect(body).toBeDefined();

    const result = await fetchYahooCloseWindow(
      "AAPL",
      new Date("2025-05-11T00:00:00.000Z"),
      new Date("2026-06-14T00:00:00.000Z"),
      async () => new Response(body, { headers: { "content-type": "application/json" } }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.observations : []).toHaveLength(90);
  });

  describe("fetchYahooCloseWindow states an accurate reason for every empty result", () => {
    const from = new Date("2025-05-11T00:00:00.000Z");
    const to = new Date("2026-06-14T00:00:00.000Z");
    const emptyChart = {
      chart: {
        result: [{ timestamp: [], indicators: { quote: [{ close: [] }] } }],
        error: null,
      },
    };

    const scenarios: readonly (readonly [string, FetchLike, YahooCloseWindowResult])[] = [
      [
        "network throw",
        async () => {
          throw new Error("socket refused");
        },
        { ok: false, cause: "fetch-failed" },
      ],
      [
        "non-200 with an unrecognized body",
        async () => new Response("nope", { status: 404 }),
        { ok: false, cause: "fetch-failed" },
      ],
      // The two status+body pairs live Yahoo actually returns for "no data", captured from real
      // Calls: an unknown symbol and a window outside the instrument's history.
      [
        "404 carrying Yahoo's unknown-symbol body",
        async () =>
          Response.json(
            { code: "Not Found", description: "No data found, symbol may be delisted" },
            { status: 404 },
          ),
        { ok: true, observations: [] },
      ],
      [
        "400 carrying Yahoo's out-of-range-window body",
        async () =>
          Response.json(
            {
              code: "Bad Request",
              description: "Data doesn't exist for startDate = 0, endDate = 1",
            },
            { status: 400 },
          ),
        { ok: true, observations: [] },
      ],
      [
        "400 with an unrecognized description under a recognized code",
        async () =>
          Response.json({ code: "Bad Request", description: "Invalid api key" }, { status: 400 }),
        { ok: false, cause: "fetch-failed" },
      ],
      [
        "200 with invalid JSON",
        async () => new Response("<html>not json", { status: 200 }),
        { ok: false, cause: "malformed-response" },
      ],
      [
        "200 with a valid-JSON but malformed chart shape",
        async () => Response.json({ chart: { result: [{ nope: true }], error: null } }),
        { ok: false, cause: "malformed-response" },
      ],
      [
        "200 with a generic chart.error",
        async () =>
          Response.json({ chart: { result: null, error: { code: "Internal Server Error" } } }),
        { ok: false, cause: "malformed-response" },
      ],
      [
        "200 with a recognized no-series error",
        async () =>
          Response.json({
            chart: {
              result: null,
              error: { code: "Not Found", description: "No data found, symbol may be delisted" },
            },
          }),
        { ok: true, observations: [] },
      ],
      [
        "200 with a structurally valid but empty series",
        async () => Response.json(emptyChart),
        { ok: true, observations: [] },
      ],
      [
        "200 with a timestamp whose close is null",
        async () =>
          Response.json({
            chart: {
              result: [{ timestamp: [1_735_862_400], indicators: { quote: [{ close: [null] }] } }],
              error: null,
            },
          }),
        { ok: false, cause: "malformed-response" },
      ],
      [
        "200 with a timestamp and no closes at all",
        async () =>
          Response.json({
            chart: {
              result: [{ timestamp: [1_735_862_400], indicators: { quote: [{ close: [] }] } }],
              error: null,
            },
          }),
        { ok: false, cause: "malformed-response" },
      ],
    ];

    for (const [name, fetchImpl, expected] of scenarios) {
      test(name, async () => {
        expect(await fetchYahooCloseWindow("AAPL", from, to, fetchImpl)).toEqual(expected);
      });
    }

    test("a Massive fallback that throws is a failed fallback, not a rejection", async () => {
      expect(
        await fetchYahooCloseWindow("AAPL", from, to, yahooFailsAndMassiveThrows, "test-key"),
      ).toEqual({ ok: false, cause: "fetch-failed" });
    });
  });

  test("reconstructs dividend-exclusive split-adjusted equity closes from one Yahoo response", async () => {
    const splitTimestamp = Date.parse("2026-05-20T00:00:00.000Z") / 1000;
    const requestedUrls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requestedUrls.push(String(input));
      return Response.json(
        yahooChartPayload([100, 51, 52], {
          dividends: {
            [String(splitTimestamp)]: { date: splitTimestamp, amount: 10 },
          },
          splits: {
            [String(splitTimestamp)]: {
              date: splitTimestamp,
              numerator: 2,
              denominator: 1,
              splitRatio: "2:1",
            },
          },
        }),
      );
    };

    const result = await fetchYahooSplitAdjustedCloseWindow(
      "AAPL",
      new Date("2026-05-19T18:00:00.000Z"),
      new Date("2026-05-23T18:00:00.000Z"),
      fetchImpl,
    );

    expect(result).toEqual([
      { subject: "AAPL", date: "2026-05-19", value: 50 },
      { subject: "AAPL", date: "2026-05-20", value: 51 },
      { subject: "AAPL", date: "2026-05-21", value: 52 },
    ]);
    expect(requestedUrls).toHaveLength(1);
    const requestUrl = new URL(requestedUrls[0]!);
    expect(requestUrl.searchParams.get("events")).toBe("div,splits");
    expect(requestUrl.searchParams.get("period1")).toBe(
      String(Date.parse("2026-05-19T00:00:00.000Z") / 1000),
    );
  });

  describe("completed-session withholding", () => {
    const clfdOpens = [
      sessionOpen("2026-10-06T13:30:00.000Z"),
      sessionOpen("2026-10-07T13:30:00.000Z"),
      sessionOpen("2026-10-08T13:30:00.000Z"),
    ];
    const chart = (
      timestamps: readonly number[],
      regular: unknown,
      events?: Record<string, unknown>,
    ): FetchLike =>
      fetchPayload({
        chart: {
          result: [
            {
              meta: regular === undefined ? {} : { currentTradingPeriod: { regular } },
              timestamp: timestamps,
              indicators: { quote: [{ close: timestamps.map((_, index) => 32 + index) }] },
              ...(events === undefined ? {} : { events }),
            },
          ],
        },
      });
    const schedule = (start: string, end: string) => ({
      timezone: "EDT",
      start: sessionOpen(start),
      end: sessionOpen(end),
      gmtoffset: -14_400,
    });
    const oct8 = schedule("2026-10-08T13:30:00.000Z", "2026-10-08T20:00:00.000Z");

    test("withholds the October 8 close observed at 15:58:52Z, before the 20:00Z regular close", async () => {
      const result = await window(chart(clfdOpens, oct8), "2026-10-08T15:58:52.674Z");

      expect(result.map((observation) => observation.date)).toEqual(["2026-10-06", "2026-10-07"]);
      expect(result.withheldSessions).toEqual([
        { date: "2026-10-08", status: "in-progress", closesAt: "2026-10-08T20:00:00.000Z" },
      ]);
    });

    const scenarios: readonly (readonly [string, readonly number[], unknown, string, string[]])[] =
      [
        ["at the regular close", clfdOpens, oct8, "2026-10-08T20:00:00.000Z", []],
        ["after the regular close", clfdOpens, oct8, "2026-10-08T21:00:00.000Z", []],
        [
          "a half day read from the supplied 17:00Z close",
          [sessionOpen("2026-11-25T14:30:00.000Z"), sessionOpen("2026-11-27T14:30:00.000Z")],
          schedule("2026-11-27T14:30:00.000Z", "2026-11-27T18:00:00.000Z"),
          "2026-11-27T18:30:00.000Z",
          [],
        ],
        [
          "a half day before its supplied close",
          [sessionOpen("2026-11-25T14:30:00.000Z"), sessionOpen("2026-11-27T14:30:00.000Z")],
          schedule("2026-11-27T14:30:00.000Z", "2026-11-27T18:00:00.000Z"),
          "2026-11-27T17:59:00.000Z",
          ["2026-11-27"],
        ],
        [
          "a standard-time session still open at 20:30Z",
          [sessionOpen("2026-10-30T13:30:00.000Z"), sessionOpen("2026-11-02T14:30:00.000Z")],
          schedule("2026-11-02T14:30:00.000Z", "2026-11-02T21:00:00.000Z"),
          "2026-11-02T20:30:00.000Z",
          ["2026-11-02"],
        ],
        [
          "an international session after its 06:30Z close",
          [sessionOpen("2026-10-07T00:00:00.000Z"), sessionOpen("2026-10-08T00:00:00.000Z")],
          schedule("2026-10-08T00:00:00.000Z", "2026-10-08T06:30:00.000Z"),
          "2026-10-08T07:00:00.000Z",
          [],
        ],
        [
          "an international session before its 06:30Z close",
          [sessionOpen("2026-10-07T00:00:00.000Z"), sessionOpen("2026-10-08T00:00:00.000Z")],
          schedule("2026-10-08T00:00:00.000Z", "2026-10-08T06:30:00.000Z"),
          "2026-10-08T05:00:00.000Z",
          ["2026-10-08"],
        ],
        [
          "an absent schedule, accepting only bars before the previous UTC day",
          clfdOpens,
          undefined,
          "2026-10-08T21:00:00.000Z",
          ["2026-10-07", "2026-10-08"],
        ],
        [
          "a malformed schedule",
          clfdOpens,
          { start: "13:30", end: 1_791_489_600 },
          "2026-10-08T21:00:00.000Z",
          ["2026-10-07", "2026-10-08"],
        ],
        [
          "a stale schedule older than the newest bar",
          clfdOpens,
          schedule("2026-10-07T13:30:00.000Z", "2026-10-07T20:00:00.000Z"),
          "2026-10-08T21:00:00.000Z",
          ["2026-10-08"],
        ],
        ["historical bars", clfdOpens, undefined, "2026-10-12T21:00:00.000Z", []],
        [
          "a valid schedule for a session opening after the cutoff",
          clfdOpens,
          schedule("2026-10-09T13:30:00.000Z", "2026-10-09T20:00:00.000Z"),
          "2026-10-08T15:58:52.674Z",
          ["2026-10-07", "2026-10-08"],
        ],
      ];
    for (const [name, timestamps, regular, cutoff, withheldDates] of scenarios) {
      test(`withholds exactly the unproven sessions for ${name}`, async () => {
        const result = await window(chart(timestamps, regular), cutoff);

        expect(result.withheldSessions?.map((session) => session.date) ?? []).toEqual(
          withheldDates,
        );
        expect(result).toHaveLength(timestamps.length - withheldDates.length);
      });
    }

    test("adjusts for a split on the withheld session before withholding it", async () => {
      const splitOpen = sessionOpen("2026-10-08T13:30:00.000Z");
      const result = await window(
        chart(clfdOpens, oct8, {
          splits: {
            [String(splitOpen)]: {
              date: splitOpen,
              numerator: 2,
              denominator: 1,
              splitRatio: "2:1",
            },
          },
        }),
        "2026-10-08T15:58:52.674Z",
      );

      expect([...result]).toEqual([
        { subject: "CLFD", date: "2026-10-06", value: 16 },
        { subject: "CLFD", date: "2026-10-07", value: 16.5 },
      ]);
    });
  });

  test("rejects malformed or inconsistent Yahoo split metadata and incomplete close arrays", async () => {
    const splitTimestamp = Date.parse("2026-05-20T00:00:00.000Z") / 1000;
    const from = new Date("2026-05-19T00:00:00.000Z");
    const to = new Date("2026-05-21T00:00:00.000Z");
    const split = (overrides: Record<string, unknown>) => ({
      events: {
        splits: {
          [String(splitTimestamp)]: {
            date: splitTimestamp,
            numerator: 2,
            denominator: 1,
            splitRatio: "2:1",
            ...overrides,
          },
        },
      },
    });

    expect(
      await fetchYahooSplitAdjustedCloseWindow(
        "AAPL",
        from,
        to,
        fetchPayload(yahooChartPayload([100, 51, 52], split({ denominator: undefined }).events)),
      ),
    ).toEqual([]);
    expect(
      await fetchYahooSplitAdjustedCloseWindow(
        "AAPL",
        from,
        to,
        fetchPayload(yahooChartPayload([100, 51, 52], split({ splitRatio: "3:1" }).events)),
      ),
    ).toEqual([]);
    expect(
      await fetchYahooSplitAdjustedCloseWindow(
        "AAPL",
        from,
        to,
        fetchPayload(yahooChartPayload([100, null, 52])),
      ),
    ).toEqual([]);
  });

  test("does not mix Massive into a failed policy-v3 Yahoo equity window", async () => {
    const { calls, fetch: stub } = recordingFetch(() => new Response(null, { status: 400 }));
    globalThis.fetch = stub;
    const equityReport = researchReport({ assetClass: "equity" });
    const repo = createObservationRepository({
      report: equityReport,
      massiveApiKey: "massive-key",
    });

    const result = await repo.window(
      "AAPL",
      "equity",
      new Date("2026-05-19T00:00:00.000Z"),
      new Date("2026-05-21T00:00:00.000Z"),
      { scoringPolicyVersion: 3 },
    );

    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("query1.finance.yahoo.com");
    expect(calls.some((url) => url.includes("api.massive.com"))).toBe(false);
  });

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
      now: to,
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
