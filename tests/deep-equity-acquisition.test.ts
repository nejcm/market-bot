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
import { WEB_GATHER_DUPLICATE_REQUEST_REASON } from "../src/sources/web-gather-rejection-reasons";
import { isCompanyProfileSecSource } from "../src/web-evidence/web-subject-profile";
import { latestSecFilingDate } from "../src/web-evidence/web-subject-profile-reuse";
import { makeReplayFetch } from "./support/run-fixtures/data-cassette";
import { createFixtureConfig, loadFixture, runFixture } from "./support/run-fixtures";

const NOW = new Date("2026-06-15T14:30:00.000Z");
const AAPL_COMMAND: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};

interface RecordingRequestAdapter {
  readonly fetch: FetchLike;
  readonly requests: readonly {
    readonly url: string;
    readonly method: string;
    readonly body?: string;
  }[];
  readonly urls: string[];
}

function recordingRequestAdapter(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordingRequestAdapter {
  const urls: string[] = [];
  const requests: {
    url: string;
    method: string;
    body?: string;
  }[] = [];
  return {
    requests,
    urls,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      requests.push({
        url,
        method: (init?.method ?? "GET").toUpperCase(),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return respond(url, init);
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

// SEC_SECTION_MIN_SELECTED_ALPHA_CHARS (A2.5) requires 300+ alpha characters for a section to
// Be selected at all. Repeats `sentence` until the alpha-character count clears `minAlpha`.
function repeatToMinAlpha(sentence: string, minAlpha = 320): string {
  let out = "";
  while ((out.match(/[A-Za-z]/gu)?.length ?? 0) < minAlpha) {
    out += `${sentence} `;
  }
  return out.trim();
}

// Pads a filing body well past the global 5MB default so it only survives under the
// SEC-scoped ceiling (SEC_FILING_TEXT_MAX_RESPONSE_BYTES, 16MB). Placed after the last
// Section-bearing content so it cannot bleed into any section's captured text (Notes'
// Own maxChars budget truncates before reaching it).
function oversizedFilingTailPadding(): string {
  return "pad ".repeat(1_600_000);
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

  // The approved plan lists "target SEC facts/submissions once" as a mandatory recording-adapter
  // Assertion, and cassette parity is explicitly insufficient for request counts.
  // The peer test above covers peer CIKs 1-5 only, so the target's own packet was unasserted.
  // AAPL is CIK 320193 here, padded to 0000320193.
  test("fetches the target SEC facts and submissions once", async () => {
    const fixture = await loadFixture("equity-analysis-comprehensive");
    const replayFetch = makeReplayFetch(fixture.dataCassette, fixture.dir);
    const adapter = recordingRequestAdapter((url) => replayFetch(url));
    const config = createFixtureConfig(fixture.meta, fixture.dir);

    await collectSources(
      AAPL_COMMAND,
      { ...config.sourceOptions, cacheDisabled: true },
      { now: NOW, fetchImpl: adapter.fetch, retryDelaysMs: [] },
    );

    expect(
      adapter.urls.filter((url) => url.includes("/companyfacts/CIK0000320193.json")),
    ).toHaveLength(1);
    expect(
      adapter.urls.filter((url) => url.includes("/submissions/CIK0000320193.json")),
    ).toHaveLength(1);
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
          `<html><body>ITEM 1. BUSINESS Apple designs and sells consumer devices and related services worldwide with recurring service revenue. ${"Additional business description continues to provide sufficient extraction context. ".repeat(6)}</body></html>`,
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
    // Filing-text ingestion failed (404) for the 10-Q, but its form/filingDate/
    // AccessionNumber/primaryDocument are known from submissions metadata alone,
    // So the packet is still retained without any filing-text enrichment.
    expect(packet.newer10Q?.form).toBe("10-Q");
    expect(packet.newer10Q?.filingDate).toBe("2026-05-01");
    expect(packet.newer10Q?.accessionNumber).toBe("0000320193-26-000001");
    expect(packet.newer10Q?.source.snippet).toBeUndefined();
    // Its provenance links to the replayable sec-submissions raw snapshot the
    // Metadata itself was read from (ADR 0004), not an unfetched filing document.
    const submissionsRawSnapshot = packet.rawSnapshots.find(
      (snapshot) => snapshot.adapter === "sec-submissions",
    );
    expect(submissionsRawSnapshot).toBeDefined();
    expect(packet.newer10Q?.source.rawRef).toBe(submissionsRawSnapshot?.id);
    // Two gaps: the 10-Q's 404 fetch failure, plus a section-omission gap for the 10-K (its
    // Fixture only supplies a Business section, so Risk Factors/MD&A/Segments/Notes are
    // Reported as omitted rather than silently absent).
    expect(packet.filingEvidence.gaps).toHaveLength(2);
    expect(packet.filingEvidence.gaps).toContainEqual(
      expect.objectContaining({
        source: "sec-edgar",
        cause: "provider-data-missing",
        message: expect.stringContaining(
          "SEC 10-K section packet for AAPL omitted Risk Factors, MD&A, Segments, Notes",
        ),
      }),
    );
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

  test("replays web gather through Exa search and Firecrawl fallback once", async () => {
    const fixture = await loadFixture("equity-web-fallback-deep");
    const replayFetch = makeReplayFetch(fixture.dataCassette, fixture.dir);
    const adapter = recordingRequestAdapter((url, init) => replayFetch(url, init));
    const result = await runFixture("equity-web-fallback-deep", {
      llm: "replay",
      fetchImpl: adapter.fetch,
    });

    try {
      const exaSearchRequests = adapter.requests.filter(
        (request) =>
          new URL(request.url).hostname === "api.exa.ai" &&
          new URL(request.url).pathname === "/search",
      );
      const firecrawlRequests = adapter.requests.filter(
        (request) => new URL(request.url).hostname === "api.firecrawl.dev",
      );
      const searchAudit = result.trace.webGatherLoop?.acceptedRequests.find(
        (request) => request.tool === "web_search",
      );
      expect({
        exaSearchCount: exaSearchRequests.length,
        firecrawlPaths: firecrawlRequests.map((request) => new URL(request.url).pathname),
        fallback: searchAudit?.fallback,
      }).toEqual({
        exaSearchCount: 1,
        firecrawlPaths: ["/v2/search"],
        fallback: {
          attemptedProviders: ["exa", "firecrawl"],
          servedProvider: "firecrawl",
          fallbackReason: "empty",
          firecrawlCreditsUsed: 3,
        },
      });

      const fetchedUrls = adapter.requests
        .filter(
          (request) =>
            new URL(request.url).hostname === "api.exa.ai" &&
            new URL(request.url).pathname === "/contents",
        )
        .map((request) => {
          const body = JSON.parse(request.body ?? "{}") as { readonly urls?: readonly string[] };
          return body.urls?.[0];
        });
      expect(fetchedUrls).toEqual([
        "https://investor.example/aapl-capital-allocation",
        "https://industry.example/apple-services-kpis",
      ]);

      expect(result.trace.webGatherLoop?.rejectedRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: "web_search",
            reason: "web_search query must mention the run subject",
          }),
          expect.objectContaining({
            tool: "web_fetch",
            reason: WEB_GATHER_DUPLICATE_REQUEST_REASON,
          }),
        ]),
      );
      expect(searchAudit?.duplicateResults).toHaveLength(1);

      const webSources =
        result.deepEquityEvidenceBundle?.evidence.extendedSources.filter(
          (source) => source.kind === "web",
        ) ?? [];
      expect({
        removedInstruction:
          (result.trace.webGatherLoop?.sanitizer.removedInstructionSpanCount ?? 0) > 0,
        removedChrome: (result.trace.webGatherLoop?.sanitizer.removedChromeHtmlCount ?? 0) > 0,
        containsUnsafeText: /ignore previous|system prompt/iu.test(JSON.stringify(webSources)),
      }).toEqual({
        removedInstruction: true,
        removedChrome: true,
        containsUnsafeText: false,
      });
      expect({
        sourceIds: webSources.map((source) => source.id),
        profile: result.deepEquityEvidenceBundle?.evidence.webSubjectProfile,
        stages: result.trace.stages,
      }).toMatchObject({
        sourceIds: ["web-aapl-6c345d05", "web-aapl-b15b01d7"],
        profile: {
          version: 3,
          subjectId: "AAPL",
          sourceIds: ["web-aapl-6c345d05", "web-aapl-b15b01d7"],
        },
        stages: expect.arrayContaining(["web-subject-profile"]),
      });
    } finally {
      await result.cleanup();
    }
  });
});

describe("SEC oversized filing text (A2)", () => {
  test("extracts all five sections from an MSFT-shaped drop-cap 10-K larger than the global default but within the SEC-scoped ceiling", async () => {
    // Reproduces the MSFT defect at real scale: drop-cap typography ("ITEM 1. B USINESS") plus
    // A response well past the global 5MB default (MSFT's real FY2026 10-K decompresses to
    // 8.6M bytes) that only survives because sec-filing-text is scoped to 16MB.
    const body = [
      `ITEM 1. B USINESS ${repeatToMinAlpha(
        "Microsoft is a technology company whose mission is to empower every person and organization on the planet to achieve more.",
        500,
      )}`,
      `ITEM 1A. RIS K FACTORS ${repeatToMinAlpha(
        "Our operations and financial results are subject to various risks and uncertainties that could adversely affect our business.",
        500,
      )}`,
      `ITEM 7. MANAGEMENT'S DISCUSSION ${repeatToMinAlpha(
        "Revenue grew across cloud and productivity segments during the period under review.",
        500,
      )}`,
      `SEGMENT INFORMATION ${repeatToMinAlpha(
        "The Company reports segment results across Productivity, Intelligent Cloud, and More Personal Computing.",
        500,
      )}`,
      `NOTES TO CONSOLIDATED FINANCIAL STATEMENTS ${repeatToMinAlpha(
        "Significant accounting policies are described in the notes to the consolidated financial statements.",
        500,
      )}`,
      oversizedFilingTailPadding(),
    ].join(" ");
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(5_000_000);

    const submissions = {
      filings: {
        recent: {
          form: ["10-K"],
          filingDate: ["2026-01-15"],
          reportDate: ["2025-12-31"],
          accessionNumber: ["0000320193-26-000010"],
          primaryDocument: ["msft-10k.htm"],
        },
      },
    };
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("company_tickers.json")) {
        return json(secTickers());
      }
      if (url.includes("companyfacts")) {
        return json({ facts: {} });
      }
      if (url.includes("/submissions/")) {
        return json(submissions);
      }
      if (url.endsWith("msft-10k.htm")) {
        return new Response(body);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { context } = createCollectContext(
      AAPL_COMMAND,
      sourceOptions({
        sourceTimeoutMs: 5000,
        secUserAgent: "market-bot tests contact@example.invalid",
      }),
      NOW,
      adapter.fetch,
      [],
    );

    const base = await collectSecTargetPacketBase(context, AAPL_COMMAND);
    const packet = await finalizeSecTargetPacket(context, base);

    expect(packet.filingEvidence.gaps).toEqual([]);
    const snippet = packet.latest10K?.source.snippet ?? "";
    expect(snippet).toContain("[Business]");
    expect(snippet).toContain("[Risk Factors]");
    expect(snippet).toContain("[MD&A]");
    expect(snippet).toContain("[Segments]");
    expect(snippet).toContain("[Notes]");
    expect(latestSecFilingDate(packet.filingEvidence)).toBe("2026-01-15");
    expect(
      packet.latest10K !== undefined && isCompanyProfileSecSource(packet.latest10K.source),
    ).toBe(true);
  }, 20_000);

  test("emits a precise omission gap naming the missing section for an oversized 10-K with no Risk Factors item at all", async () => {
    const body = [
      `ITEM 1. BUSINESS ${repeatToMinAlpha(
        "Microsoft is a technology company whose mission is to empower every person and organization on the planet to achieve more.",
        500,
      )}`,
      // Deliberately no "ITEM 1A" / Risk Factors content anywhere in the document.
      `ITEM 7. MANAGEMENT'S DISCUSSION ${repeatToMinAlpha(
        "Revenue grew across cloud and productivity segments during the period under review.",
        500,
      )}`,
      `SEGMENT INFORMATION ${repeatToMinAlpha(
        "The Company reports segment results across Productivity, Intelligent Cloud, and More Personal Computing.",
        500,
      )}`,
      `NOTES TO CONSOLIDATED FINANCIAL STATEMENTS ${repeatToMinAlpha(
        "Significant accounting policies are described in the notes to the consolidated financial statements.",
        500,
      )}`,
      oversizedFilingTailPadding(),
    ].join(" ");
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(5_000_000);

    const submissions = {
      filings: {
        recent: {
          form: ["10-K"],
          filingDate: ["2026-01-15"],
          reportDate: ["2025-12-31"],
          accessionNumber: ["0000320193-26-000010"],
          primaryDocument: ["msft-10k.htm"],
        },
      },
    };
    const adapter = recordingRequestAdapter((url) => {
      if (url.includes("company_tickers.json")) {
        return json(secTickers());
      }
      if (url.includes("companyfacts")) {
        return json({ facts: {} });
      }
      if (url.includes("/submissions/")) {
        return json(submissions);
      }
      if (url.endsWith("msft-10k.htm")) {
        return new Response(body);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { context } = createCollectContext(
      AAPL_COMMAND,
      sourceOptions({
        sourceTimeoutMs: 5000,
        secUserAgent: "market-bot tests contact@example.invalid",
      }),
      NOW,
      adapter.fetch,
      [],
    );

    const base = await collectSecTargetPacketBase(context, AAPL_COMMAND);
    const packet = await finalizeSecTargetPacket(context, base);

    const snippet = packet.latest10K?.source.snippet ?? "";
    expect(snippet).toContain("[Business]");
    expect(snippet).not.toContain("[Risk Factors]");
    expect(packet.filingEvidence.gaps).toHaveLength(1);
    expect(packet.filingEvidence.gaps[0]).toMatchObject({
      source: "sec-edgar",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    expect(packet.filingEvidence.gaps[0]?.message).toContain(
      "SEC 10-K section packet for AAPL omitted Risk Factors",
    );
    expect(packet.filingEvidence.gaps[0]?.message).toMatch(
      /\(4 of 5 sections extracted from \d+ normalized chars; \d+ response bytes\)/u,
    );
  }, 20_000);
});
