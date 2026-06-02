import { describe, expect, test } from "bun:test";
import {
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
    expect(sourceGapAnalyticsClass(fetchFailureSourceGap("yahoo", "timeout"))).toBe("fetchFailed");
    expect(sourceGapAnalyticsClass(fetchFailureSourceGap("yahoo", "yahoo circuit open"))).toBe(
      "fetchFailed",
    );
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
