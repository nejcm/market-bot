import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import { collectValuationComps } from "../src/sources/extended-evidence/valuation-comps";
import type { CollectContext, FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";
import { marketSnapshot } from "./support/fixtures";

const generatedAt = "2026-07-15T00:00:00.000Z";
const command = { jobType: "ticker", assetClass: "equity", symbol: "NVDA", depth: "deep" } as const;

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
  } = {},
): SourceRequestExecutor {
  return {
    json: async ({ adapter, url }) => {
      if (adapter === "yahoo-valuation-peers") {
        return rawJson(adapter, yahooPayload(options.quoteOverrides), options.quoteFetchedAt);
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
        const symbolByCik: Readonly<Record<string, string>> = {
          "0000000001": "AMD",
          "0000000002": "AVGO",
          "0000000003": "ANET",
          "0000000004": "VRT",
        };
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
    expect(result.gaps[0]).toMatchObject({
      source: "valuation",
      cause: "unsupported-coverage",
      evidenceQualityImpact: "extended-evidence-cap",
    });
  });
});
