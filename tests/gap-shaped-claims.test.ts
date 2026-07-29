import { describe, expect, test } from "bun:test";
import { isGapShapedClaim } from "../src/research/gap-shaped-claims";

describe("isGapShapedClaim", () => {
  test.each([
    "No management evidence was provided",
    "Without audited segment data the margin bridge is incomplete",
    "FRED macro data was not available for this run",
    "Analyst coverage is unavailable",
    "The latest filing was not retrieved",
    "The earnings transcript could not be fetched",
    "Comparable estimates cannot be verified",
    "The series was not collected in this run",
  ])("recognizes evidence-absence prose: %s", (text) => {
    expect(isGapShapedClaim(text)).toBe(true);
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
    "Management issued no FY26 guidance, leaving consensus unanchored",
    "Segment data was not disclosed until the 2025 filing",
    "Peers trade without coverage from bulge-bracket banks",
  ])("does not classify ordinary finding prose: %s", (text) => {
    expect(isGapShapedClaim(text)).toBe(false);
  });
});
