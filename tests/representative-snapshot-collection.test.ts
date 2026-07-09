import { beforeEach, describe, expect, test } from "bun:test";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import {
  resolveResearchSubject,
  type ResolvedResearchSubject,
} from "../src/research/research-subject-identity";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import {
  collectSources,
  researchThematicNewsQuery,
  resetSourceResilienceForTests,
  setSourceHostMinDelayMsForTests,
} from "../src/sources/collector";

const generatedAt = "2026-07-09T00:00:00.000Z";
const command = {
  jobType: "research",
  assetClass: "equity",
  subject: "biotech",
  subjectKey: "biotech",
  predictionProxySymbol: "XBI",
  depth: "deep",
} as const;
const sourceOptions = {
  equityMoverLimit: 5,
  cryptoMoverLimit: 5,
  newsLimit: 5,
  sourceTimeoutMs: 1000,
};

function quote(symbol: string): Record<string, unknown> {
  return {
    symbol,
    shortName: symbol,
    regularMarketPrice: 100,
    regularMarketChangePercent: 1,
    regularMarketVolume: 1_000_000,
  };
}

function yahooPayload(symbols: readonly string[]): unknown {
  return { quoteResponse: { result: symbols.map((symbol) => quote(symbol)) } };
}

function massiveSnapshot(symbol: string): Record<string, unknown> {
  return {
    ticker: symbol,
    todaysChangePerc: 1,
    day: { c: 100, o: 99, v: 1_000_000 },
    prevDay: { c: 99 },
  };
}

function chartPayload(symbol: string): unknown {
  const start = Date.parse("2026-04-01T00:00:00.000Z") / 1000;
  const timestamps = Array.from({ length: 70 }, (_, index) => start + index * 86_400);
  return {
    chart: {
      result: [
        {
          meta: { symbol },
          timestamp: timestamps,
          indicators: {
            quote: [
              {
                open: timestamps.map((_, index) => 90 + index),
                high: timestamps.map((_, index) => 92 + index),
                low: timestamps.map((_, index) => 89 + index),
                close: timestamps.map((_, index) => 91 + index),
                volume: timestamps.map(() => 1_000_000),
              },
            ],
          },
        },
      ],
    },
  };
}

