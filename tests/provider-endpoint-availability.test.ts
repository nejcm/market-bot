import { describe, expect, test } from "bun:test";
import type { SourceGap, WebGatherFallbackAudit, WebGatherLoopAudit } from "../src/domain/types";
import { deriveProviderEndpointAvailability } from "../src/sources/provider-endpoint-availability";
import type { RawSourceSnapshot } from "../src/sources/types";
import { deriveWebGatherProviderTelemetry } from "../src/sources/web-search-telemetry";

function snapshot(adapter: string): RawSourceSnapshot {
  return {
    id: adapter,
    adapter,
    fetchedAt: "2026-07-23T00:00:00.000Z",
    payload: {},
  };
}

function gap(
  source: string,
  cause: "missing-credential" | "unsupported-coverage" | "fetch-failed",
  message: string,
): SourceGap {
  return { source, cause, message };
}

describe("provider endpoint availability", () => {
  test("derives available endpoints from sorted unique adapter evidence", () => {
    const result = deriveProviderEndpointAvailability(
      [
        snapshot("finnhub-events-3"),
        snapshot("finnhub-events-1"),
        snapshot("finnhub-events-1"),
        snapshot("finnhub-eps-estimate"),
        snapshot("finnhub-revenue-estimate"),
        snapshot("finnhub-ebitda-estimate"),
        snapshot("finnhub-analyst-range"),
        snapshot("finnhub-institutional-ownership"),
        snapshot("finnhub-insider-transactions"),
      ],
      [],
    );

    expect(result.finnhubEvents).toEqual({
      status: "available",
      evidence: ["finnhub-events-1", "finnhub-events-3"],
    });
    expect(result.finnhubEpsEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-eps-estimate"],
    });
    expect(result.finnhubRevenueEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-revenue-estimate"],
    });
    expect(result.finnhubEbitdaEstimate).toEqual({
      status: "available",
      evidence: ["finnhub-ebitda-estimate"],
    });
    expect(result.finnhubPriceTarget).toEqual({
      status: "available",
      evidence: ["finnhub-analyst-range"],
    });
    expect(result.finnhubInstitutionalOwnership).toEqual({
      status: "available",
      evidence: ["finnhub-institutional-ownership"],
    });
    expect(result.finnhubInsiderTransactions).toEqual({
      status: "available",
      evidence: ["finnhub-insider-transactions"],
    });
  });

  test("prefers observed requests over availability gaps", () => {
    const result = deriveProviderEndpointAvailability(
      [snapshot("sec-companyfacts")],
      [gap("sec-edgar", "missing-credential", "credential absent")],
    );

    expect(result.secCompanyFacts).toEqual({
      status: "available",
      evidence: ["sec-companyfacts"],
    });
  });

  test("classifies missing credentials and unsupported coverage", () => {
    const result = deriveProviderEndpointAvailability(
      [],
      [
        gap("finnhub-events", "missing-credential", "token absent"),
        gap("finnhub-eps-estimate", "unsupported-coverage", "plan unavailable"),
        gap("finnhub-revenue-estimate", "missing-credential", "token absent"),
        gap("finnhub-institutional-ownership", "unsupported-coverage", "plan unavailable"),
        gap("finnhub-insider-transactions", "missing-credential", "token absent"),
        gap("tradier-options", "unsupported-coverage", "listing unsupported"),
      ],
    );

    expect(result.finnhubEvents).toEqual({
      status: "missing-credential",
      evidence: ["finnhub-events"],
      reason: "token absent",
    });
    expect(result.tradierOptions).toEqual({
      status: "unsupported",
      evidence: ["tradier-options"],
      reason: "listing unsupported",
    });
    expect(result.finnhubEpsEstimate).toEqual({
      status: "unsupported",
      evidence: ["finnhub-eps-estimate"],
      reason: "plan unavailable",
    });
    expect(result.finnhubRevenueEstimate).toEqual({
      status: "missing-credential",
      evidence: ["finnhub-revenue-estimate"],
      reason: "token absent",
    });
    expect(result.finnhubInstitutionalOwnership).toEqual({
      status: "unsupported",
      evidence: ["finnhub-institutional-ownership"],
      reason: "plan unavailable",
    });
    expect(result.finnhubInsiderTransactions).toEqual({
      status: "missing-credential",
      evidence: ["finnhub-insider-transactions"],
      reason: "token absent",
    });
  });

  test("keeps unobserved endpoints unmeasured", () => {
    const result = deriveProviderEndpointAvailability([], []);

    expect(result.yahooQuote).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "No request or normalized availability gap for yahoo-ticker",
    });
  });

  test("preserves the phase0 implied-move evidence label when the value is present", () => {
    const result = deriveProviderEndpointAvailability([], [], {
      hasTradierEarningsImpliedMove: true,
    });

    expect(result.tradierEarningsImpliedMove).toEqual({
      status: "available",
      evidence: ["earningsSetup.impliedMove"],
    });
  });
});

