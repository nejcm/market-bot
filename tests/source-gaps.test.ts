import { describe, expect, test } from "bun:test";
import {
  dedupeSourceGaps,
  fetchFailureSourceGap,
  isCoreEvidenceQualityGap,
  isExtendedEvidenceQualityGap,
  isRepeatFallbackGap,
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
