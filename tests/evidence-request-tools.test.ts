import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import {
  availableEvidenceRequestTools,
  executeEvidenceRequestTool,
  normalizeFilingText,
} from "../src/sources/evidence-request-tools";
import type {
  CollectContext,
  FetchJsonResult,
  FetchTextResult,
  RawSourceSnapshot,
  SourceRequestExecutor,
} from "../src/sources/types";

const fetchedAt = "2026-05-01T00:00:00.000Z";

function rawSnapshot(
  adapter: string,
  payload: unknown,
  rawFetchedAt = fetchedAt,
): RawSourceSnapshot {
  return { id: `raw-${adapter}`, adapter, fetchedAt: rawFetchedAt, payload };
}

function jsonResult(adapter: string, payload: unknown, rawFetchedAt = fetchedAt): FetchJsonResult {
  return { rawSnapshot: rawSnapshot(adapter, payload, rawFetchedAt), payload };
}

function textResult(adapter: string, payload: string, rawFetchedAt = fetchedAt): FetchTextResult {
  return { rawSnapshot: rawSnapshot(adapter, payload, rawFetchedAt), payload };
}

function gap(source: string, message = "fetch failed"): SourceGap {
  return { source, message };
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
    command: { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    fetchedAt,
    newsLimit: 2,
    cryptoMoverLimit: 2,
    request: requestExecutor(),
    ...overrides,
  };
}

