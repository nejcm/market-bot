import type { WebGatherLoopAudit } from "../domain/types";

// Per-tool provider counts for one run's Web Gather execution.
export interface WebGatherProviderCounts {
  readonly requestCount: number;
  // Requests where Exa was unusable and the Firecrawl fallback path was entered — a hard failure,
  // Circuit open, fetch failure, an empty response, or fewer results than the usable minimum.
  readonly exaFallbackCount: number;
  // Subset of `exaFallbackCount` in which Exa never responded at all.
  readonly exaHardFailureCount: number;
  readonly firecrawlAttemptCount: number;
  readonly firecrawlServedCount: number;
  readonly firecrawlKeyMissing: boolean;
}

// Provider-level view of one run's Web Gather execution.
//
// Web Gather runs Exa first and falls back to Firecrawl per request, and a covered fallback
// Deliberately drops Exa's Source Gap (see `web-gather-tools.ts`). Without this projection the
// Incident survives only inside the audit sidecar, so Provider Health and Subsystem Outcomes both
// Read a degraded run as a clean one.
//
// `search` and `fetch` stay separate because they are different endpoints: `web_search` runs Exa
// Search against Firecrawl search, `web_fetch` runs Exa contents against a Firecrawl scrape. Folding
// Them together would let a failed content fetch report the search endpoint as degraded.
export interface WebGatherProviderTelemetry {
  readonly search: WebGatherProviderCounts;
  readonly fetch: WebGatherProviderCounts;
}

const FIRECRAWL_PROVIDER_NAME = "firecrawl";

function toolCounts(
  audit: WebGatherLoopAudit,
  tool: "web_search" | "web_fetch",
): WebGatherProviderCounts {
  const requests = audit.acceptedRequests.filter((entry) => entry.tool === tool);
  const fallbacks = requests.flatMap((entry) =>
    entry.fallback === undefined ? [] : [entry.fallback],
  );
  return {
    requestCount: requests.length,
    exaFallbackCount: fallbacks.length,
    exaHardFailureCount: fallbacks.filter((record) => record.fallbackReason === "hard-failure")
      .length,
    firecrawlAttemptCount: fallbacks.filter((record) =>
      record.attemptedProviders.includes(FIRECRAWL_PROVIDER_NAME),
    ).length,
    firecrawlServedCount: fallbacks.filter(
      (record) => record.servedProvider === FIRECRAWL_PROVIDER_NAME,
    ).length,
    firecrawlKeyMissing: fallbacks.some(
      (record) => record.unavailableReason === "no-firecrawl-key",
    ),
  };
}

// Returns undefined when the Web Gather stage never executed (skipped, out of scope, or not a
// Web-enabled run). Undefined is not an empty run: a run that never attempted web search must not
// Be reported as a degraded web provider.
export function deriveWebGatherProviderTelemetry(
  audit: WebGatherLoopAudit | undefined,
): WebGatherProviderTelemetry | undefined {
  if (audit === undefined) {
    return undefined;
  }
  return { search: toolCounts(audit, "web_search"), fetch: toolCounts(audit, "web_fetch") };
}
