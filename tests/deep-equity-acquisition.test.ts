import { beforeEach, describe, expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { collectSources } from "../src/sources/collector";
import {
  collectSecTargetPacketBase,
  finalizeSecTargetPacket,
} from "../src/sources/sec-target-packet";
import { createCollectContext, resetSourceResilienceForTests } from "../src/sources/source-request";
import { collectTradierPacket } from "../src/sources/tradier-packet";
import type { FetchLike } from "../src/sources/types";
import { makeReplayFetch } from "./support/run-fixtures/data-cassette";
import { createFixtureConfig, loadFixture } from "./support/run-fixtures";

const NOW = new Date("2026-06-15T14:30:00.000Z");
const AAPL_COMMAND: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

interface RecordingRequestAdapter {
  readonly fetch: FetchLike;
  readonly urls: string[];
}

function recordingRequestAdapter(
  respond: (url: string) => Response | Promise<Response>,
): RecordingRequestAdapter {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return respond(url);
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function sourceOptions(overrides: Record<string, unknown> = {}) {
  return {
    equityMoverLimit: 2,
    cryptoMoverLimit: 2,
    newsLimit: 2,
    sourceTimeoutMs: 1000,
    ...overrides,
  };
}

function secTickers(): unknown {
  return { 0: { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } };
}

function secSubmissions(): unknown {
  return {
    sic: "3571",
    filings: {
      recent: {
        form: ["10-Q", "10-K"],
        filingDate: ["2026-05-01", "2025-11-01"],
        reportDate: ["2026-03-31", "2025-09-30"],
        accessionNumber: ["0000320193-26-000001", "0000320193-25-000001"],
        primaryDocument: ["aapl-20260331.htm", "aapl-20250930.htm"],
      },
    },
  };
}

beforeEach(() => {
  resetSourceResilienceForTests();
});

describe("deep-equity packet acquisition", () => {
  test("fetches every peer SEC/Yahoo packet once using the prefetched ticker map", async () => {
    const fixture = await loadFixture("equity-analysis-comprehensive");
    const replayFetch = makeReplayFetch(fixture.dataCassette, fixture.dir);
    const adapter = recordingRequestAdapter((url) => replayFetch(url));
    const config = createFixtureConfig(fixture.meta, fixture.dir);
    const peers = new Map([
      ["MSFT", 1],
      ["GOOGL", 2],
      ["AMZN", 3],
      ["META", 4],
      ["DELL", 5],
    ]);

    await collectSources(
      AAPL_COMMAND,
      { ...config.sourceOptions, cacheDisabled: true },
      {
        now: NOW,
        fetchImpl: adapter.fetch,
        retryDelaysMs: [],
      },
    );

    expect(adapter.urls.filter((url) => url.includes("company_tickers.json"))).toHaveLength(1);
    for (const [symbol, cik] of peers) {
      const paddedCik = String(cik).padStart(10, "0");
      expect(
        adapter.urls.filter((url) => url.includes(`/companyfacts/CIK${paddedCik}.json`)),
      ).toHaveLength(1);
      expect(
        adapter.urls.filter((url) => url.includes(`/submissions/CIK${paddedCik}.json`)),
      ).toHaveLength(1);
      expect(
        adapter.urls.filter((url) => {
          const parsed = new URL(url);
          return (
            parsed.pathname === "/v7/finance/quote" &&
            parsed.searchParams.get("symbols")?.split(",").includes(symbol)
          );
        }),
      ).toHaveLength(1);
    }
  });

  test("fetches Tradier expirations once and every unique union chain once", async () => {
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("/expirations")) {
        return json({
          expirations: {
            date: ["2026-06-22", "2026-07-17", "2026-08-14", "2026-09-11"],
          },
        });
      }
      if (url.includes("/chains")) {
        return json({
          options: {
            option: [
              {
                strike: 100,
                option_type: "call",
                bid: 4,
                ask: 5,
                greeks: { mid_iv: 0.3 },
              },
              {
                strike: 100,
                option_type: "put",
                bid: 3,
                ask: 4,
                greeks: { mid_iv: 0.32 },
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { context } = createCollectContext(
      AAPL_COMMAND,
      sourceOptions({ tradierApiToken: "fixture-token" }),
      NOW,
      adapter.fetch,
      [],
    );

    const packet = await collectTradierPacket(
      context,
      AAPL_COMMAND,
      {
        symbol: "AAPL",
        date: "2026-06-20",
        timing: "amc",
        eventDateStatus: "provider-estimated",
        dateStatus: "provider-estimated",
        sourceIds: ["extended-finnhub-events-aapl"],
        fetchedAt: NOW.toISOString(),
      },
      true,
    );

    expect(adapter.urls.filter((url) => url.includes("/expirations"))).toHaveLength(1);
    const chains = adapter.urls.filter((url) => url.includes("/chains"));
    expect(chains).toHaveLength(4);
    expect(new Set(chains).size).toBe(chains.length);
    expect(packet.eventExpiration).toBe("2026-06-22");
    expect(packet.termStructure.sources).toHaveLength(1);
  });

  test("retains SEC retries and partial filing availability without refetching facts", async () => {
    let factsAttempts = 0;
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("company_tickers.json")) {
        return json(secTickers());
      }
      if (url.includes("companyfacts")) {
        factsAttempts += 1;
        return factsAttempts < 3 ? json({ error: "retry" }, 503) : json({ facts: {} });
      }
      if (url.includes("/submissions/")) {
        return json(secSubmissions());
      }
      if (url.endsWith("aapl-20250930.htm")) {
        return new Response(
          "<html><body>ITEM 1. BUSINESS Apple designs and sells consumer devices and related services worldwide with recurring service revenue.</body></html>",
        );
      }
      if (url.endsWith("aapl-20260331.htm")) {
        return json({ missing: true }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { context } = createCollectContext(
      AAPL_COMMAND,
      sourceOptions({ secUserAgent: "market-bot tests contact@example.invalid" }),
      NOW,
      adapter.fetch,
      [0, 0],
    );

    const base = await collectSecTargetPacketBase(context, AAPL_COMMAND);
    const packet = await finalizeSecTargetPacket(context, base);

    expect(factsAttempts).toBe(3);
    expect(adapter.urls.filter((url) => url.includes("/submissions/"))).toHaveLength(1);
    expect(packet.latest10K?.form).toBe("10-K");
    expect(packet.newer10Q).toBeUndefined();
    expect(packet.filingEvidence.gaps).toHaveLength(1);
  });

  test("suppresses all SEC-dependent derivations from one failed target packet", async () => {
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("/v7/finance/quote")) {
        return json({
          quoteResponse: {
            result: [
              {
                symbol: "AAPL",
                shortName: "Apple Inc.",
                fullExchangeName: "NasdaqGS",
                currency: "USD",
                regularMarketPrice: 100,
                regularMarketChangePercent: 1,
                regularMarketVolume: 1_000_000,
                marketCap: 1_000_000_000,
              },
            ],
          },
        });
      }
      if (url.includes("finance/search")) {
        return json({ news: [] });
      }
      if (url.includes("company_tickers.json")) {
        return json(secTickers());
      }
      if (url.includes("companyfacts")) {
        return json({ error: "unavailable" }, 503);
      }
      if (url.includes("/submissions/")) {
        return json(secSubmissions());
      }
      if (url.includes("/v8/finance/chart")) {
        return json({ chart: { result: [] } });
      }
      return json({});
    });

    const result = await collectSources(AAPL_COMMAND, sourceOptions(), {
      now: NOW,
      fetchImpl: adapter.fetch,
      retryDelaysMs: [0, 0],
    });

    expect(adapter.urls.filter((url) => url.includes("companyfacts"))).toHaveLength(3);
    expect(adapter.urls.filter((url) => url.includes("/submissions/"))).toHaveLength(0);
    expect(result.secTargetPacket?.status).toBe("failed");
    expect(result.financialStatements).toBeUndefined();
    expect(result.fundamentalHistory).toBeUndefined();
    expect(result.financialLenses).toBeUndefined();
    expect(result.subsequentFinancing).toBeUndefined();
    expect(result.capitalOwnership).toBeUndefined();
    expect(result.valuationComps).toBeUndefined();
    expect(result.businessFramework).toBeUndefined();
    expect(
      result.sourceGaps.filter((gap) => gap.source.startsWith("sec-target-packet:")),
    ).toHaveLength(7);
  });

  test("short-circuits SEC and Tradier packets for an international identity", async () => {
    const command: InstrumentCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "SAP.DE",
      depth: "deep",
    };
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("/v7/finance/quote")) {
        return json({
          quoteResponse: {
            result: [
              {
                symbol: "SAP.DE",
                shortName: "SAP SE",
                fullExchangeName: "XETRA",
                currency: "EUR",
                regularMarketPrice: 200,
                regularMarketChangePercent: 0.5,
                regularMarketVolume: 500_000,
                marketCap: 250_000_000_000,
              },
            ],
          },
        });
      }
      if (url.includes("finance/search")) {
        return json({ news: [] });
      }
      if (url.includes("/v8/finance/chart")) {
        return json({ chart: { result: [] } });
      }
      return json({});
    });

    const result = await collectSources(
      command,
      sourceOptions({ tradierApiToken: "fixture-token" }),
      { now: NOW, fetchImpl: adapter.fetch, retryDelaysMs: [] },
    );

    expect(
      adapter.urls.some(
        (url) =>
          url.includes("sec.gov") || url.includes("tradier.com") || url.includes("finnhub.io"),
      ),
    ).toBe(false);
    expect(result.secTargetPacket?.status).toBe("unsupported");
    expect(result.tradierPacket?.status).toBe("unsupported");
    expect(
      result.sourceGaps.filter((gap) => gap.cause === "unsupported-coverage").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
