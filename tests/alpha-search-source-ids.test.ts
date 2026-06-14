import { describe, expect, test } from "bun:test";
import { alphaSearchRejectedCandidate, leadSourceIds } from "../src/alpha-search/report-extras";
import { socialMomentumReportSourceId } from "../src/alpha-search/source-ids";
import type { YahooValidatedLead } from "../src/alpha-search/yahoo-validation";

describe("alpha-search source ids", () => {
  test("suffixes social momentum report source ids with rank", () => {
    expect(
      socialMomentumReportSourceId({
        symbol: "CTS",
        socialRank: 21,
        sourceIds: ["apewisdom-all-stocks-CTS"],
      }),
    ).toBe("apewisdom-all-stocks-CTS@rank-21");
    expect(
      socialMomentumReportSourceId({
        symbol: "CTS",
        socialRank: 22,
        sourceIds: ["apewisdom-all-stocks-CTS"],
      }),
    ).toBe("apewisdom-all-stocks-CTS@rank-22");
  });

  test("leadSourceIds cites the rank-scoped report source id", () => {
    const lead = {
      symbol: "AAPL",
      exchange: "NMS",
      price: 100,
      volume: 1000,
      marketCap: 1_000_000,
      candidate: {
        symbol: "AAPL",
        sourceIds: ["apewisdom-all-stocks-AAPL"],
        socialRank: 1,
        discoverySources: ["apewisdom"],
      },
    } satisfies YahooValidatedLead;

    expect(leadSourceIds(lead, "market-yahoo-alpha-search")).toEqual([
      "apewisdom-all-stocks-AAPL@rank-1",
      "market-yahoo-alpha-search",
    ]);
  });

  test("preserves supplemental candidate source ids beside rank-scoped social ids", () => {
    const lead = {
      symbol: "AAPL",
      exchange: "NMS",
      price: 100,
      volume: 1000,
      marketCap: 1_000_000,
      candidate: {
        symbol: "AAPL",
        sourceIds: ["apewisdom-all-stocks-AAPL", "sec-alpha-search-S-1-0003200193-1"],
        socialRank: 1,
        discoverySources: ["apewisdom", "sec-filings"],
      },
    } satisfies YahooValidatedLead;

    expect(leadSourceIds(lead, "market-yahoo-alpha-search")).toEqual([
      "apewisdom-all-stocks-AAPL@rank-1",
      "sec-alpha-search-S-1-0003200193-1",
      "market-yahoo-alpha-search",
    ]);
    expect(
      alphaSearchRejectedCandidate({
        candidate: lead.candidate,
        reason: "Yahoo quote is missing market cap",
      }).sourceIds,
    ).toEqual(["apewisdom-all-stocks-AAPL@rank-1", "sec-alpha-search-S-1-0003200193-1"]);
  });

  test("finds the social source id when supplemental ids arrive first", () => {
    const lead = {
      symbol: "AAPL",
      exchange: "NMS",
      price: 100,
      volume: 1000,
      marketCap: 1_000_000,
      candidate: {
        symbol: "AAPL",
        sourceIds: ["sec-alpha-search-S-1-0003200193-1", "apewisdom-all-stocks-AAPL"],
        socialRank: 1,
        discoverySources: ["sec-filings", "apewisdom"],
      },
    } satisfies YahooValidatedLead;

    expect(leadSourceIds(lead, "market-yahoo-alpha-search")).toEqual([
      "apewisdom-all-stocks-AAPL@rank-1",
      "sec-alpha-search-S-1-0003200193-1",
      "market-yahoo-alpha-search",
    ]);
  });
});