function secTickersPayload(): unknown {
  return { "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } };
}

function secDocuments(forms: readonly string[]): readonly string[] {
  return forms.map((form) => (form === "8-K" ? "a8k.htm" : "a10q.htm"));
}

function secSubmissionsPayload(
  forms: readonly string[] = ["8-K", "10-Q"],
  primaryDocuments: readonly string[] = secDocuments(forms),
): unknown {
  return {
    filings: {
      recent: {
        form: forms,
        filingDate: forms.map((form) => (form === "8-K" ? "2026-06-01" : "2026-05-01")),
        reportDate: forms.map((form) => (form === "8-K" ? "2026-05-30" : "2026-03-31")),
        accessionNumber: forms.map((form) =>
          form === "8-K" ? "0000320193-26-000100" : "0000320193-26-000077",
        ),
        primaryDocument: primaryDocuments,
      },
    },
  };
}

describe("SEC latest filing evidence tool", () => {
  test("fetches latest 10-Q or 10-K filing text and normalizes excerpt", async () => {
    const filingTextFetchedAt = "2026-04-30T00:00:00.000Z";
    const requested: {
      readonly adapter: string;
      readonly url: string;
      readonly headers: Headers;
    }[] = [];
    const ctx = baseCtx({
      secUserAgent: "market-bot test@example.test",
      request: requestExecutor({
        json: async ({ url, adapter, init }) => {
          requested.push({ adapter, url, headers: new Headers(init?.headers) });
          return adapter === "sec-tickers"
            ? jsonResult(adapter, secTickersPayload())
            : jsonResult(adapter, secSubmissionsPayload());
        },
        text: async ({ url, adapter, init }) => {
          requested.push({ adapter, url, headers: new Headers(init?.headers) });
          return textResult(
            adapter,
            "<html><style>.x{}</style><body><h1>Management&nbsp;Discussion</h1><script>bad()</script><p>Revenue &amp; margin improved.</p></body></html>",
            filingTextFetchedAt,
          );
        },
      }),
    });

    const result = await executeEvidenceRequestTool("sec_latest_filing", ctx);

    expect(result.gaps).toEqual([]);
    expect(result.rawSnapshots).toHaveLength(3);
    expect(result.sources[0]?.url).toContain("/000032019326000077/a10q.htm");
    expect(result.sources[0]?.fetchedAt).toBe(filingTextFetchedAt);
    expect(result.items[0]?.observedAt).toBe(filingTextFetchedAt);
    expect(result.sources[0]?.summary).toContain("10-Q filed 2026-05-01");
    expect(result.items[0]?.summary).toContain("Management Discussion");
    expect(result.items[0]?.summary).toContain("Revenue & margin improved.");
    expect(result.items[0]?.summary).not.toContain("bad()");
    expect(result.items[0]?.metrics).toMatchObject({
      form: "10-Q",
      filingDate: "2026-05-01",
      reportDate: "2026-03-31",
      accessionNumber: "0000320193-26-000077",
    });
    expect(
      requested
        .filter((request) => request.adapter.startsWith("sec-"))
        .every((request) => request.headers.get("user-agent") === "market-bot test@example.test"),
    ).toBe(true);
  });

  test("encodes the SEC primary document URL segment", async () => {
    let filingTextUrl = "";
    const ctx = baseCtx({
      request: requestExecutor({
        json: async ({ adapter }) =>
          adapter === "sec-tickers"
            ? jsonResult(adapter, secTickersPayload())
            : jsonResult(adapter, secSubmissionsPayload(["10-Q"], ["a 10q.htm?x=1"])),
        text: async ({ url, adapter }) => {
          filingTextUrl = url;
          return textResult(adapter, "Latest filing evidence.");
        },
      }),
    });

    const result = await executeEvidenceRequestTool("sec_latest_filing", ctx);

    expect(filingTextUrl).toContain("/a%2010q.htm%3Fx%3D1");
    expect(result.sources[0]?.url).toBe(filingTextUrl);
  });

  test("emits gap when SEC ticker mapping has no CIK", async () => {
    const result = await executeEvidenceRequestTool(
      "sec_latest_filing",
      baseCtx({
        request: requestExecutor({
          json: async ({ url, adapter }) =>
            jsonResult(adapter, url.includes("company_tickers") ? {} : {}),
        }),
      }),
    );

    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({ source: "sec-edgar", message: "No SEC CIK match for AAPL" }),
    ]);
  });

  test("emits gap when submissions have no periodic filing", async () => {
    const result = await executeEvidenceRequestTool(
      "sec_latest_filing",
      baseCtx({
        request: requestExecutor({
          json: async ({ adapter }) =>
            adapter === "sec-tickers"
              ? jsonResult(adapter, secTickersPayload())
              : jsonResult(adapter, secSubmissionsPayload(["8-K"])),
        }),
      }),
    );

    expect(result.sources).toEqual([]);
    expect(result.gaps[0]?.message).toContain("No SEC 10-K or 10-Q filing found");
  });

  test("normalizes HTML and entities to plain text", () => {
    expect(normalizeFilingText("<p>Revenue&nbsp;&amp;&nbsp;margin</p><script>x()</script>")).toBe(
      "Revenue & margin",
    );
  });

  test("emits fetch failure gap from filing text fetch", async () => {
    const result = await executeEvidenceRequestTool(
      "sec_latest_filing",
      baseCtx({
        request: requestExecutor({
          json: async ({ adapter }) =>
            adapter === "sec-tickers"
              ? jsonResult(adapter, secTickersPayload())
              : jsonResult(adapter, secSubmissionsPayload()),
          text: async () => gap("sec-filing-text", "timeout"),
        }),
      }),
    );

    expect(result.sources).toEqual([]);
    expect(result.rawSnapshots).toHaveLength(2);
    expect(result.gaps).toEqual([
      expect.objectContaining({ source: "sec-filing-text", message: "timeout" }),
    ]);
  });
});

