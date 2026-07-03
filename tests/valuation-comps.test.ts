import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import {
  collectValuationComps,
  type ValuationCompsOptions,
} from "../src/sources/extended-evidence/valuation-comps";
import type { CollectContext, FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";
import type { PeerUniverse } from "../src/research/peer-universe";
import { marketSnapshot } from "./support/fixtures";

const generatedAt = "2026-07-15T00:00:00.000Z";
const command = { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "deep" } as const;

// Cache-reader stub that always misses, mirroring the real reader's miss result.
async function cacheMiss(): Promise<PeerUniverse | undefined> {
  return undefined;
}

function rawJson(adapter: string, payload: unknown, fetchedAt = generatedAt): FetchJsonResult {
  return {
    rawSnapshot: {
      id: `raw-${adapter}-${fetchedAt}`,
      adapter,
      fetchedAt,
      payload,
    },
    payload,
  };
}

function secFact(
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

function secFactUnits(current: number, prior = current - 1): { units: { USD: unknown[] } } {
  return {
    units: {
      USD: [
        secFact(prior, {
          fy: 2025,
          filed: "2025-07-01",
          start: "2025-04-01",
          end: "2025-06-29",
        }),
        secFact(current),
      ],
    },
  };
}

function secPayload(
  overrides: {
    readonly revenue?: number;
    readonly cash?: number;
    readonly debt?: number;
    readonly end?: string;
  } = {},
): unknown {
  const revenue = overrides.revenue ?? 100;
  const cash = overrides.cash ?? 10;
  const debt = overrides.debt ?? 20;
  const end = overrides.end ?? "2026-06-29";
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [secFact(revenue, { end })] } },
        GrossProfit: secFactUnits(40, 35),
        OperatingIncomeLoss: secFactUnits(25, 20),
        NetIncomeLoss: secFactUnits(20, 18),
        EarningsPerShareDiluted: {
          units: { "USD/shares": [secFact(2), secFact(1.8, { fy: 2025 })] },
        },
        CashAndCashEquivalentsAtCarryingValue: secFactUnits(cash, cash - 1),
        LongTermDebt: secFactUnits(debt, debt - 1),
        NetCashProvidedByUsedInOperatingActivities: secFactUnits(28, 22),
        PaymentsToAcquirePropertyPlantAndEquipment: secFactUnits(6, 5),
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: { shares: [secFact(9), secFact(10, { fy: 2025 })] },
        },
      },
    },
  };
}

function yahooPayload(
  overrides: Readonly<Record<string, { readonly marketCap?: number | undefined }>> = {},
): unknown {
  const defaults: Readonly<Record<string, number>> = {
    AMD: 390,
    AVGO: 590,
    ANET: 790,
    VRT: 990,
  };
  return {
    quoteResponse: {
      result: Object.entries(defaults).map(([symbol, marketCap]) => ({
        symbol,
        shortName: symbol,
        regularMarketPrice: 100,
        regularMarketChangePercent: 1,
        regularMarketVolume: 1_000_000,
        marketCap: Object.hasOwn(overrides, symbol) ? overrides[symbol]?.marketCap : marketCap,
      })),
    },
  };
}

function valuationEvidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "NVDA", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "NVDA SEC fundamentals",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-nvda-fundamentals"],
        observedAt: generatedAt,
        metrics: {
          revenue: 100,
          revenuePeriodMonths: 3,
          revenuePeriodEnd: "2026-06-29",
          cash: 10,
          debt: 20,
          sic: "3674",
          sicDescription: "Semiconductors & Related Devices",
        },
      },
      {
        category: "valuation",
        title: "NVDA Valuation Evidence",
        summary: "Valuation Evidence: target.",
        sourceIds: ["market-yahoo-equity-nvda", "extended-sec-edgar-nvda-fundamentals"],
        observedAt: generatedAt,
        metrics: {
          marketCap: 1000,
          cash: 10,
          debt: 20,
          netDebt: 10,
          enterpriseValue: 1010,
          latestPeriodRevenue: 100,
          revenuePeriodMonths: 3,
          revenuePeriodEnd: "2026-06-29",
          annualizedRevenue: 400,
          evToAnnualizedRevenue: 2.525,
          sic: "3674",
          sicDescription: "Semiconductors & Related Devices",
        },
      },
    ],
    gaps: [],
  };
}

