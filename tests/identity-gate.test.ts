import { describe, expect, test } from "bun:test";
import type { InstrumentCommand } from "../src/cli/args";
import { exchangeProfileFor } from "../src/domain/exchange-profile";
import { sourceGap } from "../src/domain/source-gaps";
import {
  exchangeProfileGaps,
  IdentityGateStopError,
  isNonSecEquityListing,
  listingCommand,
  runIdentityGate,
} from "../src/sources/identity-gate";
import { isUsListing } from "../src/sources/instrument-capability";
import { withListingAlias } from "../src/sources/instrument-identity";
import type {
  CollectContext,
  FetchJsonResult,
  MarketCollectionResult,
  RawSourceSnapshot,
} from "../src/sources/types";

const FETCHED_AT = "2026-11-05T00:00:00.000Z";

function command(symbol: string): InstrumentCommand {
  return { jobType: "equity", assetClass: "equity", symbol, depth: "brief" };
}

function raw(adapter: string, payload: unknown): RawSourceSnapshot {
  return { id: `raw-${adapter}`, adapter, fetchedAt: FETCHED_AT, payload };
}

function context(input: {
  readonly symbol: string;
  readonly exa?: boolean;
  readonly search?: unknown;
  readonly urls?: string[];
}): CollectContext {
  return {
    command: command(input.symbol),
    fetchedAt: FETCHED_AT,
    newsLimit: 1,
    cryptoMoverLimit: 1,
    ...(input.exa === true ? { exaApiKey: "fixture-key" } : {}),
    request: {
      fetch: () => Promise.reject(new Error("unexpected base fetch")),
      json: async ({ url, adapter }) => {
        input.urls?.push(url);
        if (input.search === undefined) {
          return sourceGap({
            source: adapter,
            message: `${adapter} request failed with status 503`,
            cause: "fetch-failed",
            evidenceQualityImpact: "no-cap",
          });
        }
        const result: FetchJsonResult = {
          rawSnapshot: raw(adapter, input.search),
          payload: input.search,
        };
        return result;
      },
      text: () => Promise.reject(new Error("unexpected text request")),
    },
  };
}

function market(quote?: Record<string, unknown>, priced = false): MarketCollectionResult {
  return {
    rawSnapshots:
      quote === undefined
        ? []
        : [raw("yahoo-ticker", { quoteResponse: { result: [quote], error: null } })],
    marketSnapshots: priced
      ? [
          {
            sourceId: "yahoo-ticker",
            assetClass: "equity",
            symbol: String(quote?.symbol),
            price: 10,
            changePercent24h: 0,
            volume: 1,
            observedAt: FETCHED_AT,
            identity: { exchange: "NasdaqGS", quoteCurrency: "USD" },
          },
        ]
      : [],
    sourceGaps: [],
  };
}

function searchRow(symbol: string, name: string): Record<string, unknown> {
  return {
    symbol,
    shortname: name,
    quoteType: "EQUITY",
    exchange: "KLS",
    exchDisp: "Kuala Lumpur",
  };
}

