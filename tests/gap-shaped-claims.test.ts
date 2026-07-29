import { describe, expect, test } from "bun:test";
import {
  isGapShapedClaimForAuditWarning,
  isGapShapedClaimForRelocation,
} from "../src/research/gap-shaped-claims";

describe("isGapShapedClaimForRelocation", () => {
  test.each([
    "No management evidence was provided",
    "Without audited segment data the margin bridge is incomplete",
    "FRED macro data was not available for this run",
    "Analyst coverage is unavailable",
    "The latest filing was not retrieved",
    "The earnings transcript could not be fetched",
    "Comparable estimates cannot be verified",
    "The series was not collected in this run",
    "No guidance was provided for FY26",
    "No forward guidance was disclosed by management",
    "No analyst coverage was available for this name",
    "No peer coverage exists in the collected sources",
    "Without guidance we cannot model FY26",
    "Management issued no FY26 guidance, leaving consensus unanchored",
    "Peers trade without coverage from bulge-bracket banks",
  ])("recognizes evidence-absence prose: %s", (text) => {
    expect(isGapShapedClaimForRelocation(text)).toBe(true);
  });

  test("preserves the disclosed-data boundary", () => {
    expect(isGapShapedClaimForRelocation("Segment data was not disclosed")).toBe(true);
    expect(
      isGapShapedClaimForRelocation("Segment data was not disclosed until the 2025 filing"),
    ).toBe(false);
  });

  test.each([
    "Revenue data shows no growth in the segment",
    "Management guidance points to stable margins",
    "The filing describes a new product launch",
    "Coverage expanded to two additional regions",
    "The transcript highlights improving demand",
    "Estimates imply slower growth next year",
    "The data indicates lower customer churn",
    "No growth was visible in the mature segment",
    "The company has no data center in Europe",
    "NBIS cannot scale without data center capacity in place",
    "The company sees no headwind in the data center segment",
  ])("does not classify ordinary finding prose: %s", (text) => {
    expect(isGapShapedClaimForRelocation(text)).toBe(false);
  });
});

describe("isGapShapedClaimForAuditWarning", () => {
  test.each([
    "No management evidence was provided",
    "FRED macro data was not available for this run",
    "Analyst coverage is unavailable",
    "Segment data was not disclosed",
  ])("recognizes audit-worthy evidence-absence prose: %s", (text) => {
    expect(isGapShapedClaimForAuditWarning(text)).toBe(true);
  });

  test.each([
    "Management issued no FY26 guidance, leaving consensus unanchored",
    "Peers trade without coverage from bulge-bracket banks",
    "Segment data was not disclosed until the 2025 filing",
  ])("does not classify noisy audit-warning prose: %s", (text) => {
    expect(isGapShapedClaimForAuditWarning(text)).toBe(false);
  });
});

describe("shared data noun exclusions", () => {
  test.each([
    "The company has no data centers in Europe",
    "Rivals operate without data centres in the region",
    "The model uses no data points from the prior year",
    "There are no data sets covering the segment",
    "no data-center footprint in Europe",
    "no data-centre capacity in the region",
    "no data-points from the prior year",
  ])("keeps business data nouns out of both predicates: %s", (text) => {
    expect(isGapShapedClaimForRelocation(text)).toBe(false);
    expect(isGapShapedClaimForAuditWarning(text)).toBe(false);
  });
});
