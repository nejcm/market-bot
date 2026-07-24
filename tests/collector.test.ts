import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { legacyMarketOverviewCommand } from "./support/commands";
import type { ModelProvider } from "../src/model/types";
import { rankMovers } from "../src/movers/ranking";
import { summarizeMarketRegime } from "../src/research/regime";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import { collectSources, researchNewsRelevanceTargets } from "../src/sources/collector";
import {
  createCollectContext,
  resetSourceResilienceForTests,
  setSourceHostMinDelayMsForTests,
} from "../src/sources/source-request";
import { recordSeenNewsSources } from "../src/sources/news-seen";

function jsonResponse(payload: unknown): Response {
  return Response.json(payload);
}

function textResponse(payload: string): Response {
  return new Response(payload, { headers: { "content-type": "text/plain" } });
}

function listedCommonStocksPayload(symbols: readonly string[]): string {
  return [
    "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    ...symbols.map((symbol) => `${symbol}|${symbol} Inc. Common Stock|Q|N|N|100|N|N`),
  ].join("\n");
}

let tmpDirs: string[] = [];

beforeEach(() => {
  resetSourceResilienceForTests();
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempSeenPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "collector-news-seen-test-"));
  tmpDirs.push(dir);
  return join(dir, "news-seen.json");
}

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collector-cache-test-"));
  tmpDirs.push(dir);
  return dir;
}

function collectorQuote(symbol: string, marketCap: number): Record<string, unknown> {
  return {
    symbol,
    shortName: symbol,
    regularMarketPrice: 100,
    regularMarketChangePercent: 1,
    regularMarketVolume: 1_000_000,
    marketCap,
  };
}

function collectorSecFact(
  val: number,
  overrides: Record<string, number | string> = {},
): Record<string, number | string> {
  return {
    val,
    form: "10-Q",
    fp: "Q2",
    fy: 2026,
    filed: "2026-07-01",
    start: "2026-04-01",
    end: "2026-06-29",
    ...overrides,
  };
}

function collectorSecFactUnits(
  current: number,
  prior = current - 1,
): { units: { USD: unknown[] } } {
  return {
    units: {
      USD: [
        collectorSecFact(prior, {
          fy: 2025,
          filed: "2025-07-01",
          start: "2025-04-01",
          end: "2025-06-29",
        }),
        collectorSecFact(current),
      ],
    },
  };
}

function collectorSecPayload(revenue = 100): unknown {
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [collectorSecFact(revenue)] } },
        GrossProfit: collectorSecFactUnits(40, 35),
        OperatingIncomeLoss: collectorSecFactUnits(25, 20),
        NetIncomeLoss: collectorSecFactUnits(20, 18),
        EarningsPerShareDiluted: {
          units: { "USD/shares": [collectorSecFact(2), collectorSecFact(1.8, { fy: 2025 })] },
        },
        CashAndCashEquivalentsAtCarryingValue: collectorSecFactUnits(10, 9),
        LongTermDebt: collectorSecFactUnits(20, 19),
        NetCashProvidedByUsedInOperatingActivities: collectorSecFactUnits(28, 22),
        PaymentsToAcquirePropertyPlantAndEquipment: collectorSecFactUnits(6, 5),
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: { shares: [collectorSecFact(9), collectorSecFact(10, { fy: 2025 })] },
        },
      },
    },
  };
}