describe("identity gate", () => {
  test("a priced US quote resolves without any extra request", async () => {
    const urls: string[] = [];
    const result = await runIdentityGate(
      context({ symbol: "AAPL", urls }),
      command("AAPL"),
      market({ symbol: "AAPL", quoteType: "EQUITY" }, true),
    );
    expect(result).toEqual({ status: "resolved" });
    expect(urls).toEqual([]);
  });

  test("a price-less but typed quote resolves with its identity", async () => {
    const result = await runIdentityGate(
      context({ symbol: "0097.KL", exa: true }),
      command("0097.KL"),
      market({
        symbol: "0097.KL",
        quoteType: "EQUITY",
        exchange: "KLS",
        fullExchangeName: "Kuala Lumpur",
        currency: "MYR",
        longName: "ViTrox Corporation Berhad",
      }),
    );
    expect(result).toEqual({
      status: "resolved",
      identity: {
        exchange: "Kuala Lumpur",
        quoteCurrency: "MYR",
        displayName: "ViTrox Corporation Berhad",
      },
    });
  });

  test("a NONE quote redirects to the single exact search match", async () => {
    const urls: string[] = [];
    const result = await runIdentityGate(
      context({
        symbol: "VITROX.KL",
        exa: true,
        urls,
        search: {
          quotes: [
            searchRow("0097.KL", "VITROX CORPORATION BHD"),
            searchRow("5000.KL", "Other Holdings Bhd"),
          ],
        },
      }),
      command("VITROX.KL"),
      market({ symbol: "VITROX.KL", quoteType: "NONE" }),
    );
    expect(result).toMatchObject({ status: "redirect", symbol: "0097.KL" });
    expect(urls).toEqual([
      "https://query1.finance.yahoo.com/v1/finance/search?q=VITROX&quotesCount=10&newsCount=0",
    ]);
  });

  test("two exact matches stop as ambiguous with candidates", async () => {
    const run = runIdentityGate(
      context({
        symbol: "MPI.KL",
        exa: true,
        search: {
          quotes: [searchRow("3867.KL", "MPI Berhad"), searchRow("9999.KL", "MPI Holdings")],
        },
      }),
      command("MPI.KL"),
      market({ symbol: "MPI.KL", quoteType: "NONE" }),
    );
    await expect(run).rejects.toThrow(IdentityGateStopError);
    await expect(run).rejects.toMatchObject({ reason: "ambiguous", candidates: [{}, {}] });
  });

  test("no exact match stops as unresolved and lists listed candidates only", async () => {
    const run = runIdentityGate(
      context({
        symbol: "ZZZ.KL",
        exa: true,
        search: {
          quotes: [
            searchRow("1234.KL", "Zeta Berhad"),
            { ...searchRow("ZZZW.KL", "Zeta warrant"), quoteType: "WARRANT" },
            searchRow("ZZY", "US listing"),
          ],
        },
      }),
      command("ZZZ.KL"),
      market(),
    );
    await expect(run).rejects.toMatchObject({
      reason: "unresolved",
      candidates: [{ symbol: "1234.KL", name: "Zeta Berhad", exchange: "Kuala Lumpur" }],
    });
  });

  test("a search failure stops a non-US suffix but keeps a US-looking symbol on today's path", async () => {
    await expect(
      runIdentityGate(context({ symbol: "VITROX.KL", exa: true }), command("VITROX.KL"), market()),
    ).rejects.toMatchObject({ reason: "unresolved" });
    expect(await runIdentityGate(context({ symbol: "AAPL" }), command("AAPL"), market())).toEqual({
      status: "resolved",
    });
  });

  test("a non-SEC listing without an Exa key stops before any model stage", async () => {
    const run = runIdentityGate(
      context({ symbol: "0097.KL" }),
      command("0097.KL"),
      market({ symbol: "0097.KL", quoteType: "EQUITY", exchange: "KLS", currency: "MYR" }),
    );
    await expect(run).rejects.toMatchObject({ reason: "missing-web-credential" });
    await expect(run).rejects.toThrow("MARKET_BOT_EXA_API_KEY");
  });

  test("a US class code is not filtered by its share-class letter", async () => {
    const result = await runIdentityGate(
      context({
        symbol: "BRK.B",
        search: {
          quotes: [
            {
              symbol: "BRK-B",
              shortname: "Berkshire Hathaway",
              quoteType: "EQUITY",
              exchange: "NYQ",
            },
          ],
        },
      }),
      command("BRK.B"),
      market({ symbol: "BRK.B", quoteType: "NONE" }),
    );
    expect(result).toMatchObject({ status: "redirect", symbol: "BRK-B" });
  });

  test("withListingAlias appends the typed code and leaves the identity otherwise intact", () => {
    const identity = { exchange: "Kuala Lumpur", quoteCurrency: "MYR" };
    expect(withListingAlias(identity, "VITROX.KL")).toEqual({
      ...identity,
      aliases: [{ provider: "user-input", idKind: "symbol", value: "VITROX.KL" }],
    });
    expect(withListingAlias(identity, undefined)).toBe(identity);
    expect(withListingAlias(undefined, "VITROX.KL")?.aliases).toHaveLength(1);
  });

  test("listingCommand swaps only the instrument symbol", () => {
    expect(listingCommand(command("VITROX.KL"), { symbol: "0097.KL" })).toMatchObject({
      symbol: "0097.KL",
    });
    expect(listingCommand(command("AAPL"), undefined)).toEqual(command("AAPL"));
  });
});

describe("exchange profile", () => {
  test("Bursa resolves to the KLCI benchmark; other suffixes have no row", () => {
    expect(exchangeProfileFor("0097.KL")).toMatchObject({ benchmark: "^KLSE", currency: "MYR" });
    expect(exchangeProfileFor("BBCA.JK")).toBeUndefined();
    expect(exchangeProfileFor("AAPL")).toBeUndefined();
  });

  test("a non-US exchange without a row declares the US-proxy gap", () => {
    expect(exchangeProfileGaps("BBCA.JK", undefined)).toEqual([
      expect.objectContaining({ source: "exchange-profile", cause: "unsupported-coverage" }),
    ]);
    expect(exchangeProfileGaps("0097.KL", undefined)).toEqual([]);
    expect(exchangeProfileGaps("AAPL", undefined)).toEqual([]);
  });

  test("a quote currency that disagrees with the Exchange Profile declares a gap", () => {
    expect(exchangeProfileGaps("0097.KL", { quoteCurrency: "USD" })).toEqual([
      expect.objectContaining({ source: "exchange-profile", cause: "validation-failed" }),
    ]);
    expect(exchangeProfileGaps("0097.KL", { quoteCurrency: "MYR" })).toEqual([]);
  });

  test("KL, JK, BK and TWO suffixes are non-US listings", () => {
    for (const symbol of ["0097.KL", "BBCA.JK", "PTT.BK", "6488.TWO"]) {
      expect(isUsListing(symbol)).toBe(false);
      expect(isNonSecEquityListing(command(symbol), undefined)).toBe(true);
    }
    expect(isNonSecEquityListing(command("AAPL"), undefined)).toBe(false);
  });

  test("an Exchange Profile benchmark is not a US listing, so no Massive fallback serves it", () => {
    expect(isUsListing("^KLSE")).toBe(false);
    expect(isUsListing("^VIX")).toBe(true);
  });
});
