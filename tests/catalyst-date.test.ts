import { describe, expect, test } from "bun:test";
import { extractCatalystDate } from "../src/research/catalyst-date";

describe("extractCatalystDate", () => {
  test("parses ISO dates", () => {
    expect(extractCatalystDate("PDUFA target date 2026-11-01 for the filing.")).toBe("2026-11-01");
  });

  test("parses abbreviated month-name dates", () => {
    expect(extractCatalystDate("Phase 3 readout expected Nov 1 2026.")).toBe("2026-11-01");
  });

  test("parses full month-name dates with comma", () => {
    expect(extractCatalystDate("Deal closes November 1, 2026 pending review.")).toBe("2026-11-01");
  });

  test("parses ordinal day suffixes", () => {
    expect(extractCatalystDate("Guidance on March 3rd 2027.")).toBe("2027-03-03");
  });

  test("maps calendar quarters to quarter-end dates", () => {
    expect(extractCatalystDate("Approval anticipated Q3 2026.")).toBe("2026-09-30");
    expect(extractCatalystDate("Launch slated for Q4 2026.")).toBe("2026-12-31");
    expect(extractCatalystDate("Trial completes Q1 2027.")).toBe("2027-03-31");
    expect(extractCatalystDate("Filing due Q2 2027.")).toBe("2027-06-30");
  });

  test("prefers ISO over other forms when both appear", () => {
    expect(extractCatalystDate("Readout Nov 1 2026, confirmed 2026-11-05.")).toBe("2026-11-05");
  });

  test("rejects impossible calendar dates", () => {
    expect(extractCatalystDate("Nonsense 2026-02-30 marker.")).toBeUndefined();
    expect(extractCatalystDate("February 30, 2026 is not real.")).toBeUndefined();
  });

  test("returns undefined for undated prose", () => {
    expect(extractCatalystDate("Ongoing regulatory review with no set date.")).toBeUndefined();
  });
});
