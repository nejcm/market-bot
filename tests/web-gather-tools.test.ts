import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { executeWebGatherTool, WEB_GATHER_TOOL_UNITS } from "../src/sources/web-gather-tools";
import type {
  CollectContext,
  FetchJsonResult,
  RawSourceSnapshot,
  SourceRequestExecutor,
} from "../src/sources/types";

const fetchedAt = "2026-05-01T00:00:00.000Z";

function rawSnapshot(adapter: string, payload: unknown): RawSourceSnapshot {
  return { id: `raw-${adapter}`, adapter, fetchedAt, payload };
}

function jsonResult(adapter: string, payload: unknown): FetchJsonResult {
  return { rawSnapshot: rawSnapshot(adapter, payload), payload };
}

function gap(source: string, message = "fetch failed"): SourceGap {
  return { source, message, cause: "fetch-failed" };
}

function requestExecutor(overrides: Partial<SourceRequestExecutor> = {}): SourceRequestExecutor {
  return {
    json: async () => {
      throw new Error("unexpected json fetch");
    },
    text: async () => {
      throw new Error("unexpected text fetch");
    },
    ...overrides,
  };
}

function baseCtx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    fetchedAt,
    newsLimit: 2,
    cryptoMoverLimit: 2,
    exaApiKey: "exa-key",
    request: requestExecutor(),
    ...overrides,
  };
}

