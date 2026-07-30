import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import { classifyGap } from "../src/report/gap-triage";

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
      "valuation peer exclusion",
      "valuation-peers: Peer DELL excluded from valuation comps: market cap outside range",
    ],
    ["operating KPI reason code", "operating-kpi-unverified:asts-satellites-launched"],
    ["registry unconfigured", "operating-kpi-registry-unconfigured"],
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
});
