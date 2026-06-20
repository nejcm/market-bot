import { describe, expect, test } from "bun:test";
import {
  compactUnmappedSecFilingGaps,
  dedupeSourceGaps,
  fetchFailureSourceGap,
  isCoreEvidenceQualityGap,
  isExtendedEvidenceQualityGap,
  isRepeatFallbackGap,
  isUnmappedSecFilingGap,
  marketContextGap,
  sourceGap,
  sourceGapAnalyticsClass,
  sourceGapReportText,
} from "../src/domain/source-gaps";

describe("source gaps", () => {
  test("classifies missing credentials without reading message text", () => {
    const gap = sourceGap({
      source: "marketaux-news",
      message: "provider unavailable",
      cause: "missing-credential",
    });

    expect(sourceGapAnalyticsClass(gap)).toBe("missingCredential");
  });

  test("classifies fetch and circuit failures without reading message text", () => {
    const fetchGap = fetchFailureSourceGap("yahoo", "timeout");
    const circuitGap = fetchFailureSourceGap("yahoo", "rate limit exhausted", "circuit-open");
    const textOnlyCircuitGap = fetchFailureSourceGap("yahoo", "yahoo circuit open");

    expect(fetchGap.cause).toBe("fetch-failed");
    expect(circuitGap.cause).toBe("circuit-open");
    expect(textOnlyCircuitGap.cause).toBe("fetch-failed");
    expect(sourceGapAnalyticsClass(fetchGap)).toBe("fetchFailed");
    expect(sourceGapAnalyticsClass(circuitGap)).toBe("fetchFailed");
  });

  test("keeps repeat fallback as typed meaning while preserving report text", () => {
    const gap = sourceGap({
      source: "news-seen",
      message: "dedupe kept fallback",
      cause: "repeat-fallback",
    });

    expect(isRepeatFallbackGap(gap)).toBe(true);
    expect(sourceGapReportText(gap)).toBe("news-seen: dedupe kept fallback");
  });

  test("dedupes repeated source gaps by normalized report text", () => {
    const gap = sourceGap({
      source: "massive-news",
      message: "source request failed with status 403",
      cause: "fetch-failed",
    });

    expect(
      dedupeSourceGaps([
        gap,
        sourceGap({
          source: "massive-news",
          message: " source request failed   with status 403 ",
          cause: "fetch-failed",
        }),
      ]),
    ).toEqual([gap]);
  });

  test("identifies unmapped SEC filing gaps by source and message pattern", () => {
    const unmapped = sourceGap({
      source: "sec-alpha-search",
      message: "SEC filing 10-Q 2024-03-15 did not map to a ticker",
    });
    const nonSec = sourceGap({
      source: "yahoo",
      message: "SEC filing 10-Q 2024-03-15 did not map to a ticker",
    });
    const wrongMessage = sourceGap({
      source: "sec-alpha-search",
      message: "other error",
    });

    expect(isUnmappedSecFilingGap(unmapped)).toBe(true);
    expect(isUnmappedSecFilingGap(nonSec)).toBe(false);
    expect(isUnmappedSecFilingGap(wrongMessage)).toBe(false);
  });

  test("compactUnmappedSecFilingGaps: single occurrence passes through unchanged", () => {
    const gap = sourceGap({
      source: "sec-alpha-search",
      message: "SEC filing S-1 2024-01-01 did not map to a ticker",
    });
    const other = sourceGap({ source: "yahoo", message: "timeout" });
    const result = compactUnmappedSecFilingGaps([gap, other]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(gap);
    expect(result[1]).toEqual(other);
  });

  test("compactUnmappedSecFilingGaps: duplicate unmapped SEC gaps merged with count", () => {
    const gap = sourceGap({
      source: "sec-alpha-search",
      message: "SEC filing S-1 2024-01-01 did not map to a ticker",
    });
    const result = compactUnmappedSecFilingGaps([gap, gap, gap]);

    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe(
      "SEC filing S-1 2024-01-01 did not map to a ticker (3 filings)",
    );
  });

  test("compactUnmappedSecFilingGaps: non-SEC gaps and distinct SEC messages unaffected", () => {
    const sec1 = sourceGap({
      source: "sec-alpha-search",
      message: "SEC filing S-1 2024-01-01 did not map to a ticker",
    });
    const sec2 = sourceGap({
      source: "sec-alpha-search",
      message: "SEC filing 10-Q 2024-06-30 did not map to a ticker",
    });
    const other = sourceGap({ source: "yahoo", message: "timeout" });
    const result = compactUnmappedSecFilingGaps([sec1, sec2, other]);

    expect(result).toHaveLength(3);
    expect(result.map((g) => g.message)).toEqual([
      "SEC filing S-1 2024-01-01 did not map to a ticker",
      "SEC filing 10-Q 2024-06-30 did not map to a ticker",
      "timeout",
    ]);
  });

  test("separates Market Context and Extended Evidence quality impact", () => {
    const raw = sourceGap({ source: "fred-macro", message: "missing" });
    const marketGap = marketContextGap(raw);
    const extendedGap = sourceGap({
      source: "fred-macro",
      message: "missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });

    expect(isCoreEvidenceQualityGap(marketGap)).toBe(false);
    expect(isExtendedEvidenceQualityGap(marketGap)).toBe(false);
    expect(isExtendedEvidenceQualityGap(extendedGap)).toBe(true);
  });
});