function webId(symbol: string, url: string): string {
  return `web-${symbol.toLowerCase()}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

describe("web gather tools", () => {
  test("declares source unit costs", () => {
    expect(WEB_GATHER_TOOL_UNITS).toEqual({ web_search: 2, web_fetch: 1 });
  });

  test("executes Exa search through the cached request seam and returns web Sources", async () => {
    const surfacedUrls = new Set<string>();
    const requests: {
      readonly adapter: string;
      readonly url: string;
      readonly headers: Headers;
      readonly body: unknown;
      readonly fetchWrapper: boolean;
    }[] = [];
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model", numResults: 3 },
      baseCtx({
        request: requestExecutor({
          json: async ({ url, adapter, init, fetch }) => {
            requests.push({
              adapter,
              url,
              headers: new Headers(init?.headers),
              body: JSON.parse(String(init?.body)),
              fetchWrapper: typeof fetch === "function",
            });
            return jsonResult(adapter, {
              results: [
                {
                  id: "exa-1",
                  url: "https://www.apple.com/newsroom/article?utm_source=feed",
                  title: "Apple services update",
                  author: "Apple Newsroom",
                  publishedDate: "2026-04-20T00:00:00.000Z",
                  summary: "Apple described services growth.",
                  highlights: ["Services revenue grew."],
                  text: "Long text should be secondary to highlights.",
                },
              ],
            });
          },
        }),
      }),
      surfacedUrls,
    );

    expect(result.gaps).toEqual([]);
    expect(result.rawSnapshots).toHaveLength(1);
    expect(requests[0]?.adapter).toBe("exa-search");
    expect(requests[0]?.fetchWrapper).toBe(true);
    expect(requests[0]?.url).toContain("https://api.exa.ai/search?");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("query")).toBe("AAPL business model");
    expect(requests[0]?.headers.get("x-api-key")).toBe("exa-key");
    expect(requests[0]?.body).toMatchObject({
      query: "AAPL business model",
      numResults: 3,
      contents: { text: { maxCharacters: 5000 } },
    });
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: webId("AAPL", "https://apple.com/newsroom/article"),
        kind: "web",
        provider: "exa",
        providerArticleId: "exa-1",
        title: "Apple services update",
        publisher: "Apple Newsroom",
        fetchedAt: "2026-04-20T00:00:00.000Z",
        rawRef: "raw-exa-search",
        canonicalUrl: "https://apple.com/newsroom/article",
        summary: "Apple described services growth.",
        snippet: "Services revenue grew.",
        symbol: "AAPL",
        assetClass: "equity",
      }),
    ]);
    expect(surfacedUrls.has("https://www.apple.com/newsroom/article?utm_source=feed")).toBe(true);
    expect(surfacedUrls.has("https://apple.com/newsroom/article")).toBe(true);
  });

  test("emits missing credential gap without fetching", async () => {
    const { exaApiKey: _exaApiKey, ...ctxWithoutExa } = baseCtx({
      request: requestExecutor({
        json: async () => {
          throw new Error("must not fetch without Exa key");
        },
      }),
    });
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model" },
      ctxWithoutExa,
      new Set(),
    );

    expect(result.rawSnapshots).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        provider: "exa",
        cause: "missing-credential",
        message: "MARKET_BOT_EXA_API_KEY is not set",
      }),
    ]);
  });

  test("rejects web_fetch URLs not surfaced by this run", async () => {
    const result = await executeWebGatherTool(
      "web_fetch",
      { url: "https://example.test/not-surfaced" },
      baseCtx(),
      new Set(["https://example.test/allowed"]),
    );

    expect(result.rawSnapshots).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "validation-failed",
        message: "web_fetch url was not returned by web_search in this run",
      }),
    ]);
  });

  test("validates web_search args before fetching", async () => {
    const ctx = baseCtx({
      request: requestExecutor({
        json: async () => {
          throw new Error("must not fetch invalid search args");
        },
      }),
    });

    const nonObject = await executeWebGatherTool("web_search", "AAPL", ctx, new Set());
    const blankQuery = await executeWebGatherTool("web_search", { query: "   " }, ctx, new Set());

    expect(nonObject.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "validation-failed",
        message: "web_search args must be an object",
      }),
    ]);
    expect(blankQuery.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "validation-failed",
        message: "web_search requires a non-empty query",
      }),
    ]);
  });

  test("validates web_fetch args before fetching", async () => {
    const ctx = baseCtx({
      request: requestExecutor({
        json: async () => {
          throw new Error("must not fetch invalid fetch args");
        },
      }),
    });

    const nonObject = await executeWebGatherTool(
      "web_fetch",
      ["https://example.test/apple"],
      ctx,
      new Set(["https://example.test/apple"]),
    );
    const blankUrl = await executeWebGatherTool(
      "web_fetch",
      { url: "   " },
      ctx,
      new Set(["https://example.test/apple"]),
    );

    expect(nonObject.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "validation-failed",
        message: "web_fetch args must be an object",
      }),
    ]);
    expect(blankUrl.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "validation-failed",
        message: "web_fetch requires a non-empty url",
      }),
    ]);
  });

  test("executes Exa contents fetch only for surfaced URLs", async () => {
    const requests: {
      readonly adapter: string;
      readonly url: string;
      readonly body: unknown;
    }[] = [];
    const surfacedUrls = new Set(["https://example.test/apple"]);
    const result = await executeWebGatherTool(
      "web_fetch",
      { url: "https://example.test/apple" },
      baseCtx({
        request: requestExecutor({
          json: async ({ url, adapter, init }) => {
            requests.push({ adapter, url, body: JSON.parse(String(init?.body)) });
            return jsonResult(adapter, {
              results: [
                {
                  url: "https://example.test/apple",
                  title: "Apple profile",
                  summary: "Apple sells devices and services.",
                  text: "Apple sells devices and services to consumers and enterprises.",
                },
              ],
            });
          },
        }),
      }),
      surfacedUrls,
    );

    expect(result.gaps).toEqual([]);
    expect(requests[0]?.adapter).toBe("exa-contents");
    expect(new URL(requests[0]?.url ?? "").searchParams.get("url")).toBe(
      "https://example.test/apple",
    );
    expect(requests[0]?.body).toMatchObject({ urls: ["https://example.test/apple"] });
    expect(result.sources[0]).toMatchObject({
      id: webId("AAPL", "https://example.test/apple"),
      provider: "exa",
      kind: "web",
      rawRef: "raw-exa-contents",
      snippet: "Apple sells devices and services to consumers and enterprises.",
    });
  });

  test("wraps Exa provider failures with web evidence context", async () => {
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model" },
      baseCtx({
        request: requestExecutor({
          json: async () => gap("exa-search", "timeout"),
        }),
      }),
      new Set(),
    );

    expect(result.rawSnapshots).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa-search",
        provider: "exa",
        capability: "evidence-request",
        cause: "fetch-failed",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  });

  test("classifies malformed Exa payloads separately from empty results", async () => {
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model" },
      baseCtx({
        request: requestExecutor({
          json: async ({ adapter }) => jsonResult(adapter, { notResults: [] }),
        }),
      }),
      new Set(),
    );

    expect(result.rawSnapshots).toHaveLength(1);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "malformed-response",
        message: "Exa search response was malformed",
      }),
    ]);
  });

  test("classifies empty Exa results as provider data missing", async () => {
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model" },
      baseCtx({
        request: requestExecutor({
          json: async ({ adapter }) => jsonResult(adapter, { results: [] }),
        }),
      }),
      new Set(),
    );

    expect(result.rawSnapshots).toHaveLength(1);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "provider-data-missing",
        message: 'Exa returned no usable web search results for "AAPL business model"',
      }),
    ]);
  });

  test("classifies unparseable Exa result entries as malformed", async () => {
    const result = await executeWebGatherTool(
      "web_search",
      { query: "AAPL business model" },
      baseCtx({
        request: requestExecutor({
          json: async ({ adapter }) => jsonResult(adapter, { results: [{ title: "Missing URL" }] }),
        }),
      }),
      new Set(),
    );

    expect(result.rawSnapshots).toHaveLength(1);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "exa",
        cause: "malformed-response",
        message: "Exa search response was malformed",
      }),
    ]);
  });
});