interface AuditRequest {
  readonly tool: "web_search" | "web_fetch";
  readonly fallback?: WebGatherFallbackAudit;
}

function webGatherAudit(requests: readonly AuditRequest[]): WebGatherLoopAudit {
  return {
    rounds: 1,
    acceptedRequests: requests.map((request, index) => ({
      round: 1,
      tool: request.tool,
      status: "accepted",
      sourceUnits: 2,
      ...(request.fallback !== undefined ? { fallback: request.fallback } : {}),
      args: { query: `query ${String(index)}` },
    })),
    rejectedRequests: [],
    sourceUnitsUsed: 2 * requests.length,
    executedTools: requests.map((request) => request.tool),
    emittedGaps: [],
    sanitizer: {
      sourceCount: 0,
      sanitizedSourceCount: 0,
      emptyAfterSanitizeCount: 0,
      inputCharCount: 0,
      outputCharCount: 0,
      removedInstructionSpanCount: 0,
      removedChromeHtmlCount: 0,
    },
  };
}

function webSearchRows(
  snapshots: readonly RawSourceSnapshot[],
  gaps: readonly SourceGap[],
  audit?: WebGatherLoopAudit,
) {
  const webSearch = deriveWebGatherProviderTelemetry(audit)?.search;
  const result = deriveProviderEndpointAvailability(
    snapshots,
    gaps,
    webSearch === undefined ? {} : { webSearch },
  );
  return { exaSearch: result.exaSearch, firecrawlSearch: result.firecrawlSearch };
}

