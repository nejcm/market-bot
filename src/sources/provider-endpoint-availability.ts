import type { SourceGap } from "../domain/types";
import type { RawSourceSnapshot } from "./types";
import type { WebGatherProviderCounts } from "./web-search-telemetry";

// Status `degraded` means the endpoint was reached and the run continued, but not on the
// Endpoint's own output: the primary web-search provider was unusable for at least one request and
// A fallback covered it. It is deliberately distinct from `available` (served its own results) and
// From `unmeasured` (never attempted), because a covered degradation is otherwise invisible.
export interface ProviderEndpointAvailability {
  readonly status: "available" | "degraded" | "missing-credential" | "unsupported" | "unmeasured";
  readonly evidence: readonly string[];
  readonly reason?: string;
}

const EXA_SEARCH_ENDPOINT = "exaSearch";
const FIRECRAWL_SEARCH_ENDPOINT = "firecrawlSearch";
// Search adapters only. `exa-contents` and `firecrawl-scrape` back the `web_fetch` tool, and
// Counting them here would let a failed content fetch report the search endpoint as degraded.
const EXA_SEARCH_ADAPTER_PREFIX = "exa-search";
const FIRECRAWL_SEARCH_ADAPTER_PREFIX = "firecrawl-search";
const WEB_GATHER_EVIDENCE = ["web-gather"];

interface EndpointDefinition {
  readonly adapters: readonly string[];
  readonly gapSources: readonly string[];
  readonly availableEvidence?: readonly string[];
}

const ENDPOINTS: Readonly<Record<string, EndpointDefinition>> = {
  yahooQuote: { adapters: ["yahoo-ticker"], gapSources: ["yahoo-ticker"] },
  yahooNews: { adapters: ["yahoo-news"], gapSources: ["yahoo-news"] },
  secCompanyTickers: { adapters: ["sec-tickers"], gapSources: ["sec-edgar"] },
  secCompanyFacts: { adapters: ["sec-companyfacts"], gapSources: ["sec-edgar"] },
  secSubmissions: { adapters: ["sec-submissions"], gapSources: ["sec-edgar"] },
  finnhubNews: { adapters: ["finnhub-news"], gapSources: ["finnhub-news"] },
  finnhubEvents: { adapters: ["finnhub-events"], gapSources: ["finnhub-events"] },
  finnhubEpsEstimate: {
    adapters: ["finnhub-eps-estimate"],
    gapSources: ["finnhub-eps-estimate"],
  },
  finnhubRevenueEstimate: {
    adapters: ["finnhub-revenue-estimate"],
    gapSources: ["finnhub-revenue-estimate"],
  },
  finnhubEbitdaEstimate: {
    adapters: ["finnhub-ebitda-estimate"],
    gapSources: ["finnhub-ebitda-estimate"],
  },
  finnhubPriceTarget: {
    adapters: ["finnhub-analyst-range"],
    gapSources: ["finnhub-analyst-range"],
  },
  finnhubInstitutionalOwnership: {
    adapters: ["finnhub-institutional-ownership"],
    gapSources: ["finnhub-institutional-ownership"],
  },
  finnhubInsiderTransactions: {
    adapters: ["finnhub-insider-transactions"],
    gapSources: ["finnhub-insider-transactions"],
  },
  tradierOptions: { adapters: ["tradier-options"], gapSources: ["tradier-options"] },
  tradierEarningsImpliedMove: {
    adapters: ["tradier-earnings"],
    gapSources: ["earnings-setup-implied-move", "tradier-options"],
    availableEvidence: ["earningsSetup.impliedMove"],
  },
  fredMacro: { adapters: ["fred-"], gapSources: ["fred-macro"] },
  marketauxNews: { adapters: ["marketaux-news"], gapSources: ["marketaux-news"] },
};

function availableEndpoint(evidence: readonly string[]): ProviderEndpointAvailability {
  return { status: "available", evidence };
}

export function unavailableEndpoint(
  status: "degraded" | "missing-credential" | "unsupported" | "unmeasured",
  reason: string,
  evidence: readonly string[] = [],
): ProviderEndpointAvailability {
  return { status, evidence, reason };
}

function observedAdapters(
  rawSnapshots: readonly RawSourceSnapshot[],
  prefixes: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      rawSnapshots
        .map((snapshot) => snapshot.adapter)
        .filter((adapter) => prefixes.some((candidate) => adapter.startsWith(candidate))),
    ),
  ].toSorted();
}

function deriveEndpoint(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  definition: EndpointDefinition,
): ProviderEndpointAvailability {
  const observed = observedAdapters(rawSnapshots, definition.adapters);
  if (observed.length > 0) {
    return availableEndpoint(observed);
  }

  const gaps = sourceGaps.filter((gap) => definition.gapSources.includes(gap.source));
  const missingCredential = gaps.find((gap) => gap.cause === "missing-credential");
  if (missingCredential !== undefined) {
    return unavailableEndpoint(
      "missing-credential",
      missingCredential.message,
      definition.gapSources,
    );
  }
  const unsupported = gaps.find((gap) => gap.cause === "unsupported-coverage");
  if (unsupported !== undefined) {
    return unavailableEndpoint("unsupported", unsupported.message, definition.gapSources);
  }
  return unavailableEndpoint(
    "unmeasured",
    `No request or normalized availability gap for ${definition.gapSources.join(", ")}`,
  );
}

