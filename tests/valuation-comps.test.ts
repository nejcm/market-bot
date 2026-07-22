import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import type { ExtendedEvidence } from "../src/domain/types";
import {
  collectValuationComps,
  derivePeerImpliedRange,
  MIXED_PERIOD_METRIC,
  type ValuationCompsOptions,
} from "../src/sources/extended-evidence/valuation-comps";
import type { CollectContext, FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";
import type { PeerUniverse } from "../src/research/peer-universe";
import { marketSnapshot } from "./support/fixtures";

const generatedAt = "2026-07-15T00:00:00.000Z";
const command = { jobType: "equity", assetClass: "equity", symbol: "NVDA", depth: "deep" } as const;

function impliedRangeInput(
  overrides: Partial<Parameters<typeof derivePeerImpliedRange>[0]> = {},
): Parameters<typeof derivePeerImpliedRange>[0] {
  return {
    supportability: "supported",
    usablePeerCount: 3,
    peerP25EvToAnnualizedRevenue: 1,
    peerMedianEvToAnnualizedRevenue: 2,
    peerP75EvToAnnualizedRevenue: 3,
    annualizedRevenue: 400,
    netDebt: 10,
    sharesOutstanding: 10,
    currentPrice: 79,
    quoteCurrency: "USD",
    quoteObservedAt: generatedAt,
    ...overrides,
  };
}

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

function astsValuationEvidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "ASTS", assetClass: "equity" },
    items: [
      {
        category: "valuation",
        title: "ASTS Valuation Evidence",
        summary: "Valuation Evidence: pre-commercial target.",
        sourceIds: ["market-yahoo-equity-asts", "extended-sec-edgar-asts-fundamentals"],
        observedAt: generatedAt,
        metrics: {
          marketCap: 22_000_000_000,
          cash: 141_560_000,
          debt: 500_000_000,
          netDebt: 358_440_000,
          enterpriseValue: 22_358_440_000,
          latestPeriodRevenue: 14_725_000,
          revenuePeriodMonths: 3,
          revenuePeriodEnd: "2026-06-29",
          annualizedRevenue: 58_900_000,
          evToAnnualizedRevenue: 379.6,
          sic: "4899",
          sicDescription: "Communications Services, Not Elsewhere Classified",
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

const astsPeers = [
  { symbol: "GSAT", cik: "0000000011", marketCap: 8_000_000_000, revenue: 50_000_000 },
  { symbol: "IRDM", cik: "0000000012", marketCap: 5_000_000_000, revenue: 200_000_000 },
  { symbol: "VSAT", cik: "0000000013", marketCap: 4_500_000_000, revenue: 300_000_000 },
] as const;

function astsRequestExecutor(
  options: {
    readonly quoteOverrides?: Readonly<Record<string, number>>;
    readonly sicOverrides?: Readonly<Record<string, string>>;
  } = {},
): SourceRequestExecutor {
  return {
    json: async ({ adapter, url }) => {
      if (adapter === "yahoo-valuation-peers") {
        return rawJson(adapter, {
          quoteResponse: {
            result: astsPeers.map((peer) => ({
              symbol: peer.symbol,
              shortName: peer.symbol,
              regularMarketPrice: 20,
              regularMarketChangePercent: 1,
              regularMarketVolume: 1_000_000,
              marketCap: options.quoteOverrides?.[peer.symbol] ?? peer.marketCap,
            })),
          },
        });
      }
      if (adapter === "sec-tickers") {
        return rawJson(
          adapter,
          Object.fromEntries(
            astsPeers.map((peer, index) => [
              String(index),
              { cik_str: Number(peer.cik), ticker: peer.symbol, title: peer.symbol },
            ]),
          ),
        );
      }
      const cik = url.match(/CIK(?<cik>\d+)\.json/u)?.groups?.cik ?? "";
      const peer = astsPeers.find((candidate) => candidate.cik === cik) ?? astsPeers[0];
      if (adapter === "sec-submissions") {
        return rawJson(adapter, {
          sic: options.sicOverrides?.[peer.symbol] ?? "4899",
          sicDescription: "Communications Services, Not Elsewhere Classified",
        });
      }
      if (adapter === "sec-companyfacts") {
        return rawJson(adapter, secPayload({ revenue: peer.revenue }));
      }
      throw new Error(`unexpected adapter ${adapter}`);
    },
    text: async () => {
      throw new Error("unexpected text request");
    },
  };
}

function collectContext(
  request: SourceRequestExecutor,
  contextCommand: CollectContext["command"] = command,
): CollectContext {
  return {
    command: contextCommand,
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

const astsOptions: ValuationCompsOptions = {
  peerUniverseMappings: {
    ASTS: {
      targetSymbol: "ASTS",
      provenance: "ticker-mapping",
      peers: astsPeers.map((peer, index) => ({
        symbol: peer.symbol,
        name: peer.symbol,
        role: index < 2 ? "core" : "secondary",
        rationale: "satellite communications peer",
        sourceIds: [`nasdaq-${peer.symbol.toLowerCase()}`],
      })),
      sources: astsPeers.map((peer) => ({
        sourceId: `nasdaq-${peer.symbol.toLowerCase()}`,
        title: `Nasdaq listed symbol directory: ${peer.symbol}`,
      })),
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
          identity: { quoteCurrency: "USD" },
          fundamentals: { sharesOutstanding: 10 },
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
    expect(result.artifact.impliedPriceRange).toEqual({
      status: "derived",
      label: "peer-implied price reference range",
      basis: "peer EV/annualized revenue percentiles applied to target annualized revenue",
      formula: "impliedPrice(m) = (m × annualizedRevenue − netDebt) / sharesOutstanding",
      low: 54,
      mid: 69,
      high: 84,
      position: "above-range",
      inputs: {
        peerP25EvToAnnualizedRevenue: 1.375,
        peerMedianEvToAnnualizedRevenue: 1.75,
        peerP75EvToAnnualizedRevenue: 2.125,
        annualizedRevenue: 400,
        netDebt: 10,
        sharesOutstanding: 10,
        currentPrice: 100,
        quoteCurrency: "USD",
        quoteObservedAt: generatedAt,
      },
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

  test("leaves the batched multi-peer quote-fetch gap untagged", async () => {
    // The peer quote request is batched across all peers, so its failure is not
    // Attributable to a single symbol — it must stay untagged while per-peer SEC
    // Gaps carry their owning symbol.
    const base = requestExecutor();
    const failingQuotes: SourceRequestExecutor = {
      json: async (request) =>
        request.adapter === "yahoo-valuation-peers"
          ? sourceGap({
              source: "yahoo",
              message: "Batched peer quote fetch failed: status 503",
              provider: "yahoo",
              capability: "market-data",
            })
          : base.json(request),
      text: base.text,
    };
    const result = await collectValuationComps(
      collectContext(failingQuotes),
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

    const quoteGap = result.gaps.find((gap) =>
      gap.message.includes("Batched peer quote fetch failed"),
    );
    expect(quoteGap).toBeDefined();
    expect(quoteGap).not.toHaveProperty("symbol");
  });

  test("guards mixed-period enterprise value while retaining cash and debt", async () => {
    const evidence = valuationEvidence();
    const mixedPeriodItems = evidence.items.map((item) =>
      item.category === "sec-edgar"
        ? {
            ...item,
            metrics: {
              ...item.metrics,
              cashPeriodEnd: "2026-06-29",
              debtPeriodEnd: "2026-03-01",
            },
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
      { ...evidence, items: mixedPeriodItems },
    );

    const valuation = result.extendedEvidence.items.find((item) => item.category === "valuation");
    expect(valuation?.metrics).toMatchObject({
      cash: 10,
      debt: 20,
      cashPeriodEnd: "2026-06-29",
      debtPeriodEnd: "2026-03-01",
      enterpriseValue: "mixed-period",
      netDebt: "mixed-period",
    });
    expect(valuation?.metrics?.evToAnnualizedRevenue).toBeUndefined();
    expect(valuation?.metrics?.netDebtToMarketCap).toBeUndefined();
    expect(result.artifact.target).toMatchObject({
      cash: 10,
      debt: 20,
      enterpriseValue: "mixed-period",
      netDebt: "mixed-period",
      usable: false,
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        source: "valuation",
        symbol: "NVDA",
        message:
          "Mixed-period valuation inputs for NVDA: cash period end 2026-06-29 and debt period end 2026-03-01 diverge by 120 days; enterprise value and net debt flagged as mixed-period",
      }),
    );
  });

  test("re-tags a peer SEC gap with the peer symbol when it lacks one", async () => {
    // ZZZZ has no SEC CIK match, so fetchSecCompanyFactsForSymbol emits a
    // Symbol-less "No SEC CIK match" gap; valuation-comps must attribute it to
    // The peer so it never collides with the target's gaps under a null symbol.
    const peerWithoutSecMatch: ValuationCompsOptions = {
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
              symbol: "ZZZZ",
              name: "Unlisted Peer",
              role: "secondary",
              rationale: "peer without an SEC CIK match",
              sourceIds: ["nasdaq-zzzz"],
            },
          ],
          sources: [
            { sourceId: "nasdaq-amd", title: "Nasdaq listed symbol directory: AMD" },
            { sourceId: "nasdaq-zzzz", title: "Nasdaq listed symbol directory: ZZZZ" },
          ],
        },
      },
    };
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
      peerWithoutSecMatch,
    );

    const peerGap = result.gaps.find(
      (gap) => gap.source === "sec-edgar" && gap.message === "No SEC CIK match for ZZZZ",
    );
    expect(peerGap?.symbol).toBe("ZZZZ");
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

  test("ticker-mapping peers skip the SIC-group gate but keep size gates", async () => {
    // NVDA resolves via the checked-in ticker-mapping tier: a human-audited peer
    // Set whose SIC-group gate is skipped, so a mismatched registrant SIC no
    // Longer excludes an otherwise-comparable peer. Size gates still apply.
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

    expect(result.artifact.summary.usablePeerCount).toBe(4);
    expect(result.artifact.summary.gateProfile).toBe("curated-no-sic");
    expect(result.artifact.summary.valuationSupportability).toBe("supported");
    expect(result.artifact.excludedPeers).toEqual([]);
  });

  test("ticker-mapping peers stay usable when a registrant SIC is missing", async () => {
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

    expect(result.artifact.summary.usablePeerCount).toBe(4);
    expect(result.artifact.excludedPeers).toEqual([]);
  });

  test("ticker-mapping ignores an unavailable target SIC", async () => {
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

    expect(result.artifact.summary.usablePeerCount).toBe(4);
    expect(result.artifact.summary.valuationSupportability).toBe("supported");
    expect(result.artifact.excludedPeers).toEqual([]);
  });

  test("model-proposed peers still fail the SIC-group gate on target-SIC absence", async () => {
    // Full-gate provenance (model-proposed-validated) must keep enforcing the
    // SIC checks the curated tier skips: an unavailable target SIC excludes all.
    const unmappedCommand = { ...command, symbol: "ZZZZ" };
    const unmappedValuation: ExtendedEvidence = {
      ...valuationEvidence(),
      instrument: { symbol: "ZZZZ", assetClass: "equity" },
      items: valuationEvidence().items.map((item) => ({
        ...item,
        sourceIds: item.sourceIds.map((id) => id.replace("nvda", "zzzz")),
        ...(item.category === "valuation"
          ? {
              metrics: Object.fromEntries(
                Object.entries(item.metrics ?? {}).filter(
                  ([key]) => key !== "sic" && key !== "sicDescription",
                ),
              ),
            }
          : {}),
      })),
    };
    const fallbackOptions: ValuationCompsOptions = {
      peerUniverseFallback: {
        cacheRead: async () => ({
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
        }),
        cacheWrite: async () => {},
        propose: async () => {
          throw new Error("cache hit must not propose");
        },
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

    expect(result.artifact.summary.gateProfile).toBe("full");
    expect(result.artifact.summary.usablePeerCount).toBe(0);
    expect(result.artifact.summary.valuationSupportability).toBe("screening-only");
    expect(result.artifact.excludedPeers[0]?.reason).toBe("target SIC classification unavailable");
  });

  test("subject-registry peers retain full SIC and size gates", async () => {
    const result = await collectValuationComps(
      collectContext(
        requestExecutor({
          quoteOverrides: { AVGO: { marketCap: 199 } },
          sicOverrides: { AMD: { sic: "7372" } },
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
      {
        peerUniverseMappings: {},
        subjectRegistry: [
          {
            subjectKey: "test-semiconductors",
            displayName: "Test Semiconductors",
            aliases: ["test semiconductors"],
            assetClass: "equity",
            representativeInstruments: [
              {
                symbol: "NVDA",
                name: "NVIDIA",
                instrumentType: "listed-stock",
                sourceIds: ["nasdaq-semiconductors"],
              },
              {
                symbol: "AMD",
                name: "Advanced Micro Devices",
                instrumentType: "listed-stock",
                sourceIds: ["nasdaq-semiconductors"],
              },
              {
                symbol: "AVGO",
                name: "Broadcom",
                instrumentType: "listed-stock",
                sourceIds: ["nasdaq-semiconductors"],
              },
            ],
            sources: [
              {
                sourceId: "nasdaq-semiconductors",
                title: "Nasdaq semiconductor listings",
              },
            ],
          },
        ],
      },
    );

    expect(result.artifact.summary.gateProfile).toBe("full");
    expect(result.artifact.summary.usablePeerCount).toBe(0);
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "AMD",
        reason: "SIC group mismatch (peer 73 vs target 36)",
      }),
      expect.objectContaining({
        symbol: "AVGO",
        reason: "market cap outside 0.2x-5x of target",
      }),
    ]);
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
    expect(outside.artifact.summary.gateProfile).toBe("curated-no-sic");
  });

  test("pre-commercial targets skip only the revenue band and retain named SIC and market-cap gates", async () => {
    const astsCommand = { ...command, symbol: "ASTS" };
    const result = await collectValuationComps(
      collectContext(
        astsRequestExecutor({
          quoteOverrides: { VSAT: 4_300_000_000 },
          sicOverrides: { IRDM: "7372" },
        }),
        astsCommand,
      ),
      astsCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-asts",
          symbol: "ASTS",
          marketCap: 22_000_000_000,
          observedAt: generatedAt,
        }),
      ],
      astsValuationEvidence(),
      astsOptions,
    );

    expect(result.artifact.summary).toMatchObject({
      gateProfile: "revenue-exempt",
      usablePeerCount: 1,
      valuationSupportability: "not-meaningful",
    });
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "IRDM",
        reason: "SIC gate (revenue-exempt profile): SIC group mismatch (peer 73 vs target 48)",
      }),
      expect.objectContaining({
        symbol: "VSAT",
        reason: "market-cap gate (revenue-exempt profile): market cap outside 0.2x-5x of target",
      }),
    ]);
    expect(result.artifact.excludedPeers.map((peer) => peer.reason).join(" ")).not.toContain(
      "annualized revenue",
    );
  });

  test("zero-revenue targets are not meaningful while SIC and market-cap gates still apply", async () => {
    const astsCommand = { ...command, symbol: "ASTS" };
    const zeroRevenueEvidence = astsValuationEvidence();
    const result = await collectValuationComps(
      collectContext(
        astsRequestExecutor({
          quoteOverrides: { VSAT: 4_300_000_000 },
          sicOverrides: { IRDM: "7372" },
        }),
        astsCommand,
      ),
      astsCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-asts",
          symbol: "ASTS",
          marketCap: 22_000_000_000,
          observedAt: generatedAt,
        }),
      ],
      {
        ...zeroRevenueEvidence,
        items: zeroRevenueEvidence.items.map((item) =>
          item.category === "valuation"
            ? {
                ...item,
                metrics: {
                  ...Object.fromEntries(
                    Object.entries(item.metrics ?? {}).filter(
                      ([key]) => key !== "evToAnnualizedRevenue",
                    ),
                  ),
                  latestPeriodRevenue: 0,
                  annualizedRevenue: 0,
                },
              }
            : item,
        ),
      },
      astsOptions,
    );

    expect(result.artifact.target).toMatchObject({
      annualizedRevenue: 0,
      usable: false,
    });
    expect(result.artifact.target.evToAnnualizedRevenue).toBeUndefined();
    expect(result.artifact.summary).toMatchObject({
      gateProfile: "revenue-exempt",
      usablePeerCount: 1,
      valuationSupportability: "not-meaningful",
    });
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "IRDM",
        reason: "SIC gate (revenue-exempt profile): SIC group mismatch (peer 73 vs target 48)",
      }),
      expect.objectContaining({
        symbol: "VSAT",
        reason: "market-cap gate (revenue-exempt profile): market cap outside 0.2x-5x of target",
      }),
    ]);
    expect(result.artifact.excludedPeers.map((peer) => peer.reason).join(" ")).not.toContain(
      "annualized revenue",
    );
  });

  test("ASTS-shaped target admits GSAT, IRDM, and VSAT as size/sector peers", async () => {
    const astsCommand = { ...command, symbol: "ASTS" };
    const result = await collectValuationComps(
      collectContext(astsRequestExecutor(), astsCommand),
      astsCommand,
      [
        marketSnapshot({
          sourceId: "market-yahoo-equity-asts",
          symbol: "ASTS",
          marketCap: 22_000_000_000,
          observedAt: generatedAt,
        }),
      ],
      astsValuationEvidence(),
      astsOptions,
    );

    expect(result.artifact.target.evToAnnualizedRevenue).toBe(379.6);
    expect(result.artifact.summary).toMatchObject({
      gateProfile: "revenue-exempt",
      usablePeerCount: 3,
      valuationSupportability: "not-meaningful",
    });
    expect(result.artifact.peers.filter((peer) => peer.usable).map((peer) => peer.symbol)).toEqual([
      "GSAT",
      "IRDM",
      "VSAT",
    ]);
    const targetRevenue = result.artifact.target.annualizedRevenue ?? 0;
    expect(
      result.artifact.peers.find((peer) => peer.symbol === "IRDM")?.annualizedRevenue,
    ).toBeGreaterThan(5 * targetRevenue);
    expect(
      result.artifact.peers.find((peer) => peer.symbol === "VSAT")?.annualizedRevenue,
    ).toBeGreaterThan(5 * targetRevenue);
    expect(result.artifact.summary.peerMedianEvToAnnualizedRevenue).toBeDefined();
    expect(result.artifact.excludedPeers).toEqual([]);
    const valuationItem = result.extendedEvidence.items.find(
      (item) => item.category === "valuation",
    );
    expect(valuationItem?.summary).toContain(
      "Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only.",
    );
    expect(valuationItem?.metrics).toMatchObject({
      valuationSupportability: "not-meaningful",
      valuationCaveat:
        "Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only.",
    });
    expect(result.gaps.map((gap) => gap.message)).toContain(
      "Valuation peer comps not-meaningful for ASTS: Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only. 3 usable peers passed the applicable gates",
    );
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
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        source: "valuation",
        symbol: "NVDA",
        message:
          "Peer-implied price reference range suppressed for NVDA: peer supportability is not supported",
        evidenceQualityImpact: "no-cap",
      }),
    );
    expect(
      result.gaps.find((gap) => gap.message.startsWith("Peer-implied price reference range")),
    ).not.toHaveProperty("cause");
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
      source: "valuation-peers",
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
    // Mirrors the flagship regression: the mega-cap platform peers carry a
    // Services-group registrant SIC (73) that differs from AAPL's electronics
    // SIC (35), while DELL sits below the cap band. Under the curated tier the
    // SIC-mismatched peers stay usable and only DELL is excluded on cap band.
    const cikBySymbol: Readonly<Record<string, string>> = {
      "0000000010": "MSFT",
      "0000000011": "GOOGL",
      "0000000012": "AMZN",
      "0000000013": "META",
      "0000000014": "DELL",
    };
    const aaplExecutor: SourceRequestExecutor = {
      json: async ({ adapter, url }) => {
        if (adapter === "yahoo-valuation-peers") {
          return rawJson(adapter, {
            quoteResponse: {
              result: ["MSFT", "GOOGL", "AMZN", "META", "DELL"].map((symbol) => ({
                symbol,
                shortName: symbol,
                regularMarketPrice: 100,
                regularMarketChangePercent: 1,
                regularMarketVolume: 1_000_000,
                marketCap: symbol === "DELL" ? 100 : 500,
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
          const cik = url.match(/CIK(?<cik>\d+)\.json/u)?.groups?.cik ?? "";
          const symbol = cikBySymbol[cik] ?? "MSFT";
          return rawJson(adapter, {
            sic: symbol === "DELL" ? "3571" : "7372",
            sicDescription: symbol === "DELL" ? "Electronic Computers" : "Prepackaged Software",
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

    expect(result.artifact.summary.usablePeerCount).toBe(4);
    expect(result.artifact.summary.gateProfile).toBe("curated-no-sic");
    expect(result.artifact.summary.valuationSupportability).toBe("supported");
    expect(result.artifact.peers.filter((peer) => peer.usable).map((peer) => peer.symbol)).toEqual([
      "MSFT",
      "GOOGL",
      "AMZN",
      "META",
    ]);
    expect(result.artifact.excludedPeers).toEqual([
      expect.objectContaining({
        symbol: "DELL",
        reason: "market cap outside 0.2x-5x of target",
      }),
    ]);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        source: "valuation-peers",
        message: "Peer DELL excluded from valuation comps: market cap outside 0.2x-5x of target",
      }),
    );
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

describe("derivePeerImpliedRange", () => {
  test("applies every suppression gate in order with its first-failing reason", () => {
    const { netDebt: _netDebt, ...withoutNetDebt } = impliedRangeInput();
    const { currentPrice: _currentPrice, ...withoutCurrentPrice } = impliedRangeInput();
    const { peerP25EvToAnnualizedRevenue: _peerP25, ...withoutPeerP25 } = impliedRangeInput();
    const cases: readonly {
      readonly input: Parameters<typeof derivePeerImpliedRange>[0];
      readonly reason: string;
    }[] = [
      {
        input: impliedRangeInput({ supportability: "screening-only", usablePeerCount: 2 }),
        reason: "peer supportability is not supported",
      },
      {
        input: impliedRangeInput({ usablePeerCount: 2 }),
        reason: "fewer than 3 usable peers",
      },
      {
        input: impliedRangeInput({ annualizedRevenue: 0 }),
        reason: "annualized revenue is not positive",
      },
      { input: withoutNetDebt, reason: "net debt is unavailable" },
      {
        input: impliedRangeInput({ netDebt: MIXED_PERIOD_METRIC }),
        reason: "net debt uses mixed reporting periods",
      },
      {
        input: impliedRangeInput({ sharesOutstanding: 0 }),
        reason: "shares outstanding is not positive",
      },
      {
        input: impliedRangeInput({ quoteCurrency: "EUR" }),
        reason: "quote currency is not USD",
      },
      {
        input: withoutPeerP25,
        reason: "peer percentile inputs are unavailable",
      },
      {
        input: impliedRangeInput({ peerP25EvToAnnualizedRevenue: 0 }),
        reason: "one or more implied prices are not positive",
      },
      { input: withoutCurrentPrice, reason: "current price is unavailable" },
    ];

    for (const entry of cases) {
      expect(derivePeerImpliedRange(entry.input)).toMatchObject({
        status: "suppressed",
        suppressedReason: entry.reason,
      });
    }
  });

  test("uses inclusive low and high boundaries for within-range", () => {
    expect(derivePeerImpliedRange(impliedRangeInput({ currentPrice: 38.99 }))).toMatchObject({
      position: "below-range",
    });
    expect(derivePeerImpliedRange(impliedRangeInput({ currentPrice: 39 }))).toMatchObject({
      position: "within-range",
    });
    expect(derivePeerImpliedRange(impliedRangeInput({ currentPrice: 79 }))).toMatchObject({
      position: "within-range",
    });
    expect(derivePeerImpliedRange(impliedRangeInput({ currentPrice: 119 }))).toMatchObject({
      position: "within-range",
    });
    expect(derivePeerImpliedRange(impliedRangeInput({ currentPrice: 119.01 }))).toMatchObject({
      position: "above-range",
    });
  });

  test("retains complete audit inputs on USD-gate suppression", () => {
    expect(derivePeerImpliedRange(impliedRangeInput({ quoteCurrency: "GBp" }))).toMatchObject({
      status: "suppressed",
      suppressedReason: "quote currency is not USD",
      inputs: {
        annualizedRevenue: 400,
        netDebt: 10,
        sharesOutstanding: 10,
        currentPrice: 79,
        quoteCurrency: "GBp",
        quoteObservedAt: generatedAt,
      },
    });
  });
});
