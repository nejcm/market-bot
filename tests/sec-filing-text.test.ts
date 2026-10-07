import { describe, expect, test } from "bun:test";
import { secFilingSectionPacket } from "../src/sources/sec-filing-text";

const MDNA = `ITEM 2. MANAGEMENT'S DISCUSSION ${"Revenue grew on stronger demand while margins held steady. ".repeat(8)}`;

function riskFactors(body: string): string {
  return `${MDNA} ITEM 1A. RISK FACTORS ${body} ITEM 2. UNREGISTERED SALES OF EQUITY SECURITIES None.`;
}

describe("short Risk Factors sections", () => {
  test("accepts a 10-Q no-material-changes disclosure in either order", () => {
    for (const body of [
      "Risk factors are described in Part I, Item 1A of our Annual Report on Form 10-K for fiscal 2025. There have been no material changes from those risk factors.",
      "There have been no material changes to the risk factors disclosed in our Annual Report on Form 10-K for the fiscal year ended 2025.",
    ]) {
      const result = secFilingSectionPacket(riskFactors(body), "10-Q");

      expect(result.packet).toContain(`[Risk Factors] ITEM 1A. RISK FACTORS ${body}`);
      expect(result.misses.map((miss) => miss.label)).toEqual(["Segments", "Notes"]);
    }
  });

  test("still rejects unrelated short sections, TOC lines, and short 10-K disclosures", () => {
    const unrelated = secFilingSectionPacket(
      riskFactors("Our business is subject to many risks described elsewhere in this report."),
      "10-Q",
    );
    const toc = secFilingSectionPacket(
      `ITEM 1A. RISK FACTORS 31 ITEM 2. UNREGISTERED SALES 31 ${MDNA}`,
      "10-Q",
    );
    const annual = secFilingSectionPacket(
      riskFactors(
        "There have been no material changes to the risk factors disclosed in our Annual Report on Form 10-K.",
      ).replace("ITEM 2. MANAGEMENT", "ITEM 7. MANAGEMENT"),
      "10-K",
    );

    for (const result of [unrelated, toc, annual]) {
      expect(result.packet).not.toContain("[Risk Factors]");
      expect(result.misses).toContainEqual(
        expect.objectContaining({ label: "Risk Factors", reason: "too-short" }),
      );
    }
  });

  test("leaves the packet undefined when no section is accepted", () => {
    expect(
      secFilingSectionPacket(
        "ITEM 1A. RISK FACTORS See the risks noted elsewhere in this quarterly report for detail.",
        "10-Q",
      ),
    ).toEqual({ packet: undefined, misses: [], sectionCount: 4 });
  });
});
