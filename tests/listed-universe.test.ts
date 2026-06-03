import { describe, expect, test } from "bun:test";
import {
  collectListedUniverse,
  filterListedUniverseCandidates,
  parseCboeListedPayload,
  parseNasdaqListedPayload,
  parseNasdaqOtherListedPayload,
  type ListedUniverseCandidate,
} from "../src/alpha-search/listed-universe";
import type { FetchTextResult, SourceRequestExecutor } from "../src/sources/types";

function candidate(symbol: string): ListedUniverseCandidate {
  return { symbol, sourceIds: [`source-${symbol}`] };
}

function textResult(adapter: string, payload: string): FetchTextResult {
  return {
    rawSnapshot: {
      id: `raw-${adapter}`,
      adapter,
      fetchedAt: "2026-06-01T00:00:00.000Z",
      payload,
    },
    payload,
  };
}

describe("listed universe", () => {
  test("parses Nasdaq listed common stocks and rejects ETFs/test/unsupported rows", () => {
    const entries = parseNasdaqListedPayload(
      [
        "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
        "ABCD|ABCD Inc. Common Stock|Q|N|N|100|N|N",
        "FUND|Fund Trust ETF|G|N|N|100|Y|N",
        "TEST|Test Issue|S|Y|N|100|N|N",
        "UNIT|Unit Corp Unit|Q|N|N|100|N|N",
        "File Creation Time: 0601202600:00|||||||",
      ].join("\n"),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        symbol: "ABCD",
        isEtfOrFund: false,
        isActive: true,
        isSupportedStock: true,
      }),
      expect.objectContaining({
        symbol: "FUND",
        isEtfOrFund: true,
        isActive: true,
        isSupportedStock: false,
      }),
      expect.objectContaining({ symbol: "TEST", isTestIssue: true, isActive: false }),
      expect.objectContaining({ symbol: "UNIT", isSupportedStock: false }),
    ]);
  });

  test("parses Nasdaq other-listed and Cboe listed payloads", () => {
    expect(
      parseNasdaqOtherListedPayload(
        [
          "ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
          "NYSE|NYSE Example Common Stock|N|NYSE|N|100|N|NYSE",
          "ARCA|Arca ETF|P|ARCA|Y|100|N|ARCA",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({
        symbol: "NYSE",
        listingVenue: "N",
        isEtfOrFund: false,
        isSupportedStock: true,
      }),
      expect.objectContaining({
        symbol: "ARCA",
        listingVenue: "P",
        isEtfOrFund: true,
        isSupportedStock: false,
      }),
    ]);
    const cboeEntries = parseCboeListedPayload("Name,Volume,Last Price\nCBOE,100,$10.00");
    expect(cboeEntries).toEqual([
      expect.objectContaining({ symbol: "CBOE", listingVenue: "CBOE", isActive: true }),
    ]);
    expect(cboeEntries[0]).not.toHaveProperty("isSupportedStock");
  });

  test("handles escaped CSV quotes and caps listed-universe rows", () => {
    const escapedEntries = parseCboeListedPayload('Name,Volume\n"AB""C",100\nGOOD,100');
    const cappedEntries = parseCboeListedPayload(
      [
        "Name,Volume",
        ...Array.from({ length: 25_001 }, (_, index) => `SYM${String(index)},100`),
      ].join("\n"),
    );

    expect(escapedEntries.map((entry) => entry.symbol)).toEqual(["GOOD"]);
    expect(cappedEntries).toHaveLength(25_000);
    expect(cappedEntries.at(-1)?.symbol).toBe("SYM24999");
  });

  test("filters candidates with deterministic listed-universe reasons", () => {
    const result = filterListedUniverseCandidates({
      candidates: [
        candidate("ABCD"),
        candidate("FUND"),
        candidate("TEST"),
        candidate("UNIT"),
        candidate("CBOE"),
        candidate("MIX"),
        candidate("MISSING"),
      ],
      entries: [
        {
          symbol: "ABCD",
          source: "nasdaq-listed",
          sourceIds: ["listed-ABCD"],
          isActive: true,
          isSupportedStock: true,
        },
        {
          symbol: "FUND",
          source: "nasdaq-listed",
          sourceIds: ["listed-FUND"],
          isActive: true,
          isEtfOrFund: true,
        },
        {
          symbol: "TEST",
          source: "nasdaq-listed",
          sourceIds: ["listed-TEST"],
          isActive: false,
          isTestIssue: true,
        },
        {
          symbol: "UNIT",
          source: "nasdaq-listed",
          sourceIds: ["listed-UNIT"],
          isActive: true,
          isSupportedStock: false,
        },
        {
          symbol: "CBOE",
          source: "cboe-listed",
          sourceIds: ["listed-CBOE"],
          isActive: true,
        },
        {
          symbol: "MIX",
          source: "nasdaq-listed",
          sourceIds: ["listed-MIX"],
          isActive: true,
          isEtfOrFund: true,
        },
        {
          symbol: "MIX",
          source: "cboe-listed",
          sourceIds: ["listed-MIX-cboe"],
          isActive: true,
        },
      ],
    });

    expect(result.eligibleCandidates).toEqual([candidate("ABCD")]);
    expect(
      result.rejectedCandidates.map((rejected) => [rejected.candidate.symbol, rejected.reason]),
    ).toEqual([
      ["FUND", "Official listing universe marks candidate as ETF or fund"],
      ["TEST", "Official listing universe marks candidate as test issue"],
      ["UNIT", "Official listing universe marks candidate as unsupported listing type"],
      ["CBOE", "Official listing universe marks candidate as unsupported listing type"],
      ["MIX", "Official listing universe marks candidate as ETF or fund"],
      ["MISSING", "Official listing universe did not resolve candidate"],
    ]);
  });

  test("emits source gaps for listed-universe fetch and malformed failures", async () => {
    const request: SourceRequestExecutor = {
      json: async () => {
        throw new Error("unexpected json fetch");
      },
      text: async (sourceRequest) => {
        if (sourceRequest.adapter === "nasdaq-listed") {
          return {
            source: "nasdaq-listed",
            message: "source request failed with status 503",
            cause: "fetch-failed",
          };
        }
        if (sourceRequest.adapter === "nasdaq-other-listed") {
          return textResult("nasdaq-other-listed", "bad payload");
        }
        return textResult("cboe-listed", "Symbol,Volume\nCBOE,10");
      },
    };

    const result = await collectListedUniverse(request);

    expect(result.entries).toEqual([
      expect.objectContaining({ symbol: "CBOE", source: "cboe-listed" }),
    ]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({ source: "nasdaq-listed", cause: "fetch-failed" }),
      expect.objectContaining({ source: "nasdaq-other-listed", cause: "malformed-response" }),
    ]);
  });
});
