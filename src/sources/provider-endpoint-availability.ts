import type { SourceGap } from "../domain/types";
import type { RawSourceSnapshot } from "./types";

export interface ProviderEndpointAvailability {
  readonly status: "available" | "missing-credential" | "unsupported" | "unmeasured";
  readonly evidence: readonly string[];
  readonly reason?: string;
}

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
  tradierOptions: { adapters: ["tradier-options"], gapSources: ["tradier-options"] },
  tradierEarningsImpliedMove: {
    adapters: ["tradier-earnings"],
    gapSources: ["earnings-setup-implied-move", "tradier-options"],
    availableEvidence: ["earningsSetup.impliedMove"],
  },
  fredMacro: { adapters: ["fred-"], gapSources: ["fred-macro"] },
  marketauxNews: { adapters: ["marketaux-news"], gapSources: ["marketaux-news"] },
};

export function availableEndpoint(evidence: readonly string[]): ProviderEndpointAvailability {
  return { status: "available", evidence };
}

export function unavailableEndpoint(
  status: "missing-credential" | "unsupported" | "unmeasured",
  reason: string,
  evidence: readonly string[] = [],
): ProviderEndpointAvailability {
  return { status, evidence, reason };
}

function deriveEndpoint(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  definition: EndpointDefinition,
): ProviderEndpointAvailability {
  const observedAdapters = [
    ...new Set(
      rawSnapshots
        .map((snapshot) => snapshot.adapter)
        .filter((adapter) =>
          definition.adapters.some((candidate) => adapter.startsWith(candidate)),
        ),
    ),
  ].toSorted();
  if (observedAdapters.length > 0) {
    return availableEndpoint(observedAdapters);
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

export function deriveProviderEndpointAvailability(
  rawSnapshots: readonly RawSourceSnapshot[],
  sourceGaps: readonly SourceGap[],
  hasTradierEarningsImpliedMove = false,
): Readonly<Record<string, ProviderEndpointAvailability>> {
  return Object.fromEntries(
    Object.entries(ENDPOINTS).map(([endpoint, definition]) => [
      endpoint,
      endpoint === "tradierEarningsImpliedMove" && hasTradierEarningsImpliedMove
        ? availableEndpoint(definition.availableEvidence ?? [])
        : deriveEndpoint(rawSnapshots, sourceGaps, definition),
    ]),
  );
}