function requestedSymbols(url: string): readonly string[] {
  return (new URL(url).searchParams.get("symbols") ?? "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
}

function resolvedBiotech(): ResolvedResearchSubject {
  return resolveResearchSubject(command)!;
}

function qualityFor(
  result: Awaited<ReturnType<typeof collectSources>>,
  resolvedSubject: ResolvedResearchSubject,
) {
  const plan = buildSourcePlan(command, generatedAt, resolvedSubject);
  return assessEvidenceQuality(assessSourcePlan(plan, result, generatedAt), generatedAt);
}

beforeEach(() => {
  resetSourceResilienceForTests();
  setSourceHostMinDelayMsForTests(0);
});

describe("representative snapshot collection", () => {
  test("builds thematic news terms from the resolved subject display name and aliases", () => {
    expect(researchThematicNewsQuery(resolvedBiotech())).toEqual({
      subjectId: "biotech",
      subjectLabel: "Biotechnology",
      terms: ["Biotechnology", "biotech", "biotech stocks", "biotechnology stocks"],
    });
  });

  test("collects thematic Yahoo news and covers the news lane without classifier changes", async () => {
    const queries: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.includes("/v7/finance/quote")) {
        return Response.json(yahooPayload(requestedSymbols(url.toString())));
      }
      if (url.pathname.includes("/v1/finance/search")) {
        const query = url.searchParams.get("q") ?? "";
        queries.push(query);
        return Response.json({
          news: query.includes('"biotech"')
            ? [
                {
                  title: "Biotech funding rebounds as clinical milestones approach",
                  link: "https://example.test/biotech-funding",
                  publisher: "Example Wire",
                },
              ]
            : [],
        });
      }
      return Response.json({ news: [] });
    };

    const resolvedSubject = resolvedBiotech();
    const result = await collectSources(command, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
      resolvedSubject,
    });
    const sourcePlan = buildSourcePlan(command, generatedAt, resolvedSubject);
    const assessed = assessSourcePlan(sourcePlan, result, generatedAt);

    expect(queries).toContain(
      '"Biotechnology" OR "biotech" OR "biotech stocks" OR "biotechnology stocks"',
    );
    expect(result.newsSources.map((source) => source.title)).toContain(
      "Biotech funding rebounds as clinical milestones approach",
    );
    expect(result.newsAnalytics).toMatchObject({
      relevantBeforeSeenFilterCount: 1,
      relevantSelectedCount: 1,
    });
    expect(assessed.evidenceLanes.lanes.find((lane) => lane.lane === "news")?.status).toBe(
      "covered",
    );
  });

  test("requests every representative once and reaches medium quality when Yahoo supplies them", async () => {
    const researchRequests: string[][] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        const symbols = requestedSymbols(url);
        if (symbols.includes("XBI")) {
          researchRequests.push([...symbols]);
        }
        return Response.json(yahooPayload(symbols));
      }
      return Response.json({ news: [] });
    };

    const resolvedSubject = resolvedBiotech();
    const result = await collectSources(command, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
      resolvedSubject,
    });

    expect(researchRequests).toEqual([["XBI", "AMGN", "GILD", "VRTX"]]);
    expect(result.marketSnapshots.map((snapshot) => snapshot.symbol)).toEqual(
      expect.arrayContaining(["XBI", "AMGN", "GILD", "VRTX"]),
    );
    expect(qualityFor(result, resolvedSubject).label).toBe("medium");
  });

  test("collects verified snapshots for every deep research representative", async () => {
    const chartSymbols: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        return Response.json(yahooPayload(requestedSymbols(url)));
      }
      if (url.includes("/v8/finance/chart/")) {
        const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
        chartSymbols.push(symbol.toUpperCase());
        return Response.json(chartPayload(symbol));
      }
      return Response.json({ news: [] });
    };

    const resolvedSubject = resolvedBiotech();
    const result = await collectSources(command, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
      resolvedSubject,
    });

    expect(chartSymbols.toSorted()).toEqual(["AMGN", "GILD", "VRTX", "XBI"]);
    expect(
      result.verifiedRepresentativeSnapshots?.map((snapshot) => snapshot.symbol).toSorted(),
    ).toEqual(["AMGN", "GILD", "VRTX", "XBI"]);
    expect(
      result.rawSnapshots.filter((snapshot) => snapshot.adapter === "yahoo-verified-chart"),
    ).toHaveLength(4);
  });

  test("downgrades representative verified snapshot failures to no-cap gaps", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        return Response.json(yahooPayload(requestedSymbols(url)));
      }
      if (url.includes("/v8/finance/chart/")) {
        throw new Error("chart unavailable");
      }
      return Response.json({ news: [] });
    };

    const result = await collectSources(command, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
      resolvedSubject: resolvedBiotech(),
    });

    expect(result.verifiedRepresentativeSnapshots).toBeUndefined();
    expect(
      result.sourceGaps.filter(
        (gap) => gap.source === "yahoo-verified-chart" && gap.evidenceQualityImpact === "no-cap",
      ),
    ).toHaveLength(4);
    expect(result.sourceGaps.map((gap) => gap.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("research representative AMGN"),
        expect.stringContaining("research representative GILD"),
        expect.stringContaining("research representative VRTX"),
        expect.stringContaining("research representative XBI"),
      ]),
    );
  });

  test("keeps successful representative verified snapshots when some charts fail", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        return Response.json(yahooPayload(requestedSymbols(url)));
      }
      if (url.includes("/v8/finance/chart/")) {
        const symbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
        if (symbol.toUpperCase() === "GILD" || symbol.toUpperCase() === "VRTX") {
          throw new Error("chart unavailable");
        }
        return Response.json(chartPayload(symbol));
      }
      return Response.json({ news: [] });
    };

    const result = await collectSources(command, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
      resolvedSubject: resolvedBiotech(),
    });

    expect(
      result.verifiedRepresentativeSnapshots?.map((snapshot) => snapshot.symbol).toSorted(),
    ).toEqual(["AMGN", "XBI"]);
    expect(
      result.sourceGaps
        .filter(
          (gap) => gap.source === "yahoo-verified-chart" && gap.evidenceQualityImpact === "no-cap",
        )
        .map((gap) => gap.message),
    ).toEqual([
      expect.stringContaining("research representative GILD"),
      expect.stringContaining("research representative VRTX"),
    ]);
  });

  test("falls back after Yahoo, promotes Massive snapshots, and preserves provider provenance", async () => {
    const providerOrder: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        const symbols = requestedSymbols(url);
        if (symbols.includes("XBI")) {
          providerOrder.push("yahoo");
          return Response.json(yahooPayload(["XBI"]));
        }
        return Response.json(yahooPayload(symbols));
      }
      if (url.includes("api.massive.com/v2/snapshot")) {
        providerOrder.push("massive");
        return Response.json({
          tickers: ["XBI", "AMGN", "GILD", "VRTX"].map((symbol) => massiveSnapshot(symbol)),
        });
      }
      return Response.json({ news: [] });
    };

    const resolvedSubject = resolvedBiotech();
    const result = await collectSources(
      command,
      { ...sourceOptions, massiveApiKey: "test-key" },
      {
        now: new Date(generatedAt),
        fetchImpl,
        retryDelaysMs: [],
        resolvedSubject,
      },
    );

    expect(providerOrder).toEqual(["yahoo", "massive"]);
    expect(
      result.marketSnapshots
        .filter((snapshot) => ["AMGN", "GILD", "VRTX"].includes(snapshot.symbol))
        .map((snapshot) => snapshot.sourceId),
    ).toEqual([
      "supplemental-market-massive-equity-amgn",
      "supplemental-market-massive-equity-gild",
      "supplemental-market-massive-equity-vrtx",
    ]);
    expect(
      result.marketSnapshots
        .find((snapshot) => snapshot.symbol === "AMGN")
        ?.identity?.aliases?.map((alias) => alias.provider),
    ).toContain("massive");
    expect(
      result.supplementalMarketSnapshots.filter((snapshot) =>
        ["AMGN", "GILD", "VRTX"].includes(snapshot.symbol),
      ),
    ).toEqual([]);
    expect(
      result.sourceGaps.filter((gap) => gap.source.startsWith("yahoo-research-snapshot-")),
    ).toHaveLength(3);
    expect(qualityFor(result, resolvedSubject).label).toBe("medium");
  });

  test("records per-provider failures and remains low when required snapshots are unavailable", async () => {
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v7/finance/quote")) {
        const symbols = requestedSymbols(url);
        return Response.json(yahooPayload(symbols.includes("XBI") ? ["XBI"] : symbols));
      }
      if (url.includes("api.massive.com/v2/snapshot")) {
        return new Response("bad gateway", { status: 502 });
      }
      return Response.json({ news: [] });
    };

    const resolvedSubject = resolvedBiotech();
    const result = await collectSources(
      command,
      { ...sourceOptions, massiveApiKey: "test-key" },
      {
        now: new Date(generatedAt),
        fetchImpl,
        retryDelaysMs: [],
        resolvedSubject,
      },
    );

    for (const symbol of ["AMGN", "GILD", "VRTX"]) {
      expect(result.sourceGaps).toContainEqual(
        expect.objectContaining({
          source: `yahoo-research-snapshot-${symbol.toLowerCase()}`,
          provider: "yahoo",
        }),
      );
      expect(result.sourceGaps).toContainEqual(
        expect.objectContaining({
          source: `massive-research-snapshot-${symbol.toLowerCase()}`,
          provider: "massive",
        }),
      );
    }
    expect(qualityFor(result, resolvedSubject).label).toBe("low");
  });

  test("retains the generic research market path when no representatives resolve", async () => {
    const urls: string[] = [];
    const unresolvedCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "unknown niche",
      depth: "brief",
    } as const;
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/v7/finance/quote")) {
        return Response.json(yahooPayload(requestedSymbols(url)));
      }
      if (url.includes("/screener/predefined/saved")) {
        return Response.json({ finance: { result: [{ quotes: [] }] } });
      }
      return Response.json({ news: [] });
    };

    await collectSources(unresolvedCommand, sourceOptions, {
      now: new Date(generatedAt),
      fetchImpl,
      retryDelaysMs: [],
    });

    expect(urls.some((url) => url.includes("/screener/predefined/saved"))).toBe(true);
    expect(
      urls.some(
        (url) => url.includes("/v7/finance/quote") && requestedSymbols(url).includes("XBI"),
      ),
    ).toBe(false);
  });
});