export interface ProviderEndpointAvailabilityOptions {
  readonly hasTradierEarningsImpliedMove?: boolean;
  /** `web_search` counts only. Omitted when the Web Gather stage never executed. */
  readonly webSearch?: WebGatherProviderCounts;
}

function exaSearchAvailability(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  webSearch: WebGatherProviderCounts | undefined,
): ProviderEndpointAvailability {
  const missingCredential = sourceGaps.find(
    (gap) => gap.provider === "exa" && gap.cause === "missing-credential",
  );
  if (missingCredential !== undefined) {
    return unavailableEndpoint("missing-credential", missingCredential.message, [
      ...WEB_GATHER_EVIDENCE,
    ]);
  }
  const observed = observedAdapters(rawSnapshots, [EXA_SEARCH_ADAPTER_PREFIX]);
  if (webSearch === undefined) {
    return unavailableEndpoint("unmeasured", "Web Gather did not run for this run");
  }
  if (webSearch.exaFallbackCount > 0) {
    return unavailableEndpoint(
      "degraded",
      `Exa search was unusable for ${String(webSearch.exaFallbackCount)} of ${String(webSearch.requestCount)} web search request(s) (${String(webSearch.exaHardFailureCount)} without any Exa response); Firecrawl served ${String(webSearch.firecrawlServedCount)}`,
      observed,
    );
  }
  if (webSearch.requestCount > 0) {
    return availableEndpoint(observed);
  }
  return unavailableEndpoint("unmeasured", "Web Gather executed no web search request");
}

function firecrawlSearchAvailability(
  rawSnapshots: readonly RawSourceSnapshot[],
  webSearch: WebGatherProviderCounts | undefined,
): ProviderEndpointAvailability {
  if (webSearch === undefined) {
    return unavailableEndpoint("unmeasured", "Web Gather did not run for this run");
  }
  const observed = observedAdapters(rawSnapshots, [FIRECRAWL_SEARCH_ADAPTER_PREFIX]);
  // `available` means the fallback covered every request it was asked to cover. Serving some of
  // Them is partial coverage, and reading it as full coverage would let the unserved request
  // Disappear: its Exa Source Gap is already closed by the fallback path.
  if (
    webSearch.firecrawlAttemptCount > 0 &&
    webSearch.firecrawlServedCount === webSearch.firecrawlAttemptCount
  ) {
    return availableEndpoint(observed);
  }
  if (webSearch.firecrawlServedCount > 0) {
    return unavailableEndpoint(
      "degraded",
      `Firecrawl search served only ${String(webSearch.firecrawlServedCount)} of ${String(webSearch.firecrawlAttemptCount)} fallback web search request(s)`,
      observed,
    );
  }
  if (webSearch.firecrawlAttemptCount > 0) {
    return unavailableEndpoint(
      "degraded",
      `Firecrawl search fallback ran for ${String(webSearch.firecrawlAttemptCount)} web search request(s) without serving a usable result`,
      observed,
    );
  }
  if (webSearch.firecrawlKeyMissing) {
    return unavailableEndpoint(
      "missing-credential",
      "MARKET_BOT_FIRECRAWL_API_KEY is not set; the Exa fallback was unavailable",
      [...WEB_GATHER_EVIDENCE],
    );
  }
  return unavailableEndpoint(
    "unmeasured",
    "Firecrawl is fallback-only and was not attempted for this run",
  );
}

// The two web-search rows are emitted for every Web Gather-capable run type, not just equity: a
// Deep crypto or research run falls back the same way and must report it in the same place.
export function deriveWebSearchEndpointAvailability(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  webSearch: WebGatherProviderCounts | undefined,
): Readonly<Record<string, ProviderEndpointAvailability>> {
  return {
    [EXA_SEARCH_ENDPOINT]: exaSearchAvailability(rawSnapshots, sourceGaps, webSearch),
    [FIRECRAWL_SEARCH_ENDPOINT]: firecrawlSearchAvailability(rawSnapshots, webSearch),
  };
}

export function deriveProviderEndpointAvailability(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  options: ProviderEndpointAvailabilityOptions = {},
): Readonly<Record<string, ProviderEndpointAvailability>> {
  return {
    ...Object.fromEntries(
      Object.entries(ENDPOINTS).map(([endpoint, definition]) => [
        endpoint,
        endpoint === "tradierEarningsImpliedMove" && options.hasTradierEarningsImpliedMove === true
          ? availableEndpoint(definition.availableEvidence ?? [])
          : deriveEndpoint(rawSnapshots, sourceGaps, definition),
      ]),
    ),
    ...deriveWebSearchEndpointAvailability(rawSnapshots, sourceGaps, options.webSearch),
  };
}