describe("collectSources", () => {
  test("returns a gap when a cached text fetch hydrates a non-string payload", async () => {
    const cacheDir = tempCacheDir();
    const { context } = createCollectContext(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      {
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 5,
        sourceTimeoutMs: 100,
        cacheDir,
      },
      new Date("2026-05-20T00:00:00.000Z"),
      async () => jsonResponse({ value: 42 }),
      [],
    );

    const request = { url: "https://example.test/filing", adapter: "sec-filing-text" };
    await context.request.json(request);

    const textResult = await context.request.text(request);

    expect(textResult).toEqual(
      expect.objectContaining({
        source: "sec-filing-text",
        message: "cached text payload was not a string",
        cause: "provider-data-missing",
      }),
    );
  });

  test("returns a gap when a cached JSON fetch hydrates a non-object payload", async () => {
    const cacheDir = tempCacheDir();
    const { context } = createCollectContext(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      {
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 5,
        sourceTimeoutMs: 100,
        cacheDir,
      },
      new Date("2026-05-20T00:00:00.000Z"),
      async () => textResponse("plain text"),
      [],
    );

    const request = { url: "https://example.test/json", adapter: "test-json" };
    await context.request.text(request);

    const jsonResult = await context.request.json(request);

    expect(jsonResult).toEqual(
      expect.objectContaining({
        source: "test-json",
        message: "cached JSON payload was not an object or array",
        cause: "provider-data-missing",
      }),
    );
  });

  test("returns a gap when a provider response exceeds the byte cap", async () => {
    const { context } = createCollectContext(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      { equityMoverLimit: 5, cryptoMoverLimit: 5, newsLimit: 5, sourceTimeoutMs: 100 },
      new Date("2026-05-20T00:00:00.000Z"),
      async () =>
        new Response("", {
          headers: { "content-length": "5000001" },
        }),
      [],
    );

    const result = await context.request.text({
      url: "https://example.test/oversized",
      adapter: "oversized-source",
    });

    expect(result).toEqual(
      expect.objectContaining({
        source: "oversized-source",
        message: "oversized-source source response exceeded 5000000 bytes",
        cause: "fetch-failed",
      }),
    );
  });

  test("merges valuation comps artifacts, peer sources, raw snapshots, and gaps", async () => {
    const marketCaps: Readonly<Record<string, number>> = {
      NVDA: 1000,
      AMD: 390,
      AVGO: 590,
      ANET: 790,
      VRT: 990,
    };
    const cikBySymbol: Readonly<Record<string, number>> = {
      NVDA: 1,
      AMD: 2,
      AVGO: 3,
      ANET: 4,
      VRT: 5,
    };
    let nvdaCompanyFactsRequests = 0;
    const recordedRequests: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      recordedRequests.push(url);
      if (url.includes("/v7/finance/quote")) {
        const symbols = new URL(url).searchParams.get("symbols")?.split(",") ?? [];
        return jsonResponse({
          quoteResponse: {
            result: symbols.map((symbol) =>
              collectorQuote(symbol, marketCaps[symbol] ?? 100_000_000),
            ),
          },
        });
      }

      if (url.includes("finance/search")) {
        return jsonResponse({ news: [] });
      }

      if (url.includes("company_tickers.json")) {
        return jsonResponse(
          Object.fromEntries(
            Object.entries(cikBySymbol).map(([symbol, cik], index) => [
              String(index),
              { cik_str: cik, ticker: symbol, title: symbol },
            ]),
          ),
        );
      }

      if (url.includes("companyfacts")) {
        if (url.includes("CIK0000000001")) {
          nvdaCompanyFactsRequests += 1;
        }
        return jsonResponse(collectorSecPayload());
      }

      if (url.includes("submissions")) {
        return jsonResponse({
          sic: "3674",
          sicDescription: "Semiconductors & Related Devices",
          filings: { recent: { form: [], filingDate: [] } },
        });
      }

      if (url.includes("/v8/finance/chart")) {
        return jsonResponse({ chart: { result: [] } });
      }

      return jsonResponse({});
    };

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "deep" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        cacheDir: tempCacheDir(),
      },
      { now: new Date("2026-07-15T00:00:00.000Z"), fetchImpl },
    );

    expect(result.valuationComps?.summary).toMatchObject({
      usablePeerCount: 4,
      valuationSupportability: "supported",
    });
    expect(result.fundamentalHistory).toMatchObject({
      version: 1,
      symbol: "NVDA",
      sourceId: "extended-sec-edgar-nvda-fundamentals",
    });
    expect(nvdaCompanyFactsRequests).toBe(1);
    expect(recordedRequests.filter((url) => url.includes("company_tickers.json"))).toHaveLength(1);
    for (const cik of Object.values(cikBySymbol)) {
      const paddedCik = String(cik).padStart(10, "0");
      expect(
        recordedRequests.filter((url) => url.includes(`/companyfacts/CIK${paddedCik}.json`)),
      ).toHaveLength(1);
      expect(
        recordedRequests.filter((url) => url.includes(`/submissions/CIK${paddedCik}.json`)),
      ).toHaveLength(1);
    }
    const peerQuoteRequests = recordedRequests.filter((url) =>
      url.includes("/v7/finance/quote?symbols=AMD%2CAVGO%2CANET%2CVRT"),
    );
    expect(peerQuoteRequests).toHaveLength(1);
    expect(
      result.rawSnapshots.filter((snapshot) => snapshot.adapter === "sec-companyfacts"),
    ).toHaveLength(5);
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain(
      "yahoo-valuation-peers",
    );
    expect(result.extendedSources.map((source) => source.id)).toContain("market-yahoo-equity-amd");
    expect(result.extendedSources.map((source) => source.id)).toContain(
      "extended-sec-edgar-amd-fundamentals",
    );
    expect(result.sourceGaps.map((gap) => gap.source)).toContain("yahoo-verified-chart");
    expect(
      result.extendedEvidence?.items.find((item) => item.category === "valuation")?.metrics,
    ).toMatchObject({
      corePeerCount: 2,
      valuationSupportability: "supported",
    });
  });

  test("records a peer-valuation skip gap when target valuation is unavailable", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        return jsonResponse({
          quoteResponse: { result: [collectorQuote("AAPL", 1_000_000_000)] },
        });
      }
      if (url.includes("finance/search")) {
        return jsonResponse({ news: [] });
      }
      if (url.includes("company_tickers.json")) {
        return jsonResponse({ "0": { cik_str: 1, ticker: "AAPL", title: "Apple Inc." } });
      }
      if (url.includes("companyfacts")) {
        return jsonResponse({ facts: {} });
      }
      if (url.includes("submissions")) {
        return jsonResponse({ filings: { recent: { form: [], filingDate: [] } } });
      }
      if (url.includes("/v8/finance/chart")) {
        return jsonResponse({ chart: { result: [] } });
      }
      return jsonResponse({});
    };

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-07-15T00:00:00.000Z"), fetchImpl },
    );

    expect(result.valuationComps).toBeUndefined();
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "valuation-peers",
        message: "Valuation peer comps skipped for AAPL: target valuation unavailable",
        symbol: "AAPL",
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "provider-data-missing",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    );
  });

  test("resolves model-proposed peers for an unmapped deep-equity ticker and writes the cache", async () => {
    const marketCaps: Readonly<Record<string, number>> = {
      ZZZZ: 1000,
      AMD: 390,
      AVGO: 590,
      ANET: 790,
    };
    const cikBySymbol: Readonly<Record<string, number>> = {
      ZZZZ: 1,
      AMD: 2,
      AVGO: 3,
      ANET: 4,
    };
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        const symbols = new URL(url).searchParams.get("symbols")?.split(",") ?? [];
        return jsonResponse({
          quoteResponse: {
            result: symbols.map((symbol) => collectorQuote(symbol, marketCaps[symbol] ?? 100)),
          },
        });
      }
      if (url.includes("finance/search")) {
        return jsonResponse({ news: [] });
      }
      if (url.includes("company_tickers.json")) {
        return jsonResponse(
          Object.fromEntries(
            Object.entries(cikBySymbol).map(([symbol, cik], index) => [
              String(index),
              { cik_str: cik, ticker: symbol, title: symbol },
            ]),
          ),
        );
      }
      if (url.includes("nasdaqlisted.txt")) {
        return textResponse(listedCommonStocksPayload(["AMD", "AVGO", "ANET"]));
      }
      if (url.includes("otherlisted.txt")) {
        return textResponse(
          "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n",
        );
      }
      if (url.includes("listed_symbols/csv")) {
        return textResponse("Name,Symbol\n");
      }
      if (url.includes("companyfacts")) {
        return jsonResponse(collectorSecPayload());
      }
      if (url.includes("submissions")) {
        return jsonResponse({
          sic: "3674",
          sicDescription: "Semiconductors & Related Devices",
          filings: { recent: { form: [], filingDate: [] } },
        });
      }
      if (url.includes("/v8/finance/chart")) {
        return jsonResponse({ chart: { result: [] } });
      }
      return jsonResponse({});
    };

    const generate = mock(async () => ({
      content: JSON.stringify({
        peers: [
          { symbol: "AMD", name: "AMD", role: "core", rationale: "peer" },
          { symbol: "AVGO", name: "AVGO", role: "core", rationale: "peer" },
          { symbol: "ANET", name: "ANET", role: "secondary", rationale: "peer" },
        ],
      }),
      tokenEstimate: 10,
      costEstimateUsd: 0,
    }));
    const provider: ModelProvider = { name: "test-provider", generate };
    const cachePath = join(tempCacheDir(), "peer-universe-learned.json");

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "ZZZZ", depth: "deep" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      {
        now: new Date("2026-07-15T00:00:00.000Z"),
        fetchImpl,
        peerUniverse: { provider, model: "test-model", cachePath },
      },
    );

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.valuationComps?.provenance).toBe("model-proposed-validated");
    expect(result.valuationComps?.peers.map((peer) => peer.symbol)).toEqual([
      "AMD",
      "AVGO",
      "ANET",
    ]);
    const persisted = JSON.parse(readFileSync(cachePath, "utf8")) as {
      entries: { targetSymbol: string; provenance: string }[];
    };
    expect(persisted.entries).toHaveLength(1);
    expect(persisted.entries[0]).toMatchObject({
      targetSymbol: "ZZZZ",
      provenance: "model-proposed-validated",
    });
  });

  test("does not propose model peers for a brief equity run", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        const symbols = new URL(url).searchParams.get("symbols")?.split(",") ?? [];
        return jsonResponse({
          quoteResponse: { result: symbols.map((symbol) => collectorQuote(symbol, 1000)) },
        });
      }
      if (url.includes("finance/search")) {
        return jsonResponse({ news: [] });
      }
      if (url.includes("company_tickers.json")) {
        return jsonResponse({ "0": { cik_str: 1, ticker: "ZZZZ", title: "ZZZZ" } });
      }
      if (url.includes("companyfacts")) {
        return jsonResponse(collectorSecPayload());
      }
      return jsonResponse({});
    };
    const generate = mock(async () => ({ content: "{}", tokenEstimate: 0, costEstimateUsd: 0 }));
    const provider: ModelProvider = { name: "test-provider", generate };

    await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "ZZZZ", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      {
        now: new Date("2026-07-15T00:00:00.000Z"),
        fetchImpl,
        peerUniverse: {
          provider,
          model: "test-model",
          cachePath: join(tempCacheDir(), "peers.json"),
        },
      },
    );

    expect(generate).not.toHaveBeenCalled();
  });

  test("collects daily equity market data and news with injectable fetch", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({
        news: [
          {
            title: "Markets rise",
            link: "https://example.test/markets",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.rawSnapshots).toHaveLength(6);
    expect(result.marketSnapshots[0]?.symbol).toBe("AAPL");
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toContain("SPY");
    expect(result.newsSources[0]?.id).toBe("news-equity-1");
    expect(result.supplementalMarketSnapshots).toEqual([]);
    expect(result.extendedSources).toEqual([]);
    expect(result.marketContextSources).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "fred-macro",
    ]);
    expect(result.sourceGaps.find((gap) => gap.source === "marketaux-news")).toMatchObject({
      cause: "missing-credential",
      evidenceQualityImpact: "no-cap",
    });
    expect(result.sourceGaps.find((gap) => gap.source === "finnhub-news")).toMatchObject({
      cause: "missing-credential",
      evidenceQualityImpact: "no-cap",
    });
    expect(result.marketContext).toEqual({
      assetClass: "equity",
      items: [],
      gaps: [
        expect.objectContaining({
          source: "fred-macro",
          message: "MARKET_BOT_FRED_API_KEY is not set",
          evidenceQualityImpact: "no-cap",
        }),
      ],
    });
  });

  test("selects mover-relevant market-update news before generic headlines", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "ROKU",
                    shortName: "Roku Inc",
                    regularMarketPrice: 80,
                    regularMarketChangePercent: 20,
                    regularMarketVolume: 15_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              title: "Markets rise broadly",
              url: "https://example.test/markets",
              source: "Example",
              published_at: "2026-05-19T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "ROKU shares jump on streaming ad demand",
            url: "https://example.test/roku-ticker",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Roku ad demand improves",
            link: "https://example.test/roku-name",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 1,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual([
      "ROKU shares jump on streaming ad demand",
      "Roku ad demand improves",
      "Markets rise broadly",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      selectedNewsSourceCount: 3,
      selectedRelevantMoverNewsSourceCount: 2,
      selectedGenericMoverNewsSourceCount: 1,
    });
  });

  test("marks optional news provider fetch failures as no-cap news gaps", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "ROKU",
                    shortName: "Roku Inc",
                    regularMarketPrice: 80,
                    regularMarketChangePercent: 20,
                    regularMarketVolume: 15_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      if (url.includes("marketaux") || url.includes("finnhub")) {
        return new Response("forbidden", { status: 403 });
      }

      return jsonResponse({
        news: [
          {
            title: "Roku ad demand improves",
            link: "https://example.test/roku-name",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 1,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(result.newsSources).toHaveLength(1);
    expect(result.sourceGaps.find((gap) => gap.source === "marketaux-news")).toMatchObject({
      provider: "marketaux",
      capability: "news",
      cause: "fetch-failed",
      evidenceQualityImpact: "no-cap",
    });
    expect(result.sourceGaps.find((gap) => gap.source === "finnhub-news")).toMatchObject({
      provider: "finnhub",
      capability: "news",
      cause: "fetch-failed",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("respects news limit when selecting mover-relevant headlines", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "ROKU",
                    shortName: "Roku Inc",
                    regularMarketPrice: 80,
                    regularMarketChangePercent: 20,
                    regularMarketVolume: 15_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              title: "ROKU posts strongest daily move",
              url: "https://example.test/roku-marketaux",
              source: "Example",
              published_at: "2026-05-19T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "ROKU volume surges",
            url: "https://example.test/roku-finnhub",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Roku ad demand improves",
            link: "https://example.test/roku-yahoo",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 1,
        cryptoMoverLimit: 2,
        newsLimit: 1,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources).toHaveLength(1);
    expect(result.newsSources[0]?.title).toBe("ROKU posts strongest daily move");
    expect(result.newsAnalytics).toMatchObject({
      selectedNewsSourceCount: 1,
      selectedRelevantMoverNewsSourceCount: 1,
      selectedGenericMoverNewsSourceCount: 0,
    });
  });

  test("does not treat ordinary lowercase words as short ticker matches", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "BY",
                    shortName: "Byline Bancorp Inc",
                    regularMarketPrice: 35,
                    regularMarketChangePercent: 18,
                    regularMarketVolume: 150_000,
                  },
                  {
                    symbol: "FLY",
                    shortName: "Fly-E Group Inc",
                    regularMarketPrice: 10,
                    regularMarketChangePercent: 15,
                    regularMarketVolume: 200_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              title: "Investors buy value stocks while airlines fly higher",
              url: "https://example.test/ordinary-words",
              source: "Example",
              published_at: "2026-05-19T12:00:00.000Z",
            },
          ],
        });
      }

      return url.includes("finnhub") ? jsonResponse([]) : jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual([
      "Investors buy value stocks while airlines fly higher",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      selectedRelevantMoverNewsSourceCount: 0,
      selectedGenericMoverNewsSourceCount: 1,
    });
  });

  test("selects lowercase ticker-symbol news for ticker runs", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("quote")) {
        const symbols = new URL(url).searchParams.get("symbols");
        return jsonResponse({
          quoteResponse: {
            result:
              symbols === "AAPL"
                ? [
                    {
                      symbol: "AAPL",
                      regularMarketPrice: 190,
                      regularMarketChangePercent: 2,
                      regularMarketVolume: 80_000_000,
                    },
                  ]
                : [
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

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              title: "Macro rates update",
              url: "https://example.test/macro",
              source: "Example",
              published_at: "2026-05-19T12:00:00.000Z",
            },
            {
              title: "aapl earnings preview",
              url: "https://example.test/aapl",
              source: "Example",
              published_at: "2026-05-19T12:01:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([]);
      }

      return jsonResponse({
        news: [
          {
            title: "Broad market recap",
            link: "https://example.test/broad",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 1,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["aapl earnings preview"]);
    expect(result.newsAnalytics).toMatchObject({
      selectedRelevantTickerNewsSourceCount: 1,
      selectedGenericTickerNewsSourceCount: 0,
    });
  });

  test("uses resolved ticker identity name for news relevance", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("quote")) {
        const symbols = new URL(url).searchParams.get("symbols");
        return jsonResponse({
          quoteResponse: {
            result:
              symbols === "AAPL"
                ? [
                    {
                      symbol: "AAPL",
                      shortName: "Apple Inc.",
                      regularMarketPrice: 190,
                      regularMarketChangePercent: 2,
                      regularMarketVolume: 80_000_000,
                    },
                  ]
                : [
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

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              title: "Macro rates update",
              url: "https://example.test/macro",
              source: "Example",
              published_at: "2026-05-19T12:00:00.000Z",
            },
            {
              title: "Apple supplier demand improves",
              url: "https://example.test/apple",
              source: "Example",
              published_at: "2026-05-19T12:01:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 1,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.resolvedInstrumentIdentity?.displayName).toBe("Apple Inc.");
    expect(result.newsSources.map((source) => source.title)).toEqual([
      "Apple supplier demand improves",
    ]);
    expect(result.newsAnalytics).toMatchObject({
      relevantBeforeSeenFilterCount: 1,
      relevantSuppressedBySeenFilterCount: 0,
      relevantSelectedCount: 1,
      selectedRelevantTickerNewsSourceCount: 1,
      selectedGenericTickerNewsSourceCount: 0,
    });
  });

  test("collects weekly equity through market-update mover and regime sources", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "MSFT",
                    regularMarketPrice: 420,
                    regularMarketChangePercent: 3,
                    regularMarketVolume: 50_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.rawSnapshots).toHaveLength(6);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["MSFT", "SPY"]);
  });

  test("collects ticker instrument with live equity regime context", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("quote")) {
        const symbols = new URL(url).searchParams.get("symbols");
        return jsonResponse({
          quoteResponse: {
            result:
              symbols === "AAPL"
                ? [
                    {
                      symbol: "AAPL",
                      regularMarketPrice: 190,
                      regularMarketChangePercent: -1.5,
                      regularMarketVolume: 40_000_000,
                    },
                  ]
                : [
                    {
                      symbol: "SPY",
                      regularMarketPrice: 510,
                      regularMarketChangePercent: 0.4,
                      regularMarketVolume: 70_000_000,
                      fiftyDayAverage: 500,
                    },
                  ],
          },
        });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain("yahoo-ticker");
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain("yahoo-regime");
  });

  test("keeps regime proxies authoritative when they also appear in a mover screener", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("most_actives")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "SPY",
                    regularMarketPrice: 510,
                    regularMarketChangePercent: 0.8,
                    regularMarketVolume: 200_000_000,
                  },
                  {
                    symbol: "TSLA",
                    regularMarketPrice: 180,
                    regularMarketChangePercent: 6,
                    regularMarketVolume: 120_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("screener")) {
        return jsonResponse({ finance: { result: [{ quotes: [] }] } });
      }

      if (url.includes("quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "SPY",
                regularMarketPrice: 510,
                regularMarketChangePercent: 0.4,
                regularMarketVolume: 70_000_000,
                fiftyDayAverage: 500,
              },
            ],
          },
        });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 5, cryptoMoverLimit: 5, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    const spySnapshots = result.marketSnapshots.filter((snapshot) => snapshot.symbol === "SPY");
    expect(spySnapshots).toHaveLength(1);
    expect(spySnapshots[0]).toMatchObject({
      sourceId: "market-yahoo-equity-spy",
      changePercent24h: 0.4,
      volume: 70_000_000,
      fiftyDayAverage: 500,
    });

    const rankedSymbols = rankMovers(result.marketSnapshots, 5).map(
      (mover) => mover.snapshot.symbol,
    );
    expect(rankedSymbols).toContain("TSLA");
    expect(rankedSymbols).not.toContain("SPY");

    const regime = summarizeMarketRegime("equity", result.marketSnapshots);
    expect(regime.drivers).toContain("trend positive: 1/1 proxies above 50-day average");
  });

  test("adds sector benchmark context to equity movers without standalone snapshots", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    sector: "Technology",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("symbols=XLK")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "XLK",
                shortName: "Technology Select Sector SPDR Fund",
                regularMarketPrice: 220,
                regularMarketChangePercent: -1,
                regularMarketVolume: 20_000_000,
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(result.marketSnapshots[0]?.benchmark).toMatchObject({
      sourceId: "market-yahoo-equity-xlk",
      symbol: "XLK",
      name: "Technology Select Sector SPDR Fund",
      basis: "sector-etf",
      sector: "Technology",
      changePercent24h: -1,
    });
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain("yahoo-benchmarks");
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).not.toContain("XLK");
  });

  test("falls back to SPY benchmark when equity mover sector is missing", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots[0]?.benchmark).toMatchObject({
      sourceId: "market-yahoo-equity-spy",
      symbol: "SPY",
      basis: "broad-index",
      changePercent24h: 0.4,
    });
  });

  test("falls back to SPY benchmark when equity mover sector is unrecognized", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    sector: "Experimental Finance",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots[0]?.benchmark).toMatchObject({
      sourceId: "market-yahoo-equity-spy",
      symbol: "SPY",
      basis: "broad-index",
      sector: "Experimental Finance",
      changePercent24h: 0.4,
    });
  });

  test("does not add benchmark context when an equity mover selects itself", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "SPY",
                    regularMarketPrice: 510,
                    regularMarketChangePercent: 0.4,
                    regularMarketVolume: 70_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots[0]?.symbol).toBe("SPY");
    expect(result.marketSnapshots[0]?.benchmark).toBeUndefined();
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).not.toContain(
      "yahoo-benchmarks",
    );
  });

  test("emits no-cap gap when equity benchmark quote is missing", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    sector: "Technology",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("symbols=XLK")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots[0]?.benchmark).toBeUndefined();
    expect(result.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "yahoo-benchmarks",
        message: "Yahoo benchmark quote missing for XLK",
        evidenceQualityImpact: "no-cap",
      }),
    );
  });

  test("retries Yahoo quote route with cookie and crumb after 401", async () => {
    const requestedUrls: string[] = [];
    const seenCookies: string[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);
      seenCookies.push(new Headers(init?.headers).get("cookie") ?? "");

      if (url.includes("screener")) {
        return jsonResponse({ finance: { result: [{ quotes: [] }] } });
      }

      if (url === "https://fc.yahoo.com") {
        return new Response("", {
          status: 404,
          headers: { "set-cookie": "A3=session-cookie; Path=/;" },
        });
      }

      if (url.includes("/v1/test/getcrumb")) {
        return new Response("crumb-token");
      }

      if (url.includes("quote") && !url.includes("crumb=crumb-token")) {
        return new Response("unauthorized", { status: 401 });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(requestedUrls.some((url) => url === "https://fc.yahoo.com")).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/v1/test/getcrumb"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("crumb=crumb-token"))).toBe(true);
    expect(seenCookies).toContain("A3=session-cookie");
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["SPY"]);
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("yahoo-regime");
  });

  test("reuses same-day equivalent cache entries across daily and weekly equity runs", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "collector-cache-test-"));
    tmpDirs.push(cacheDir);
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({
        news: [
          {
            title: "Markets rise",
            link: "https://example.test/markets",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };
    const sourceOptions = {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      cacheDir,
    };
    const now = new Date("2026-05-19T00:00:00.000Z");

    const daily = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      sourceOptions,
      { now, fetchImpl },
    );
    const firstRunFetches = requestedUrls.length;
    const weekly = await collectSources(
      legacyMarketOverviewCommand("weekly", { assetClass: "equity", depth: "brief" }),
      sourceOptions,
      { now, fetchImpl },
    );

    expect(firstRunFetches).toBeGreaterThan(0);
    expect(requestedUrls).toHaveLength(firstRunFetches);
    expect(daily.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(weekly.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(weekly.sourceGaps.map((gap) => gap.source)).toEqual([
      "marketaux-news",
      "finnhub-news",
      "fred-macro",
    ]);
  });

  test("filters crypto ticker collection by symbol", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "eth",
            current_price: 3500,
            price_change_percentage_24h: 1,
            total_volume: 10_000_000_000,
          },
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
  });

  test("selects the deterministic CoinGecko symbol collision winner for crypto tickers", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            id: "bitcoin-bep2",
            symbol: "btc",
            name: "Bitcoin BEP2",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 20_000_000,
            market_cap: 600_000_000,
          },
          {
            id: "bitcoin",
            symbol: "btc",
            name: "Bitcoin",
            current_price: 103_100,
            price_change_percentage_24h: 3,
            total_volume: 40_000_000_000,
            market_cap: 600_000_000,
          },
          {
            id: "btc-proxy",
            symbol: "btc",
            name: "BTC Proxy",
            current_price: 1,
            price_change_percentage_24h: 1,
            total_volume: 100_000,
          },
        ]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots).toHaveLength(1);
    expect(result.marketSnapshots[0]).toMatchObject({
      symbol: "BTC",
      name: "Bitcoin",
      marketCap: 600_000_000,
    });
    expect(result.resolvedInstrumentIdentity).toMatchObject({
      displayName: "Bitcoin",
      providerIds: [{ provider: "coingecko", idKind: "coin-id", value: "bitcoin" }],
    });
  });

  test("preserves partial results when one source fails", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return new Response("bad gateway", { status: 502 });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
    expect(result.newsSources).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).toContain("yahoo-news");
  });

  test("keeps daily equity regime quotes when movers source fails", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return new Response("not found", { status: 404 });
      }

      if (url.includes("quote")) {
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

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["SPY"]);
    expect(result.sourceGaps[0]?.source).toBe("yahoo-gainers");
  });

  test("does not call Massive or emit a gap when key is missing", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(requestedUrls.some((url) => url.includes("massive.com"))).toBe(false);
    expect(result.supplementalMarketSnapshots).toEqual([]);
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("massive-supplemental-market");
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("massive-news");
  });

  test("collects Massive supplemental equity snapshots without changing primary movers", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
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

      if (url.includes("api.massive.com/v2/snapshot")) {
        return jsonResponse({
          tickers: [
            {
              ticker: "AAPL",
              todaysChangePerc: 9,
              day: { c: 195, o: 190, v: 90_000_000 },
              prevDay: { c: 188 },
            },
            {
              ticker: "SPY",
              todaysChangePerc: 5,
              day: { c: 512, v: 75_000_000 },
            },
          ],
        });
      }

      return jsonResponse({ results: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL", "SPY"]);
    expect(result.supplementalMarketSnapshots.map((snapshot) => snapshot.symbol)).toEqual([
      "AAPL",
      "SPY",
    ]);
    expect(rankMovers(result.marketSnapshots, 2).map((mover) => mover.snapshot.sourceId)).toEqual([
      "market-yahoo-equity-aapl",
    ]);
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toContain(
      "massive-supplemental-market",
    );
  });

  test("adds Massive equity news into provider round-robin", async () => {
    let marketAuxUrl = "";
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("marketaux")) {
        marketAuxUrl = url;
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "MarketAux equity story",
              url: "https://example.test/marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "Finnhub equity story",
            url: "https://example.test/finnhub",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      if (url.includes("v2/reference/news")) {
        return jsonResponse({
          results: [
            {
              id: "massive-1",
              title: "Massive equity story",
              article_url: "https://example.test/massive",
              publisher: { name: "Example" },
              published_utc: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("api.massive.com/v2/snapshot")) {
        return jsonResponse({ tickers: [] });
      }

      return jsonResponse({
        news: [
          {
            title: "Yahoo equity story",
            link: "https://example.test/yahoo",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 4,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
        massiveApiKey: "massive-key",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.provider)).toEqual([
      "marketaux",
      "finnhub",
      "yahoo-news",
      "massive",
    ]);
    expect(new URL(marketAuxUrl).searchParams.get("published_after")).toBe("2026-05-16");
  });

  test("does not call Massive for crypto even when configured", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(requestedUrls.some((url) => url.includes("massive.com"))).toBe(false);
    expect(result.supplementalMarketSnapshots).toEqual([]);
  });

  test("emits Massive source gap while preserving other equity providers", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("screener")) {
        return jsonResponse({
          finance: {
            result: [
              {
                quotes: [
                  {
                    symbol: "AAPL",
                    regularMarketPrice: 190,
                    regularMarketChangePercent: 2,
                    regularMarketVolume: 80_000_000,
                  },
                ],
              },
            ],
          },
        });
      }

      if (url.includes("quote")) {
        return jsonResponse({ quoteResponse: { result: [] } });
      }

      if (url.includes("massive.com")) {
        return new Response("bad gateway", { status: 502 });
      }

      return jsonResponse({ news: [] });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 2,
        sourceTimeoutMs: 1000,
        massiveApiKey: "massive-key",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["AAPL"]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([
      "yahoo-benchmarks",
      "marketaux-news",
      "finnhub-news",
      "massive-news",
      "fred-macro",
      "massive-supplemental-market",
    ]);
    expect(result.sourceGaps.find((gap) => gap.source === "massive-news")).toMatchObject({
      provider: "massive",
      capability: "news",
      cause: "fetch-failed",
      evidenceQualityImpact: "no-cap",
    });
    expect(
      result.sourceGaps.find((gap) => gap.source === "massive-supplemental-market"),
    ).toMatchObject({
      provider: "massive",
      capability: "market-data",
      cause: "fetch-failed",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("retries on transient 503 and succeeds on third attempt", async () => {
    let coinGeckoCalls = 0;
    const fetchImpl = (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        coinGeckoCalls += 1;
        if (coinGeckoCalls < 3) {
          return Promise.resolve(new Response("service unavailable", { status: 503 }));
        }
        return Promise.resolve(
          Response.json([
            {
              symbol: "btc",
              current_price: 103_000,
              price_change_percentage_24h: 2,
              total_volume: 40_000_000_000,
            },
          ]),
        );
      }
      return Promise.resolve(Response.json({ news: [] }));
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      { equityMoverLimit: 2, cryptoMoverLimit: 2, newsLimit: 2, sourceTimeoutMs: 1000 },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [0, 0] },
    );

    expect(coinGeckoCalls).toBe(3);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(["BTC"]);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual(["marketaux-news", "finnhub-news"]);
  });

  test("collects and dedupes news across MarketAux, Finnhub, and Yahoo", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "Same BTC story",
              url: "https://www.example.test/btc?utm_source=marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
              description: "MarketAux summary",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 55,
            headline: "Same BTC story!",
            url: "https://other.example.test/btc",
            source: "Example",
            datetime: 1_779_120_000,
            summary: "Finnhub summary",
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Different crypto story",
            link: "https://example.test/crypto",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources).toHaveLength(2);
    expect(result.newsSources[0]).toMatchObject({
      id: "news-crypto-1",
      provider: "marketaux",
      providerAliases: [
        {
          provider: "marketaux",
          providerArticleId: "marketaux-1",
          publisher: "Example",
        },
        {
          provider: "finnhub",
          providerArticleId: "55",
          publisher: "Example",
        },
      ],
    });
    expect(result.newsSources[1]).toMatchObject({
      id: "news-crypto-2",
      provider: "yahoo-news",
    });
    expect(result.newsAnalytics?.canonicalDuplicateNewsSourceCount).toBe(1);
    expect(result.sourceGaps.map((gap) => gap.source)).toEqual([]);
  });

  test("caps Finnhub after normalization and keeps provider round-robin order", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        return jsonResponse({
          data: [
            {
              uuid: "marketaux-1",
              title: "MarketAux story",
              url: "https://example.test/marketaux",
              source: "Example",
              published_at: "2026-05-18T12:00:00.000Z",
            },
          ],
        });
      }

      if (url.includes("finnhub")) {
        return jsonResponse([
          {
            id: 1,
            headline: "Finnhub first story",
            url: "https://example.test/finnhub-1",
            source: "Example",
            datetime: 1_779_120_000,
          },
          {
            id: 2,
            headline: "Finnhub second story",
            url: "https://example.test/finnhub-2",
            source: "Example",
            datetime: 1_779_120_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Yahoo story",
            link: "https://example.test/yahoo",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 1,
        sourceTimeoutMs: 1000,
        marketauxApiToken: "marketaux-token",
        finnhubApiToken: "finnhub-token",
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.provider)).toEqual(["marketaux"]);
    const finnhubPayload = result.rawSnapshots.find(
      (snapshot) => snapshot.adapter === "finnhub-news",
    )?.payload;
    expect(Array.isArray(finnhubPayload) ? finnhubPayload.length : 0).toBe(2);
  });

  test("suppresses previously seen news within the same research lane", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
          {
            title: "Fresh BTC story",
            link: "https://example.test/fresh",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Fresh BTC story"]);
    expect(result.newsSources[0]?.id).toBe("news-crypto-1");
    expect(result.newsAnalytics).toMatchObject({
      relevantBeforeSeenFilterCount: 2,
      relevantSuppressedBySeenFilterCount: 1,
      relevantSelectedCount: 1,
    });
    expect(result.sourceGaps.map((gap) => gap.source)).not.toContain("news-seen");
  });

  test("keeps previously seen news in a different research lane", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("weekly", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Repeated BTC story"]);
  });

  test("keeps one repeat fallback when persistent dedupe removes every news source", async () => {
    const newsSeenPath = tempSeenPath();
    await recordSeenNewsSources({
      path: newsSeenPath,
      retentionDays: 30,
      command: legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      runId: "previous-run",
      seenAt: "2026-05-18T00:00:00.000Z",
      sources: [
        {
          id: "news-crypto-1",
          title: "Repeated BTC story",
          url: "https://example.test/repeat",
          fetchedAt: "2026-05-18T00:00:00.000Z",
          kind: "news",
          assetClass: "crypto",
          provider: "yahoo-news",
        },
      ],
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      return jsonResponse({
        news: [
          {
            title: "Repeated BTC story",
            link: "https://example.test/repeat",
            publisher: "Example",
            providerPublishTime: 1_779_120_000,
          },
        ],
      });
    };

    const result = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      {
        equityMoverLimit: 2,
        cryptoMoverLimit: 2,
        newsLimit: 3,
        sourceTimeoutMs: 1000,
        newsSeenPath,
        newsSeenRetentionDays: 30,
      },
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl },
    );

    expect(result.newsSources.map((source) => source.title)).toEqual(["Repeated BTC story"]);
    expect(result.sourceGaps.find((gap) => gap.source === "news-seen")).toMatchObject({
      cause: "repeat-fallback",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("opens provider circuit on rate limit responses", async () => {
    let marketAuxCalls = 0;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("coingecko")) {
        return jsonResponse([
          {
            symbol: "btc",
            current_price: 103_000,
            price_change_percentage_24h: 2,
            total_volume: 40_000_000_000,
          },
        ]);
      }

      if (url.includes("marketaux")) {
        marketAuxCalls += 1;
        return new Response("rate limit", { status: 429 });
      }

      return jsonResponse([]);
    };
    const sourceOptions = {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      marketauxApiToken: "marketaux-token",
      finnhubApiToken: "finnhub-token",
    };

    await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      sourceOptions,
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );
    const second = await collectSources(
      legacyMarketOverviewCommand("daily", { assetClass: "crypto", depth: "brief" }),
      sourceOptions,
      { now: new Date("2026-05-19T00:00:00.000Z"), fetchImpl, retryDelaysMs: [] },
    );

    expect(marketAuxCalls).toBe(1);
    const circuitGap = second.sourceGaps.find((gap) => gap.cause === "circuit-open");
    expect(circuitGap?.message).toContain("circuit open");
    expect(circuitGap).toMatchObject({
      provider: "marketaux",
      capability: "news",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("rejects invalid test host delay overrides", () => {
    expect(() => setSourceHostMinDelayMsForTests(Number.NaN)).toThrow(RangeError);
    expect(() => setSourceHostMinDelayMsForTests(-1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Phase 2.3 — researchNewsRelevanceTargets
// ---------------------------------------------------------------------------

describe("researchNewsRelevanceTargets", () => {
  test("returns proxy + non-proxy representatives for a resolved registry subject", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    } as const;
    const targets = researchNewsRelevanceTargets(command, resolveResearchSubject(command));

    // Semiconductors: proxy=SMH (with displayName+aliases as name), plus NVDA, AMD, AVGO
    const symbols = targets.map((t) => t.symbol);
    expect(symbols).toContain("SMH");
    expect(symbols).toContain("NVDA");
    expect(symbols).toContain("AMD");
    expect(symbols).toContain("AVGO");

    // Proxy target carries the displayName for topic-level matching
    const proxyTarget = targets.find((t) => t.symbol === "SMH");
    expect(proxyTarget?.name).toContain("Semiconductors");

    // Proxy symbol should not appear twice
    expect(symbols.filter((s) => s === "SMH")).toHaveLength(1);
  });

  test("returns all representatives when there is no proxy (e.g. ai-infrastructure)", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "AI capex",
      subjectKey: "ai-infrastructure",
      depth: "brief",
    } as const;
    const targets = researchNewsRelevanceTargets(command, resolveResearchSubject(command));

    // Ai-infrastructure has no proxy; all three representatives should be returned
    const symbols = targets.map((t) => t.symbol);
    expect(symbols).toContain("NVDA");
    expect(symbols).toContain("ANET");
    expect(symbols).toContain("VRT");
  });

  test("returns empty array for unresolved subject", () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "completely unknown niche",
      depth: "brief",
    } as const;
    const targets = researchNewsRelevanceTargets(command, resolveResearchSubject(command));

    expect(targets).toHaveLength(0);
  });

  test("returns empty array for non-research job types", () => {
    const targets = researchNewsRelevanceTargets({
      jobType: "equity",
      assetClass: "equity",
      symbol: "SMH",
      depth: "brief",
    });

    expect(targets).toHaveLength(0);
  });
});
