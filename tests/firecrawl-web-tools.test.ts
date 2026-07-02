import { describe, expect, test } from "bun:test";
import {
  firecrawlTbsForSearchType,
  parseFirecrawlScrapeResult,
  parseFirecrawlSearchResults,
  requestFirecrawlScrape,
  requestFirecrawlSearch,
} from "../src/sources/firecrawl-web-tools";
import type {
  CollectContext,
  FetchJsonResult,
  RawSourceSnapshot,
  SourceRequestExecutor,
} from "../src/sources/types";

const fetchedAt = "2026-05-01T00:00:00.000Z";

function jsonResult(adapter: string, payload: unknown): FetchJsonResult {
  const rawSnapshot: RawSourceSnapshot = { id: `raw-${adapter}`, adapter, fetchedAt, payload };
  return { rawSnapshot, payload };
}

function captureCtx(captured: {
  adapter?: string;
  url?: string;
  headers?: Headers;
  body?: unknown;
}): {
  readonly ctx: CollectContext;
} {
  const executor: SourceRequestExecutor = {
    json: async ({ url, adapter, init }) => {
      captured.adapter = adapter;
      captured.url = url;
      captured.headers = new Headers(init?.headers);
      captured.body = JSON.parse(String(init?.body));
      return jsonResult(adapter, { success: true, data: { web: [] } });
    },
    text: async () => {
      throw new Error("unexpected text fetch");
    },
  };
  return {
    ctx: {
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      fetchedAt,
      newsLimit: 2,
      cryptoMoverLimit: 2,
      request: executor,
    },
  };
}

describe("firecrawl request shapes", () => {
  test("search body uses object-shaped sources and scrapeOptions.formats", async () => {
    const captured: { adapter?: string; url?: string; headers?: Headers; body?: unknown } = {};
    const { ctx } = captureCtx(captured);
    await requestFirecrawlSearch(ctx, "fc-key", "AAPL business", 5, "qdr:m");

    expect(captured.adapter).toBe("firecrawl-search");
    expect(captured.url).toContain("https://api.firecrawl.dev/v2/search?");
    expect(captured.headers?.get("authorization")).toBe("Bearer fc-key");
    expect(captured.body).toEqual({
      query: "AAPL business",
      limit: 5,
      sources: [{ type: "web" }],
      tbs: "qdr:m",
      scrapeOptions: { formats: [{ type: "markdown" }], onlyMainContent: true },
    });
  });

  test("search body omits tbs when unset", async () => {
    const captured: { body?: unknown } = {};
    const { ctx } = captureCtx(captured);
    const noTbs = undefined;
    await requestFirecrawlSearch(ctx, "fc-key", "AAPL business", 3, noTbs);

    expect(captured.body).not.toHaveProperty("tbs");
  });

  test("scrape body uses plain-string formats", async () => {
    const captured: { adapter?: string; url?: string; body?: unknown } = {};
    const { ctx } = captureCtx(captured);
    await requestFirecrawlScrape(ctx, "fc-key", "https://example.test/apple");

    expect(captured.adapter).toBe("firecrawl-scrape");
    expect(captured.url).toContain("https://api.firecrawl.dev/v2/scrape?");
    expect(captured.body).toEqual({
      url: "https://example.test/apple",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });
});

describe("firecrawl tbs mapping", () => {
  test("maps freshness windows", () => {
    expect(firecrawlTbsForSearchType("news")).toBe("qdr:m");
    expect(firecrawlTbsForSearchType("market")).toBe("qdr:m");
    expect(firecrawlTbsForSearchType("current-subject")).toBe("qdr:y");
    expect(firecrawlTbsForSearchType("background")).toBeUndefined();
  });
});

describe("firecrawl search parsing", () => {
  test("normalizes data.web entries and credits", () => {
    const parsed = parseFirecrawlSearchResults({
      success: true,
      creditsUsed: 4,
      data: {
        web: [
          {
            url: "https://firecrawl.example/a",
            title: "Title A",
            description: "Desc A",
            markdown: "Body A",
          },
        ],
      },
    });

    expect(parsed.malformed).toBe(false);
    expect(parsed.creditsUsed).toBe(4);
    expect(parsed.results).toEqual([
      {
        url: "https://firecrawl.example/a",
        title: "Title A",
        summary: "Desc A",
        text: "Body A",
        highlights: [],
      },
    ]);
  });

  test("flags malformed responses when data.web is missing", () => {
    expect(parseFirecrawlSearchResults({ success: true, data: {} }).malformed).toBe(true);
    expect(parseFirecrawlSearchResults({ success: false }).malformed).toBe(true);
  });

  test("flags malformed when every entry is unparseable but drops bad ones otherwise", () => {
    expect(
      parseFirecrawlSearchResults({ success: true, data: { web: [{ title: "no url" }] } })
        .malformed,
    ).toBe(true);
    const mixed = parseFirecrawlSearchResults({
      success: true,
      data: { web: [{ title: "no url" }, { url: "https://ok.example/x" }] },
    });
    expect(mixed.malformed).toBe(false);
    expect(mixed.results).toHaveLength(1);
  });

  test("rejects non-http result URLs", () => {
    const parsed = parseFirecrawlSearchResults({
      success: true,
      data: { web: [{ url: "ftp://example.test/x" }] },
    });
    expect(parsed.malformed).toBe(true);
    expect(parsed.results).toEqual([]);
  });
});

describe("firecrawl scrape parsing", () => {
  test("normalizes markdown into a single result", () => {
    const parsed = parseFirecrawlScrapeResult("https://example.test/apple", {
      success: true,
      data: { markdown: "Apple sells devices.", metadata: {} },
    });
    expect(parsed.malformed).toBe(false);
    expect(parsed.results).toEqual([
      { url: "https://example.test/apple", text: "Apple sells devices.", highlights: [] },
    ]);
  });

  test("flags malformed when markdown is missing", () => {
    expect(
      parseFirecrawlScrapeResult("https://example.test/apple", { success: true, data: {} })
        .malformed,
    ).toBe(true);
  });
});
