import { describe, expect, test } from "bun:test";
import { collectAlphaSearchFundamentals } from "../src/alpha-search/fundamentals";
import type { AlphaSearchLead } from "../src/alpha-search/report-extras";
import { sourceGap } from "../src/domain/source-gaps";
import type { FetchJsonResult, SourceRequestExecutor } from "../src/sources/types";

const FETCHED_AT = "2026-06-01T00:00:00.000Z";

function lead(symbol: string): AlphaSearchLead {
  return {
    symbol,
    exchange: "NMS",
    price: 10,
    volume: 1_000_000,
    marketCap: 500_000_000,
    discoverySources: ["apewisdom"],
    sourceIds: [`apewisdom-${symbol}`, "market-yahoo-alpha-search"],
  };
}

function fetched(payload: unknown): FetchJsonResult {
  return {
    rawSnapshot: {
      id: "sec-alpha-fundamentals-tickers",
      adapter: "sec-alpha-fundamentals-tickers",
      fetchedAt: FETCHED_AT,
      payload,
    },
    payload,
  };
}

describe("collectAlphaSearchFundamentals", () => {
  test("stamps symbols on per-company SEC fetch gaps", async () => {
    const request: SourceRequestExecutor = {
      json: async ({ adapter }) => {
        if (adapter === "sec-alpha-fundamentals-tickers") {
          return fetched({
            "0": { cik_str: 3_200_193, ticker: "AAPL", title: "Apple Inc." },
            "1": { cik_str: 789_019, ticker: "MSFT", title: "Microsoft Corp." },
          });
        }
        return sourceGap({
          source: "sec-alpha-fundamentals",
          message: "SEC companyfacts request failed",
          cause: "fetch-failed",
        });
      },
      text: async () => {
        throw new Error("unexpected text request");
      },
    };

    const result = await collectAlphaSearchFundamentals({
      leads: [lead("AAPL"), lead("MSFT")],
      request,
      analysisAsOf: FETCHED_AT,
    });

    expect(result.sourceGaps).toEqual([
      expect.objectContaining({ symbol: "AAPL", message: "SEC companyfacts request failed" }),
      expect.objectContaining({ symbol: "MSFT", message: "SEC companyfacts request failed" }),
    ]);
  });

  test("words foreign-filer facts as unsupported coverage, not absence", async () => {
    const request: SourceRequestExecutor = {
      json: async ({ adapter }) =>
        adapter === "sec-alpha-fundamentals-tickers"
          ? fetched({ "0": { cik_str: 1_513_845, ticker: "NBIS", title: "Nebius Group N.V." } })
          : fetched({
              facts: { "us-gaap": { Revenues: { units: { USD: [{ val: 1, form: "20-F" }] } } } },
            }),
      text: async () => {
        throw new Error("unexpected text request");
      },
    };

    const result = await collectAlphaSearchFundamentals({
      leads: [lead("NBIS")],
      request,
      analysisAsOf: FETCHED_AT,
    });

    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        symbol: "NBIS",
        cause: "unsupported-coverage",
        message: expect.stringContaining(
          "SEC company facts for alpha-search candidate NBIS have no 10-K/10-Q rows",
        ),
      }),
    ]);
  });
});

function at(val: number, end: string, filed: string) {
  return { val, end, filed, form: "10-K", fp: "FY", fy: Number(end.slice(0, 4)), accn: filed };
}

describe("alpha-search debt", () => {
  const debtOf = async (gaap: Record<string, unknown[]>) => {
    const request: SourceRequestExecutor = {
      json: async ({ adapter }) =>
        adapter === "sec-alpha-fundamentals-tickers"
          ? fetched({ "0": { cik_str: 875_320, ticker: "VRTX", title: "Vertex" } })
          : fetched({
              facts: {
                "us-gaap": Object.fromEntries(
                  Object.entries({
                    Revenues: [{ ...at(100, "2025-12-31", "2026-02-13"), start: "2025-01-01" }],
                    CashAndCashEquivalentsAtCarryingValue: [at(20, "2025-12-31", "2026-02-13")],
                    ...gaap,
                  }).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
                ),
              },
            }),
      text: async () => {
        throw new Error("unexpected text request");
      },
    };
    const result = await collectAlphaSearchFundamentals({
      leads: [lead("VRTX")],
      request,
      analysisAsOf: "2026-06-01T00:00:00.000Z",
    });
    return { debt: result.fundamentals[0]?.metrics.debt, gaps: result.sourceGaps };
  };

  test("drops older debt when the newest instant is incomplete", async () => {
    const { debt, gaps } = await debtOf({
      LongTermDebt: [at(33_500_000, "2014-06-30", "2014-08-01")],
      FinanceLeaseLiabilityCurrent: [at(80, "2025-12-31", "2026-02-13")],
    });
    expect(debt).toBeUndefined();
    expect(gaps).toContainEqual(
      expect.objectContaining({
        symbol: "VRTX",
        message: expect.stringContaining(
          "Incomplete SEC debt for alpha-search candidate VRTX: debt at 2025-12-31 is incomplete (no borrowing line item is tagged)",
        ),
      }),
    );
  });

  test("keeps debt resolved at the newest instant", async () => {
    const { debt, gaps } = await debtOf({ LongTermDebt: [at(100, "2025-12-31", "2026-02-13")] });
    expect(debt).toBe(100);
    expect(gaps.some((gap) => gap.message.includes("Incomplete SEC debt"))).toBe(false);
  });
});