describe("web search provider endpoint availability", () => {
  test("reports exa available and firecrawl unattempted when exa served every request", () => {
    const rows = webSearchRows(
      [snapshot("exa-search"), snapshot("exa-contents")],
      [],
      webGatherAudit([{ tool: "web_search" }, { tool: "web_search" }]),
    );

    expect(rows.exaSearch).toEqual({
      status: "available",
      evidence: ["exa-search"],
    });
    expect(rows.firecrawlSearch).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "Firecrawl is fallback-only and was not attempted for this run",
    });
  });

  test("marks exa degraded when a hard failure was covered by a successful firecrawl fallback", () => {
    const rows = webSearchRows(
      [snapshot("firecrawl-search")],
      [],
      webGatherAudit([
        {
          tool: "web_search",
          fallback: {
            attemptedProviders: ["exa", "firecrawl"],
            servedProvider: "firecrawl",
            fallbackReason: "hard-failure",
          },
        },
        { tool: "web_search" },
      ]),
    );

    expect(rows.exaSearch).toEqual({
      status: "degraded",
      evidence: [],
      reason:
        "Exa search was unusable for 1 of 2 web search request(s) (1 without any Exa response); Firecrawl served 1",
    });
    expect(rows.firecrawlSearch).toEqual({
      status: "available",
      evidence: ["firecrawl-search"],
    });
  });

  test("marks exa degraded when a thin response was covered, counting no hard failure", () => {
    const rows = webSearchRows(
      [snapshot("exa-search"), snapshot("firecrawl-search")],
      [],
      webGatherAudit([
        {
          tool: "web_search",
          fallback: {
            attemptedProviders: ["exa", "firecrawl"],
            servedProvider: "firecrawl",
            fallbackReason: "thin",
          },
        },
      ]),
    );

    expect(rows.exaSearch).toEqual({
      status: "degraded",
      evidence: ["exa-search"],
      reason:
        "Exa search was unusable for 1 of 1 web search request(s) (0 without any Exa response); Firecrawl served 1",
    });
  });

  test("marks firecrawl degraded when it served only some of the requests it was asked to cover", () => {
    const rows = webSearchRows(
      [snapshot("exa-search"), snapshot("firecrawl-search")],
      [],
      webGatherAudit([
        {
          tool: "web_search",
          fallback: {
            attemptedProviders: ["exa", "firecrawl"],
            servedProvider: "firecrawl",
            fallbackReason: "hard-failure",
          },
        },
        {
          tool: "web_search",
          fallback: { attemptedProviders: ["exa", "firecrawl"], fallbackReason: "hard-failure" },
        },
      ]),
    );

    expect(rows.exaSearch).toEqual({
      status: "degraded",
      evidence: ["exa-search"],
      reason:
        "Exa search was unusable for 2 of 2 web search request(s) (2 without any Exa response); Firecrawl served 1",
    });
    expect(rows.firecrawlSearch).toEqual({
      status: "degraded",
      evidence: ["firecrawl-search"],
      reason: "Firecrawl search served only 1 of 2 fallback web search request(s)",
    });
  });

  test("marks firecrawl degraded when the fallback ran without serving a result", () => {
    const rows = webSearchRows(
      [snapshot("firecrawl-search")],
      [],
      webGatherAudit([
        {
          tool: "web_search",
          fallback: { attemptedProviders: ["exa", "firecrawl"], fallbackReason: "hard-failure" },
        },
      ]),
    );

    expect(rows.exaSearch?.status).toBe("degraded");
    expect(rows.firecrawlSearch).toEqual({
      status: "degraded",
      evidence: ["firecrawl-search"],
      reason:
        "Firecrawl search fallback ran for 1 web search request(s) without serving a usable result",
    });
  });

  test("reports the firecrawl credential as missing when the fallback could not be attempted", () => {
    const rows = webSearchRows(
      [],
      [],
      webGatherAudit([
        {
          tool: "web_search",
          fallback: {
            attemptedProviders: ["exa"],
            fallbackReason: "hard-failure",
            unavailableReason: "no-firecrawl-key",
          },
        },
      ]),
    );

    expect(rows.exaSearch?.status).toBe("degraded");
    expect(rows.firecrawlSearch).toEqual({
      status: "missing-credential",
      evidence: ["web-gather"],
      reason: "MARKET_BOT_FIRECRAWL_API_KEY is not set; the Exa fallback was unavailable",
    });
  });

  test("ignores a covered web_fetch fallback: the search endpoints did not degrade", () => {
    const rows = webSearchRows(
      [snapshot("exa-search"), snapshot("exa-contents"), snapshot("firecrawl-scrape")],
      [],
      webGatherAudit([
        { tool: "web_search" },
        {
          tool: "web_fetch",
          fallback: {
            attemptedProviders: ["exa", "firecrawl"],
            servedProvider: "firecrawl",
            fallbackReason: "hard-failure",
          },
        },
      ]),
    );

    expect(rows.exaSearch).toEqual({ status: "available", evidence: ["exa-search"] });
    expect(rows.firecrawlSearch).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "Firecrawl is fallback-only and was not attempted for this run",
    });
  });

  test("keeps both web search rows unmeasured when web gather never ran", () => {
    const rows = webSearchRows([], []);

    expect(rows.exaSearch).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "Web Gather did not run for this run",
    });
    expect(rows.firecrawlSearch).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "Web Gather did not run for this run",
    });
  });

  test("keeps exa unmeasured when the stage ran but accepted no request", () => {
    const rows = webSearchRows([], [], webGatherAudit([]));

    expect(rows.exaSearch).toEqual({
      status: "unmeasured",
      evidence: [],
      reason: "Web Gather executed no web search request",
    });
  });

  test("reports a missing exa credential from the skipped-stage source gap", () => {
    const rows = webSearchRows(
      [],
      [
        {
          source: "web-gather",
          provider: "exa",
          cause: "missing-credential",
          message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
        },
      ],
    );

    expect(rows.exaSearch).toEqual({
      status: "missing-credential",
      evidence: ["web-gather"],
      reason: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
    });
    expect(rows.firecrawlSearch?.status).toBe("unmeasured");
  });
});