function requestExecutor(
  options: {
    readonly quoteFetchedAt?: string;
    readonly quoteOverrides?: Readonly<Record<string, { readonly marketCap?: number | undefined }>>;
    readonly secOverrides?: Readonly<
      Record<
        string,
        {
          readonly revenue?: number;
          readonly cash?: number;
          readonly debt?: number;
          readonly end?: string;
        }
      >
    >;
    readonly sicOverrides?: Readonly<Record<string, { readonly sic?: string | undefined }>>;
  } = {},
): SourceRequestExecutor {
  const symbolByCik: Readonly<Record<string, string>> = {
    "0000000001": "AMD",
    "0000000002": "AVGO",
    "0000000003": "ANET",
    "0000000004": "VRT",
  };
  return {
    json: async ({ adapter, url }) => {
      if (adapter === "yahoo-valuation-peers") {
        return rawJson(adapter, yahooPayload(options.quoteOverrides), options.quoteFetchedAt);
      }
      if (adapter === "sec-submissions") {
        const cik = url.match(/CIK(?<cik>\d+)\.json/u)?.groups?.cik ?? "";
        const symbol = symbolByCik[cik] ?? "AMD";
        const sic = Object.hasOwn(options.sicOverrides ?? {}, symbol)
          ? options.sicOverrides?.[symbol]?.sic
          : "3674";
        return rawJson(adapter, {
          ...(sic !== undefined ? { sic } : {}),
          sicDescription: "Semiconductors & Related Devices",
        });
      }
      if (adapter === "sec-tickers") {
        return rawJson(adapter, {
          "0": { cik_str: 1, ticker: "AMD", title: "Advanced Micro Devices" },
          "1": { cik_str: 2, ticker: "AVGO", title: "Broadcom" },
          "2": { cik_str: 3, ticker: "ANET", title: "Arista Networks" },
          "3": { cik_str: 4, ticker: "VRT", title: "Vertiv" },
        });
      }
      if (adapter === "sec-companyfacts") {
        const cik = url.match(/CIK(?<cik>\d+)\.json/u)?.groups?.cik ?? "";
        const symbol = symbolByCik[cik] ?? "AMD";
        return rawJson(adapter, secPayload(options.secOverrides?.[symbol]));
      }
      throw new Error(`unexpected adapter ${adapter}`);
    },
    text: async () => {
      throw new Error("unexpected text request");
    },
  };
}

function collectContext(request: SourceRequestExecutor): CollectContext {
  return {
    command,
    fetchedAt: generatedAt,
    newsLimit: 10,
    cryptoMoverLimit: 10,
    request,
  };
}

const threePeerOptions: ValuationCompsOptions = {
  peerUniverseMappings: {
    NVDA: {
      targetSymbol: "NVDA",
      provenance: "ticker-mapping",
      peers: [
        {
          symbol: "AMD",
          name: "Advanced Micro Devices",
          role: "core",
          rationale: "GPU peer",
          sourceIds: ["nasdaq-amd"],
        },
        {
          symbol: "AVGO",
          name: "Broadcom",
          role: "core",
          rationale: "large semiconductor peer",
          sourceIds: ["nasdaq-avgo"],
        },
        {
          symbol: "ANET",
          name: "Arista Networks",
          role: "secondary",
          rationale: "AI infrastructure peer",
          sourceIds: ["nyse-anet"],
        },
      ],
      sources: [
        { sourceId: "nasdaq-amd", title: "Nasdaq listed symbol directory: AMD" },
        { sourceId: "nasdaq-avgo", title: "Nasdaq listed symbol directory: AVGO" },
        { sourceId: "nyse-anet", title: "NYSE listed symbol directory: ANET" },
      ],
    },
  },
};

