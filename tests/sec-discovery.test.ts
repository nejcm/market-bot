import { describe, expect, test } from "bun:test";
import {
  discoverSecAlphaSearchCandidates,
  parseSecCurrentFilingsAtom,
  readSecTickerMappings,
} from "../src/alpha-search/sec-discovery";
import type { FetchJsonResult, FetchTextResult, SourceRequestExecutor } from "../src/sources/types";

function jsonResult(adapter: string, payload: unknown): FetchJsonResult {
  return {
    rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt: "2026-06-01T00:00:00.000Z", payload },
    payload,
  };
}

function textResult(adapter: string, payload: string): FetchTextResult {
  return {
    rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt: "2026-06-01T00:00:00.000Z", payload },
    payload,
  };
}

function tickersPayload(): unknown {
  return {
    "0": { cik_str: 1_111_111, ticker: "SNEW", title: "S-1 New Co" },
    "1": { cik_str: 2_222_222, ticker: "EIGHT", title: "Eight K Co" },
  };
}

function atom(entries: readonly string[]): string {
  return `<feed>${entries.join("")}</feed>`;
}

function entry(input: {
  readonly title: string;
  readonly updated: string;
  readonly cik?: string;
  readonly accession?: string;
  readonly period?: string;
  readonly filed?: string;
}): string {
  return [
    "<entry>",
    `<title>${input.title}</title>`,
    `<updated>${input.updated}</updated>`,
    input.cik === undefined && input.filed === undefined
      ? ""
      : `<summary>${input.filed === undefined ? "" : `Filed: ${input.filed} `}Filed by reporting owner.</summary>`,
    input.accession === undefined ? "" : `<id>${input.accession}</id>`,
    input.period === undefined ? "" : `<period>${input.period}</period>`,
    "</entry>",
  ].join("");
}

function requestExecutor(): SourceRequestExecutor {
  return {
    json: async ({ adapter }) => jsonResult(adapter, tickersPayload()),
    text: async ({ adapter, url }) => {
      if (url.includes("type=S-1")) {
        return textResult(
          adapter,
          atom([
            entry({
              title: "S-1 - S-1 New Co (0001111111) (Filer)",
              updated: "2026-06-03T12:00:00-04:00",
              cik: "0001111111",
              accession: "0001111111-26-000010",
              period: "2026-05-31",
              filed: "2026-06-02",
            }),
          ]),
        );
      }
      return textResult(
        adapter,
        atom([
          entry({
            title: "8-K - Eight K Co (0002222222) (Filer)",
            updated: "2026-06-04T12:00:00-04:00",
            cik: "0002222222",
            accession: "0002222222-26-000020",
            filed: "2026-06-01",
          }),
          entry({
            title: "8-K - Missing Mapping Co (0003333333) (Filer)",
            updated: "2026-06-04T13:00:00-04:00",
            cik: "0003333333",
            accession: "0003333333-26-000030",
            filed: "2026-06-04",
          }),
        ]),
      );
    },
  };
}

describe("SEC alpha-search discovery", () => {
  test("parses SEC current filings Atom entries", () => {
    expect(
      parseSecCurrentFilingsAtom(
        atom([
          entry({
            title: "8-K - Eight K Co (0002222222) (Filer)",
            updated: "2026-06-04T12:00:00-04:00",
            cik: "0002222222",
            accession: "0002222222-26-000020",
            filed: "2026-06-03",
          }),
        ]),
        "8-K",
      ),
    ).toEqual([
      {
        form: "8-K",
        filingDate: "2026-06-03",
        accessionNumber: "0002222222-26-000020",
        cik: "0002222222",
        companyName: "Eight K Co",
        sourceId: "sec-alpha-search-8-K-0002222222-0002222222-26-000020",
      },
    ]);
  });

  test("reads SEC ticker mappings", () => {
    expect({
      valid: readSecTickerMappings(tickersPayload()),
      invalid: readSecTickerMappings({
        "0": { cik_str: 4_444_444, ticker: "../BAD", title: "Bad Co" },
        "1": { cik_str: 5_555_555, ticker: "LONG", title: `Long ${"x".repeat(200)}` },
      }),
    }).toEqual({
      valid: [
        { cik: "0001111111", ticker: "SNEW", name: "S-1 New Co" },
        { cik: "0002222222", ticker: "EIGHT", name: "Eight K Co" },
      ],
      invalid: [{ cik: "0005555555", ticker: "LONG", name: `Long ${"x".repeat(155)}` }],
    });
  });

  test("discovers and ranks SEC candidates by form priority then recency", async () => {
    const result = await discoverSecAlphaSearchCandidates({
      formTypes: ["S-1", "8-K"],
      candidateLimit: 10,
      request: requestExecutor(),
    });

    expect(result.candidates.map((candidate) => candidate.symbol)).toEqual(["SNEW", "EIGHT"]);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        symbol: "SNEW",
        discoverySources: ["sec-filings"],
        secCik: "0001111111",
        secCompanyName: "S-1 New Co",
        recentSecFilings: [
          {
            form: "S-1",
            filingDate: "2026-06-02",
            reportDate: "2026-05-31",
            accessionNumber: "0001111111-26-000010",
            sourceIds: ["sec-alpha-search-S-1-0001111111-0001111111-26-000010"],
          },
        ],
      }),
    );
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "sec-alpha-search",
        message: "SEC filing 8-K 2026-06-04 did not map to a ticker",
      }),
    ]);
  });

  test("treats SEC fetch failures as nonblocking gaps", async () => {
    const result = await discoverSecAlphaSearchCandidates({
      formTypes: ["8-K"],
      candidateLimit: 10,
      request: {
        json: async ({ adapter }) => jsonResult(adapter, tickersPayload()),
        text: async () => ({
          source: "sec-alpha-search-current-8-k",
          message: "source request failed with status 503",
          cause: "fetch-failed",
        }),
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({ source: "sec-alpha-search-current-8-k" }),
    ]);
  });

  test("reports malformed SEC ticker and feed payloads as nonblocking gaps", async () => {
    const malformedTickers = await discoverSecAlphaSearchCandidates({
      formTypes: ["8-K"],
      candidateLimit: 10,
      request: {
        json: async ({ adapter }) => jsonResult(adapter, { bad: "shape" }),
        text: async () => {
          throw new Error("unexpected text fetch");
        },
      },
    });
    const malformedFeed = await discoverSecAlphaSearchCandidates({
      formTypes: ["8-K"],
      candidateLimit: 10,
      request: {
        json: async ({ adapter }) => jsonResult(adapter, tickersPayload()),
        text: async ({ adapter }) => textResult(adapter, "<html>not atom</html>"),
      },
    });

    expect(malformedTickers.sourceGaps).toEqual([
      expect.objectContaining({ source: "sec-alpha-search", cause: "malformed-response" }),
    ]);
    expect(malformedFeed.sourceGaps).toEqual([
      expect.objectContaining({ source: "sec-alpha-search", cause: "malformed-response" }),
    ]);
  });
});
