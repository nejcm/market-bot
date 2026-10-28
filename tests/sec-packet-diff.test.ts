import { describe, expect, test } from "bun:test";
import { diffSlots, latestContextEnd, packetSlots } from "../scripts/sec-packet-diff";

describe("sec packet diff", () => {
  test("splits a section packet into its labelled slots", () => {
    expect(
      packetSlots("[Business] We make chips.\n\n[MD&A] Revenue grew [Segments] inline"),
    ).toEqual({ Business: "We make chips.", "MD&A": "Revenue grew [Segments] inline" });
    expect(packetSlots(undefined)).toEqual({});
  });

  test("uses the latest context end date as the period end", () => {
    expect(
      latestContextEnd(
        "<xbrli:endDate>2025-06-30</xbrli:endDate><xbrli:endDate>2025-12-31</xbrli:endDate>",
      ),
    ).toBe("2025-12-31");
    expect(latestContextEnd("<html></html>")).toBeUndefined();
  });

  test("counts changed filings per slot, including slots absent on one side", () => {
    const report = diffSlots(
      { a: { cachedDate: "2026-01-01", form: "10-K", slots: { Notes: "old", Business: "same" } } },
      {
        a: { cachedDate: "2026-01-01", form: "10-K", slots: { Notes: "new", Business: "same" } },
        b: { cachedDate: "2026-01-02", form: "10-Q", slots: { Segments: "added" } },
      },
    );
    expect(report).toContain("Notes: 1/2 filings changed\n");
    expect(report).toContain("Segments: 1/2 filings changed (slot absent at base)\n");
    expect(report).toContain("- (absent)");
    expect(report).not.toContain("Business:");
    expect(diffSlots({}, {})).toBe("No slot changes across 0 filings.\n");
  });
});
