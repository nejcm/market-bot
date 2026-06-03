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
  test("parses Nasdaq listed common stocks and rejects ETFs/test rows", () => {
    const entries = parseNasdaqListedPayload(
      [
        "Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
        "ABCD|ABCD Inc. Common Stock|Q|N|N|100|N|N",
        "FUND|Fund Trust ETF|G|N|N|100|Y|N",
        "TEST|Test Issue|S|Y|N|100|N|N",
        "File Creation Time: 0601202600:00|||||||",
      ].join("\n"),
    );

    expect(entries).toEqual([
      expect.objectContaining({ symbol: "ABCD", isEtfOrFund: false, isActive: true }),
      expect.objectContaining({ symbol: "FUND", isEtfOrFund: true, isActive: true }),
      expect.objectContaining({ symbol: "TEST", isTestIssue: true, isActive: false }),
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
      expect.objectContaining({ symbol: "NYSE", listingVenue: "N", isEtfOrFund: false }),
      expect.objectContaining({ symbol: "ARCA", listingVenue: "P", isEtfOrFund: true }),
    ]);
    expect(parseCboeListedPayload("Name,Volume,Last Price\nCBOE,100,$10.00")).toEqual([
      expect.objectContaining({ symbol: "CBOE", listingVenue: "CBOE", isActive: true }),
    ]);
  });

  test("filters candidates with deterministic listed-universe reasons", () => {
    const result = filterListedUniverseCandidates({
      candidates: [candidate("ABCD"), candidate("FUND"), candidate("TEST"), candidate("MISSING")],
      entries: [
        { symbol: "ABCD", source: "nasdaq-listed", sourceIds: ["listed-ABCD"], isActive: true },
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
      ],
    });

    expect(result.eligibleCandidates).toEqual([candidate("ABCD")]);
    expect(
      result.rejectedCandidates.map((rejected) => [rejected.candidate.symbol, rejected.reason]),
    ).toEqual([
      ["FUND", "Official listing universe marks candidate as ETF or fund"],
      ["TEST", "Official listing universe marks candidate as test issue"],
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
