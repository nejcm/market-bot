import { describe, expect, test } from "bun:test";
import { fetchYahooFxClosesOnOrBefore } from "../src/sources/yahoo-fx";
import type { FetchLike } from "../src/sources/types";

// USD/CAD was ≈1.43 in January 2025; the inverse CAD/USD rate was ≈0.70.
const USD_CAD_JAN_6_2025_CLOSE = 1.4368;
const USD_CAD_CLOSES = [1.44, USD_CAD_JAN_6_2025_CLOSE, 1.5] as const;

function yahooChartPayload(): unknown {
  return {
    chart: {
      result: [
        {
          timestamp: [1_735_862_400, 1_736_121_600, 1_736_208_000],
          indicators: { quote: [{ close: USD_CAD_CLOSES }] },
        },
      ],
      error: null,
    },
  };
}

function unavailableYahooChartPayload(): unknown {
  return {
    chart: {
      result: null,
      error: { code: "Not Found", description: "No data found, symbol may be delisted" },
    },
  };
}

function fixtureFetch(payload: unknown, urls: string[] = []): FetchLike {
  return async (input) => {
    urls.push(String(input));
    return Response.json(payload);
  };
}

describe("Yahoo FX closes", () => {
  test("constructs BASEQUOTE=X and resolves multiple dates with one fetch", async () => {
    const urls: string[] = [];

    const result = await fetchYahooFxClosesOnOrBefore(
      "USD",
      "CAD",
      ["2025-01-03", "2025-01-05", "2025-01-06"],
      fixtureFetch(yahooChartPayload(), urls),
    );

    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(new URL(urls[0]!).pathname)).toEndWith("/USDCAD=X");
    expect(Object.keys(result.closesByRequestedDate)).toEqual([
      "2025-01-03",
      "2025-01-05",
      "2025-01-06",
    ]);
    expect(result.closesByRequestedDate["2025-01-03"]).toMatchObject({
      date: "2025-01-03",
      quoteCurrencyPerBaseCurrency: 1.44,
    });
    expect(result.closesByRequestedDate["2025-01-05"]).toMatchObject({
      date: "2025-01-03",
      quoteCurrencyPerBaseCurrency: 1.44,
    });
    expect(result.closesByRequestedDate["2025-01-06"]).toEqual({
      baseCurrency: "USD",
      quoteCurrency: "CAD",
      pair: "USDCAD=X",
      date: "2025-01-06",
      quoteCurrencyPerBaseCurrency: 1.4368,
      sourceId: "market-yahoo-fx-usdcad",
    });
    expect(result.sourceGaps).toEqual([]);
  });

  test("emits a SourceGap instead of using a close after the requested date", async () => {
    const result = await fetchYahooFxClosesOnOrBefore(
      "USD",
      "CAD",
      ["2025-01-02"],
      fixtureFetch(yahooChartPayload()),
    );

    expect(result).toEqual({
      closesByRequestedDate: {},
      sourceGaps: [
        {
          source: "market-yahoo-fx-usdcad",
          message: "Yahoo FX close unavailable for USDCAD=X on or before 2025-01-02",
          provider: "yahoo",
          capability: "market-data",
          cause: "provider-data-missing",
          evidenceQualityImpact: "no-cap",
        },
      ],
    });
  });

  test("emits a SourceGap when Yahoo has no pair series", async () => {
    const result = await fetchYahooFxClosesOnOrBefore(
      "USD",
      "CAD",
      ["2025-01-06"],
      fixtureFetch(unavailableYahooChartPayload()),
    );

    expect(result.closesByRequestedDate).toEqual({});
    expect(result.sourceGaps).toEqual([
      {
        source: "market-yahoo-fx-usdcad",
        message: "Yahoo FX close unavailable for USDCAD=X on or before 2025-01-06",
        provider: "yahoo",
        capability: "market-data",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      },
    ]);
  });

  test("emits provider-data-missing for Yahoo's real 404 no-data body", async () => {
    const result = await fetchYahooFxClosesOnOrBefore("USD", "CAD", ["2025-01-06"], async () =>
      Response.json(
        { code: "Not Found", description: "No data found, symbol may be delisted" },
        { status: 404 },
      ),
    );

    expect(result.closesByRequestedDate).toEqual({});
    expect(result.sourceGaps).toEqual([
      {
        source: "market-yahoo-fx-usdcad",
        message: "Yahoo FX close unavailable for USDCAD=X on or before 2025-01-06",
        provider: "yahoo",
        capability: "market-data",
        cause: "provider-data-missing",
        evidenceQualityImpact: "no-cap",
      },
    ]);
  });

  test("emits malformed-response when Yahoo answers 200 with an unusable payload", async () => {
    const result = await fetchYahooFxClosesOnOrBefore("USD", "CAD", ["2025-01-06"], async () =>
      Response.json({ chart: { result: null, error: { code: "Internal Server Error" } } }),
    );

    expect(result.closesByRequestedDate).toEqual({});
    expect(result.sourceGaps).toEqual([
      {
        source: "market-yahoo-fx-usdcad",
        message: "Yahoo FX close response malformed for USDCAD=X on or before 2025-01-06",
        provider: "yahoo",
        capability: "market-data",
        cause: "malformed-response",
        evidenceQualityImpact: "no-cap",
      },
    ]);
  });

  test("emits fetch-failed, not provider-data-missing, when the request fails", async () => {
    const result = await fetchYahooFxClosesOnOrBefore(
      "USD",
      "CAD",
      ["2025-01-06"],
      async () => new Response("nope", { status: 404 }),
    );

    expect(result.closesByRequestedDate).toEqual({});
    expect(result.sourceGaps).toEqual([
      {
        source: "market-yahoo-fx-usdcad",
        message: "Yahoo FX close fetch failed for USDCAD=X on or before 2025-01-06",
        provider: "yahoo",
        capability: "market-data",
        cause: "fetch-failed",
        evidenceQualityImpact: "no-cap",
      },
    ]);
  });
});
