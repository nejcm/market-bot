import { beforeEach, describe, expect, test } from "bun:test";
import { assessEvidenceQuality } from "../src/research/evidence-quality";
import {
  resolveResearchSubject,
  type ResolvedResearchSubject,
} from "../src/research/research-subject-identity";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import {
  collectSources,
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