describe("Tradier IV term structure evidence tool", () => {
  test("fetches nearest expirations and computes median IV slopes", async () => {
    const headers: string[] = [];
    const expirationsFetchedAt = "2026-05-02T00:00:00.000Z";
    const chainFetchedAt = "2026-04-30T00:00:00.000Z";
    const ctx = baseCtx({
      tradierApiToken: "tradier-token",
      request: requestExecutor({
        json: async ({ url, adapter, init }) => {
          headers.push(new Headers(init?.headers).get("authorization") ?? "");
          if (adapter === "tradier-expirations") {
            return jsonResult(
              adapter,
              {
                expirations: {
                  date: ["2026-05-08", "2026-05-31", "2026-06-30", "2026-07-30"],
                },
              },
              expirationsFetchedAt,
            );
          }
          const expiration = new URL(url).searchParams.get("expiration");
          const medians: Record<string, readonly number[]> = {
            "2026-05-08": [0.2, 0.4],
            "2026-05-31": [0.35],
            "2026-06-30": [0.45],
            "2026-07-30": [0.55],
          };
          return jsonResult(
            adapter,
            {
              options: {
                option: (medians[expiration ?? ""] ?? []).map((iv) => ({
                  greeks: { mid_iv: iv },
                })),
              },
            },
            chainFetchedAt,
          );
        },
      }),
    });

    const result = await executeEvidenceRequestTool("tradier_iv_term_structure", ctx);

    expect(result.gaps).toEqual([]);
    expect(result.rawSnapshots).toHaveLength(5);
    expect(result.sources[0]?.provider).toBe("tradier");
    expect(result.sources[0]?.fetchedAt).toBe(chainFetchedAt);
    expect(result.items[0]?.observedAt).toBe(chainFetchedAt);
    expect(result.items[0]?.summary).toContain("7D 0.300");
    const metrics = result.items[0]?.metrics;
    expect(metrics?.medianIv7Dte).toBeCloseTo(0.3);
    expect(metrics?.actualDte7Dte).toBe(6);
    expect(metrics?.medianIv30Dte).toBe(0.35);
    expect(metrics?.iv30Minus7).toBeCloseTo(0.05);
    expect(metrics?.iv90Minus30).toBeCloseTo(0.2);
    expect(headers.every((header) => header === "Bearer tradier-token")).toBe(true);
  });

  test("requires Tradier token and marks tool unavailable", async () => {
    const ctx = baseCtx();

    expect(availableEvidenceRequestTools(ctx)).toEqual(["sec_latest_filing"]);
    const result = await executeEvidenceRequestTool("tradier_iv_term_structure", ctx);

    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "tradier-options",
        message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
      }),
    ]);
  });

  test("emits gap when expirations are missing", async () => {
    const result = await executeEvidenceRequestTool(
      "tradier_iv_term_structure",
      baseCtx({
        tradierApiToken: "tradier-token",
        request: requestExecutor({
          json: async ({ adapter }) => jsonResult(adapter, { expirations: { date: [] } }),
        }),
      }),
    );

    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({
        source: "tradier-options",
        message: "No Tradier option expirations found",
      }),
    ]);
  });

  test("emits partial coverage item with gaps for empty buckets", async () => {
    const result = await executeEvidenceRequestTool(
      "tradier_iv_term_structure",
      baseCtx({
        tradierApiToken: "tradier-token",
        request: requestExecutor({
          json: async ({ url, adapter }) => {
            if (adapter === "tradier-expirations") {
              return jsonResult(adapter, {
                expirations: { date: ["2026-05-08", "2026-05-31"] },
              });
            }
            const expiration = new URL(url).searchParams.get("expiration");
            return jsonResult(adapter, {
              options: {
                option: expiration === "2026-05-08" ? [{ greeks: { mid_iv: 0.25 } }] : [],
              },
            });
          },
        }),
      }),
    );

    expect(result.sources).toHaveLength(1);
    expect(result.items[0]?.metrics).toMatchObject({ medianIv7Dte: 0.25 });
    expect(result.gaps[0]?.message).toContain("No Tradier IV values found");
  });

  test("emits fetch failure gap", async () => {
    const result = await executeEvidenceRequestTool(
      "tradier_iv_term_structure",
      baseCtx({
        tradierApiToken: "tradier-token",
        request: requestExecutor({
          json: async () => gap("tradier-expirations", "rate limit"),
        }),
      }),
    );

    expect(result.rawSnapshots).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({ source: "tradier-expirations", message: "rate limit" }),
    ]);
  });
});