describe("collectValuationComps", () => {
  test("computes supported median and IQR for usable deterministic peers", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.summary).toMatchObject({
      corePeerCount: 2,
      secondaryPeerCount: 2,
      usablePeerCount: 4,
      valuationSupportability: "supported",
      peerMedianEvToAnnualizedRevenue: 1.75,
      peerP25EvToAnnualizedRevenue: 1.375,
      peerP75EvToAnnualizedRevenue: 2.125,
    });
    expect(result.artifact.excludedPeers).toEqual([]);
    expect(
      result.extendedEvidence.items.find((item) => item.category === "valuation")?.metrics,
    ).toMatchObject({
      corePeerCount: 2,
      peerMedianEvToAnnualizedRevenue: 1.75,
      valuationSupportability: "supported",
    });
    expect(result.sources.map((source) => source.id)).toContain("market-yahoo-equity-amd");
    expect(result.sources.map((source) => source.id)).toContain(
      "extended-sec-edgar-amd-fundamentals",
    );
  });

  test("attaches submissions provenance to peer SIC even without recent filings", async () => {
    // The fixture submissions payload carries a SIC but no filings, so the
    // Submissions source must still be emitted and referenced by the row.
    const result = await collectValuationComps(
      collectContext(requestExecutor({ sicOverrides: { AVGO: { sic: undefined } } })),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    const amd = result.artifact.peers.find((peer) => peer.symbol === "AMD");
    expect(amd?.sic).toBe("3674");
    expect(amd?.sourceIds).toContain("extended-sec-edgar-amd-filings");
    expect(
      result.sources.find((source) => source.id === "extended-sec-edgar-amd-filings")?.url,
    ).toBe("https://data.sec.gov/submissions/CIK0000000001.json");

    const avgo = result.artifact.peers.find((peer) => peer.symbol === "AVGO");
    expect(avgo?.sic).toBeUndefined();
    expect(avgo?.sourceIds).not.toContain("extended-sec-edgar-avgo-filings");
    expect(result.sources.some((source) => source.id === "extended-sec-edgar-avgo-filings")).toBe(
      false,
    );
  });

  test("excludes peers whose two-digit SIC group differs from the target", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor({ sicOverrides: { AMD: { sic: "7372" } } })),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.summary.usablePeerCount).toBe(3);
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "AMD",
        reason: "SIC group mismatch (peer 73 vs target 36)",
      }),
    ]);
  });

  test("excludes peers missing SIC classification with a deterministic reason", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor({ sicOverrides: { AMD: { sic: undefined } } })),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({ symbol: "AMD", reason: "missing SIC classification" }),
    ]);
  });

  test("excludes every peer when the target SIC is unavailable", async () => {
    const evidence = valuationEvidence();
    const noSicItems = evidence.items.map((item) =>
      item.category === "valuation"
        ? {
            ...item,
            metrics: Object.fromEntries(
              Object.entries(item.metrics ?? {}).filter(
                ([key]) => key !== "sic" && key !== "sicDescription",
              ),
            ),
          }
        : item,
    );
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      { ...evidence, items: noSicItems },
    );

    expect(result.artifact.summary.usablePeerCount).toBe(0);
    expect(result.artifact.summary.valuationSupportability).toBe("screening-only");
    expect(result.artifact.excludedPeers[0]?.reason).toBe("target SIC classification unavailable");
  });

  test("market cap gate is inclusive at 0.2x and 5x and excludes outside it", async () => {
    const boundary = await collectValuationComps(
      collectContext(
        requestExecutor({ quoteOverrides: { AMD: { marketCap: 200 }, AVGO: { marketCap: 5000 } } }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );
    expect(boundary.artifact.summary.usablePeerCount).toBe(4);
    expect(boundary.artifact.excludedPeers).toEqual([]);

    const outside = await collectValuationComps(
      collectContext(
        requestExecutor({
          quoteOverrides: { AMD: { marketCap: 199 }, AVGO: { marketCap: 5001 } },
        }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );
    expect(outside.artifact.summary.usablePeerCount).toBe(2);
    expect(outside.artifact.excludedPeers).toEqual([
      expect.objectContaining({ symbol: "AMD", reason: "market cap outside 0.2x-5x of target" }),
      expect.objectContaining({ symbol: "AVGO", reason: "market cap outside 0.2x-5x of target" }),
    ]);
  });

  test("annualized revenue gate is inclusive at 0.2x and 5x and excludes outside it", async () => {
    const boundary = await collectValuationComps(
      collectContext(
        requestExecutor({ secOverrides: { AMD: { revenue: 20 }, AVGO: { revenue: 500 } } }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );
    expect(boundary.artifact.summary.usablePeerCount).toBe(4);
    expect(boundary.artifact.excludedPeers).toEqual([]);

    const outside = await collectValuationComps(
      collectContext(
        requestExecutor({ secOverrides: { AMD: { revenue: 19 }, AVGO: { revenue: 501 } } }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );
    expect(outside.artifact.summary.usablePeerCount).toBe(2);
    expect(outside.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "AMD",
        reason: "annualized revenue outside 0.2x-5x of target",
      }),
      expect.objectContaining({
        symbol: "AVGO",
        reason: "annualized revenue outside 0.2x-5x of target",
      }),
    ]);
  });

  test("labels comps screening-only when fewer than three peers are usable", async () => {
    const result = await collectValuationComps(
      collectContext(
        requestExecutor({
          secOverrides: {
            ANET: { end: "2025-01-01" },
            VRT: { end: "2025-01-01" },
          },
        }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.summary).toMatchObject({
      usablePeerCount: 2,
      valuationSupportability: "screening-only",
    });
    expect(result.artifact.excludedPeers.map((peer) => peer.symbol)).toEqual(["ANET", "VRT"]);
    expect(result.gaps.map((gap) => gap.message)).toContain(
      "Valuation peer comps screening-only for NVDA: 2 usable peers",
    );
  });

  test("labels comps not-supportable when target SEC period is stale", async () => {
    const evidence = valuationEvidence();
    const staleValuation = evidence.items.map((item) =>
      item.category === "valuation"
        ? { ...item, metrics: { ...item.metrics, revenuePeriodEnd: "2025-01-01" } }
        : item,
    );
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      { ...evidence, items: staleValuation },
    );

    expect(result.artifact.summary.valuationSupportability).toBe("not-supportable");
  });

  test("labels comps not-supportable when target SEC period is future-dated", async () => {
    const evidence = valuationEvidence();
    const futureValuation = evidence.items.map((item) =>
      item.category === "valuation"
        ? { ...item, metrics: { ...item.metrics, revenuePeriodEnd: "2026-07-16" } }
        : item,
    );
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      { ...evidence, items: futureValuation },
    );

    expect(result.artifact.summary.valuationSupportability).toBe("not-supportable");
    expect(result.artifact.freshnessFlags.targetSecFresh).toBe(false);
  });

  test("excludes peers with stale quote data", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor({ quoteFetchedAt: "2026-07-14T00:00:00.000Z" })),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.summary.usablePeerCount).toBe(0);
    expect(result.artifact.excludedPeers).toHaveLength(4);
    expect(result.artifact.freshnessFlags.peerQuoteFresh).toBe(false);
    expect(result.artifact.excludedPeers[0]?.reason).toBe("stale quote");
  });

  test("excludes peers with future-dated SEC periods", async () => {
    const result = await collectValuationComps(
      collectContext(
        requestExecutor({
          secOverrides: {
            AMD: { end: "2026-07-16" },
            AVGO: { end: "2026-07-16" },
            ANET: { end: "2026-07-16" },
            VRT: { end: "2026-07-16" },
          },
        }),
      ),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.summary.usablePeerCount).toBe(0);
    expect(result.artifact.freshnessFlags.peerSecFresh).toBe(false);
    expect(result.artifact.excludedPeers[0]?.reason).toBe("missing SEC revenue");
  });

  test("excludes peers with missing required fields", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor({ quoteOverrides: { AMD: { marketCap: undefined } } })),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
    );

    expect(result.artifact.excludedPeers[0]).toMatchObject({
      symbol: "AMD",
      reason: "missing market cap",
    });
  });

  test("emits screening-only artifact and gap when no peer universe resolves", async () => {
    const zzzzCommand = { ...command, symbol: "ZZZZ" };
    const evidence: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: ["market-yahoo-equity-zzzz"],
      })),
    };
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      zzzzCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      evidence,
    );

    expect(result.artifact.summary.valuationSupportability).toBe("screening-only");
    expect(result.artifact.peers).toEqual([]);
    expect(result.artifact.freshnessFlags.peerQuoteFresh).toBe(false);
    expect(result.artifact.freshnessFlags.peerSecFresh).toBe(false);
    expect(result.gaps[0]).toMatchObject({
      source: "valuation",
      cause: "unsupported-coverage",
      evidenceQualityImpact: "extended-evidence-cap",
    });
  });

  test("resolves AAPL to deterministic peer universe with usable peers", async () => {
    const aaplCommand = { ...command, symbol: "AAPL" };
    const aaplValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "AAPL", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds.map((id) => id.replace("nvda", "aapl")),
      })),
    };
    const aaplExecutor: SourceRequestExecutor = {
      json: async ({ adapter }) => {
        if (adapter === "yahoo-valuation-peers") {
          return rawJson(adapter, {
            quoteResponse: {
              result: ["MSFT", "GOOGL", "AMZN", "META", "DELL"].map((symbol) => ({
                symbol,
                shortName: symbol,
                regularMarketPrice: 100,
                regularMarketChangePercent: 1,
                regularMarketVolume: 1_000_000,
                marketCap: 500,
              })),
            },
          });
        }
        if (adapter === "sec-tickers") {
          return rawJson(adapter, {
            "0": { cik_str: 10, ticker: "MSFT", title: "Microsoft" },
            "1": { cik_str: 11, ticker: "GOOGL", title: "Alphabet" },
            "2": { cik_str: 12, ticker: "AMZN", title: "Amazon" },
            "3": { cik_str: 13, ticker: "META", title: "Meta" },
            "4": { cik_str: 14, ticker: "DELL", title: "Dell" },
          });
        }
        if (adapter === "sec-companyfacts") {
          return rawJson(adapter, secPayload());
        }
        if (adapter === "sec-submissions") {
          return rawJson(adapter, {
            sic: "3674",
            sicDescription: "Semiconductors & Related Devices",
          });
        }
        throw new Error(`unexpected adapter ${adapter}`);
      },
      text: async () => {
        throw new Error("unexpected text request");
      },
    };
    const result = await collectValuationComps(
      collectContext(aaplExecutor),
      aaplCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-aapl",
          symbol: "AAPL",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      aaplValuation,
    );

    expect(result.artifact.summary.usablePeerCount).toBeGreaterThanOrEqual(3);
    expect(result.artifact.summary.valuationSupportability).toBe("supported");
    expect(result.artifact.peers.map((peer) => peer.symbol)).toContain("MSFT");
    expect(result.artifact.peers.map((peer) => peer.symbol)).toContain("GOOGL");
  });

  test("uses injected peer universe mappings", async () => {
    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      command,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-nvda",
          symbol: "NVDA",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      valuationEvidence(),
      threePeerOptions,
    );

    expect(result.artifact.peers.map((peer) => peer.symbol)).toEqual(["AMD", "AVGO", "ANET"]);
    expect(result.artifact.summary.usablePeerCount).toBe(3);
    expect(result.artifact.summary.valuationSupportability).toBe("supported");
    expect(result.artifact.summary.peerMedianEvToAnnualizedRevenue).toBeDefined();
    expect(result.artifact.summary.peerP25EvToAnnualizedRevenue).toBeDefined();
    expect(result.artifact.summary.peerP75EvToAnnualizedRevenue).toBeDefined();
  });

  test("cached peer universes cannot bypass comparability gates", async () => {
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds.map((id) => id.replace("nvda", "zzzz")),
      })),
    };
    const cachedUniverse: PeerUniverse = {
      targetSymbol: "ZZZZ",
      provenance: "model-proposed-validated",
      peers: [
        {
          symbol: "AMD",
          name: "Advanced Micro Devices",
          role: "core",
          rationale: "peer",
          sourceIds: ["sec-company-tickers"],
        },
        {
          symbol: "AVGO",
          name: "Broadcom",
          role: "core",
          rationale: "peer",
          sourceIds: ["sec-company-tickers"],
        },
        {
          symbol: "ANET",
          name: "Arista Networks",
          role: "secondary",
          rationale: "peer",
          sourceIds: ["sec-company-tickers"],
        },
      ],
      sources: [
        {
          sourceId: "sec-company-tickers",
          title: "SEC company_tickers.json directory",
          url: "https://www.sec.gov/files/company_tickers.json",
        },
      ],
    };
    const cachedOptions: ValuationCompsOptions = {
      peerUniverseFallback: {
        cacheRead: async () => cachedUniverse,
        cacheWrite: async () => {},
        propose: async () => {
          throw new Error("cache hit must not propose");
        },
      },
    };

    const result = await collectValuationComps(
      collectContext(requestExecutor({ sicOverrides: { AMD: { sic: "7372" } } })),
      unmappedCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      unmappedValuation,
      cachedOptions,
    );

    expect(result.artifact.summary.usablePeerCount).toBe(2);
    expect(result.artifact.summary.valuationSupportability).toBe("screening-only");
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "AMD",
        reason: "SIC group mismatch (peer 73 vs target 36)",
      }),
    ]);
  });

  test("resolves model-proposed-validated universe via injected fallback", async () => {
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds.map((id) => id.replace("nvda", "zzzz")),
      })),
    };
    const fallbackOptions: ValuationCompsOptions = {
      peerUniverseFallback: {
        cacheRead: cacheMiss,
        cacheWrite: async () => {},
        propose: async (symbol) => ({
          universe: {
            targetSymbol: symbol,
            provenance: "model-proposed-validated",
            peers: [
              {
                symbol: "AMD",
                name: "Advanced Micro Devices",
                role: "core",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
              {
                symbol: "AVGO",
                name: "Broadcom",
                role: "core",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
              {
                symbol: "ANET",
                name: "Arista Networks",
                role: "secondary",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
            ],
            sources: [
              {
                sourceId: "sec-company-tickers",
                title: "SEC company_tickers.json directory",
                url: "https://www.sec.gov/files/company_tickers.json",
              },
            ],
          },
          audit: {
            proposed: 3,
            survived: 3,
            rejectedByDirectory: 0,
            rejectedByEtf: 0,
            rejectedByListing: 0,
            modelId: "test-model",
          },
        }),
      },
    };

    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      unmappedCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      unmappedValuation,
      fallbackOptions,
    );

    expect(result.artifact.provenance).toBe("model-proposed-validated");
    expect(result.artifact.peers.map((peer) => peer.symbol)).toEqual(["AMD", "AVGO", "ANET"]);
    const valuationSummary = result.extendedEvidence.items.find(
      (item) => item.category === "valuation",
    )?.summary;
    expect(valuationSummary).toContain("Peer set provenance: model-proposed");
  });

  test("model-proposed candidates cannot bypass comparability gates", async () => {
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds.map((id) => id.replace("nvda", "zzzz")),
      })),
    };
    const fallbackOptions: ValuationCompsOptions = {
      peerUniverseFallback: {
        cacheRead: cacheMiss,
        cacheWrite: async () => {},
        propose: async (symbol) => ({
          universe: {
            targetSymbol: symbol,
            provenance: "model-proposed-validated",
            peers: [
              {
                symbol: "AMD",
                name: "Advanced Micro Devices",
                role: "core",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
              {
                symbol: "AVGO",
                name: "Broadcom",
                role: "core",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
              {
                symbol: "ANET",
                name: "Arista Networks",
                role: "secondary",
                rationale: "peer",
                sourceIds: ["sec-company-tickers"],
              },
            ],
            sources: [
              {
                sourceId: "sec-company-tickers",
                title: "SEC company_tickers.json directory",
                url: "https://www.sec.gov/files/company_tickers.json",
              },
            ],
          },
          audit: {
            proposed: 3,
            survived: 3,
            rejectedByDirectory: 0,
            rejectedByEtf: 0,
            rejectedByListing: 0,
            modelId: "test-model",
          },
        }),
      },
    };

    const result = await collectValuationComps(
      collectContext(requestExecutor({ sicOverrides: { ANET: { sic: "7372" } } })),
      unmappedCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      unmappedValuation,
      fallbackOptions,
    );

    expect(result.artifact.provenance).toBe("model-proposed-validated");
    expect(result.artifact.summary.usablePeerCount).toBe(2);
    expect(result.artifact.summary.valuationSupportability).toBe("screening-only");
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "ANET",
        reason: "SIC group mismatch (peer 73 vs target 36)",
      }),
    ]);
  });

  test("falls back to unsupported-coverage gap when fallback yields too few survivors", async () => {
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
    };
    const fallbackOptions: ValuationCompsOptions = {
      peerUniverseFallback: {
        cacheRead: cacheMiss,
        cacheWrite: async () => {},
        propose: async () => ({
          audit: {
            proposed: 1,
            survived: 1,
            rejectedByDirectory: 0,
            rejectedByEtf: 0,
            rejectedByListing: 0,
            modelId: "test-model",
          },
        }),
      },
    };

    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      unmappedCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      unmappedValuation,
      fallbackOptions,
    );

    expect(result.artifact.peers).toEqual([]);
    expect(result.artifact.provenance).toBeUndefined();
    expect(result.gaps[0]).toMatchObject({ cause: "unsupported-coverage" });
  });

  test("without fallback an unmapped ticker still emits unsupported-coverage gap", async () => {
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
    };

    const result = await collectValuationComps(
      collectContext(requestExecutor()),
      unmappedCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-zzzz",
          symbol: "ZZZZ",
          marketCap: 1000,
          observedAt: generatedAt,
        }),
      ],
      unmappedValuation,
    );

    expect(result.artifact.peers).toEqual([]);
    expect(result.gaps[0]).toMatchObject({ cause: "unsupported-coverage" });
  });
});
