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
    const overlapping = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit, capex",
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
        sourceGaps: [first, duplicate, overlapping],
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [first, duplicate, overlapping],
        },
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [marketGap, { ...marketGap, message: " missing   DGS10 " }],
        },
      }),
    );

    expect(normalized.sourceGaps).toEqual([first, overlapping]);
    expect(normalized.extendedEvidence?.gaps).toEqual([first, overlapping]);
    expect(normalized.marketContext?.gaps).toEqual([marketGap]);
  });
});
