import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { classifyGap, readGapTriage } from "../src/report/gap-triage";

describe("gap triage", () => {
  test.each([
    [
      "optional-provider absence",
      {
        source: "tradier-options",
        message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
        cause: "missing-credential",
      } satisfies SourceGap,
    ],
    [
      "entitlement 403",
      {
        source: "finnhub-eps-estimate",
        message: "Finnhub EPS estimate endpoint is unavailable (status 403)",
        cause: "unsupported-coverage",
      } satisfies SourceGap,
    ],
    [
      "optional provider identified by provider metadata",
      {
        source: "analyst-estimates",
        provider: "finnhub",
        message: "Finnhub credential is missing",
        cause: "missing-credential",
      } satisfies SourceGap,
    ],
    [
      "colon-qualified optional provider source",
      {
        source: "finnhub:estimates",
        message: "Finnhub credential is missing",
        cause: "missing-credential",
      } satisfies SourceGap,
    ],
    ["missing FRED credential", "fred-macro: MARKET_BOT_FRED_API_KEY is not set"],
    [
      "feature-named optional-provider credential absence",
      "earnings-setup-implied-move: MARKET_BOT_TRADIER_API_TOKEN is not set; implied move unavailable",
    ],
    [
      "valuation peer exclusion",
      "valuation-peers: Peer DELL excluded from valuation comps: market cap outside range",
    ],
    ["operating KPI reason code", "operating-kpi-unverified:asts-satellites-launched"],
    ["registry unconfigured", "operating-kpi-registry-unconfigured"],
    [
      "model-authored provider-neutral availability prose",
      "Provider-neutral EPS, revenue, EBITDA, analyst-range, and consensus-estimate evidence is unavailable.",
    ],
    ["typographic provider-neutral prose", "Provider‑neutral EPS evidence is unavailable."],
    [
      "API token entitlement",
      "Analyst estimates are unavailable because the API token is not entitled for this endpoint.",
    ],
    ["missing API token", "The API token is missing, so estimate evidence is unavailable."],
    ["account entitlement", "The account is not entitled to consensus estimates."],
    ["HTTP 403 prose", "Consensus evidence is unavailable after the API returned status 403."],
    ["API quota", "The API quota is exhausted, so consensus evidence could not be collected."],
  ])("classifies %s as diagnostic", (_label, gap) => {
    expect(classifyGap(gap)).toBe("diagnostic");
  });

  test.each([
    ["missing statements", "current-annual-statement-missing"],
    [
      "failed verified price snapshot",
      {
        source: "verified-snapshot",
        message: "Verified market snapshot failed",
        cause: "fetch-failed",
        evidenceQualityImpact: "core-cap",
      } satisfies SourceGap,
    ],
    [
      "provider data missing on a core lane",
      {
        source: "yahoo-market-data",
        message: "No usable market snapshot",
        cause: "provider-data-missing",
        evidenceQualityImpact: "core-cap",
      } satisfies SourceGap,
    ],
    [
      "unrecognised feature-named credential gap",
      "earnings-setup-implied-move: MARKET_BOT_UNKNOWN_API_TOKEN is not set",
    ],
    ["missing company disclosure", "The company does not disclose segment operating margin."],
    ["missing company guidance", "No FY2027 guidance was provided."],
    [
      "company subscription-tier disclosure",
      "The company does not disclose which subscription tier customers choose.",
    ],
    ["company token holdings disclosure", "The company does not disclose token holdings."],
    [
      "operating provider availability",
      "A critical payment provider is unavailable in one market.",
    ],
    ["company subscription-tier mix", "Customer mix by subscription tier is unavailable."],
    [
      "provider does not expose data without technical access context",
      "The provider does not expose analyst estimates on the configured subscription tier.",
    ],
    [
      "subscription-tier estimate availability",
      "Revenue estimates are unavailable under the current subscription tier.",
    ],
    [
      "provider plan limit without technical access context",
      "The provider plan blocks access to analyst-range evidence.",
    ],
    [
      "provider-network analyst estimates",
      "Analyst estimates for the provider network segment are unavailable",
    ],
    [
      "provider-network consensus estimates",
      "Consensus estimates do not separate the provider network, so segment detail is missing",
    ],
    [
      "cloud-provider revenue estimates",
      "Revenue estimates for the cloud provider segment are missing from filings",
    ],
    [
      "hosting-provider ownership data",
      "Ownership data for the joint venture with its hosting provider is missing",
    ],
    [
      "provider-contract options data",
      "Options data around the provider contract renewal is unavailable",
    ],
    [
      "provider-ruling implied volatility",
      "Implied volatility ahead of the provider reimbursement ruling is unavailable",
    ],
    [
      "divested-provider EPS estimates",
      "EPS estimates for the divested provider business are unavailable",
    ],
    [
      "subscription-tier revenue estimates",
      "Revenue estimates by subscription tier are missing from disclosure",
    ],
    [
      "colon-free mixed research and provider-neutral gap",
      "Segment margin is not available from current filings; analyst consensus is not available from a provider-neutral authoritative capability",
    ],
    [
      "provider-neutral evidence followed by company guidance gap",
      "Provider-neutral revenue evidence exists, but FY2027 guidance is missing.",
    ],
    [
      "provider-neutral peer gap caused by company filings",
      "Provider-neutral peer benchmarks are missing because no peer filed comparable segment data.",
    ],
    [
      "company service provider disclosure",
      "The provider does not provide unit economics for the hosting segment.",
    ],
    [
      "vendor provider access limitation",
      "Its payments provider limits access to interchange data, so take-rate evidence is missing.",
    ],
    [
      "company provider plan expiration",
      "The company's cloud provider plan for its largest customer expired in Q2 and no renewal terms were disclosed.",
    ],
    [
      "company subscription-tier detail",
      "Under the current subscription tier, deferred revenue detail is missing.",
    ],
    [
      "API key product-line gap",
      "A key API key management product line was discontinued; segment revenue is unavailable.",
    ],
    [
      "mixed structured research gap",
      "business-framework: Segment margin is not available from current filings; analyst consensus is not available from a provider-neutral authoritative capability",
    ],
  ])("classifies %s as material", (_label, gap) => {
    expect(classifyGap(gap)).toBe("material");
  });

  test("demotes SEC gaps scoped to a peer while retaining subject gaps as material", () => {
    expect(classifyGap("sec-edgar: Missing SEC company facts: revenue [MSFT]", "AAPL")).toBe(
      "diagnostic",
    );
    expect(classifyGap("sec-edgar: Missing SEC company facts: revenue [AAPL]", "AAPL")).toBe(
      "material",
    );
  });

  test("defaults an unknown code to material", () => {
    expect(classifyGap("new-unmapped-gap-code")).toBe("material");
  });

  test("keeps colon-bearing prose material before the model-prose backstop", () => {
    expect(classifyGap("model-note: Provider-neutral EPS evidence is unavailable.")).toBe(
      "material",
    );
  });

  test("uses string classification for legacy structured gaps without triage", () => {
    const legacyGap = {
      source: "finnhub-events",
      message: "Finnhub events endpoint failed with status 403",
    } satisfies SourceGap;
    const text = "finnhub-events: Finnhub events endpoint failed with status 403";

    expect(classifyGap(legacyGap)).toBe("material");
    expect(readGapTriage(text, [legacyGap])).toBe("diagnostic");
  });
});
