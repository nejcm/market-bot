import { describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { normalizeCanonicalSourceGaps } from "../src/research/source-gap-normalization";
import { collectedSources } from "./support/fixtures";

describe("source gap normalization", () => {
  test("dedupes top-level, extended evidence, and market context gaps", () => {
    const first = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const duplicate = sourceGap({
      source: "sec-edgar",
      message: " Missing SEC   company facts: grossProfit ",
      cause: "validation-failed",
      evidenceQualityImpact: "core-cap",
    });
    const distinct = sourceGap({
      source: "sec-edgar",
      message: "Missing comparable SEC company facts for YoY deltas: capex",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const marketGap = sourceGap({
      source: "fred-market-context",
      message: "missing DGS10",
      capability: "market-context",
    });

    const normalized = normalizeCanonicalSourceGaps(
      collectedSources({
        sourceGaps: [first, duplicate, distinct],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [first, duplicate, distinct],
        },
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [marketGap, { ...marketGap, message: " missing   DGS10 " }],
        },
      }),
    );

    expect(normalized.sourceGaps).toEqual([first, distinct]);
    expect(normalized.extendedEvidence?.gaps).toEqual([first, distinct]);
    expect(normalized.marketContext?.gaps).toEqual([marketGap]);
  });

  test("consolidates nested SEC company-fact gaps at the canonical boundary", () => {
    const subset = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const superset = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit, capex",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });

    const normalized = normalizeCanonicalSourceGaps(
      collectedSources({
        sourceGaps: [subset, superset],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [subset, superset],
        },
      }),
    );

    const consolidated = { ...superset };
    expect(normalized.sourceGaps).toEqual([consolidated]);
    expect(normalized.extendedEvidence?.gaps).toEqual([consolidated]);
  });
});
