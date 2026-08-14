import { describe, expect, test } from "bun:test";
import { depositoryIssuerSic } from "../src/sources/extended-evidence/industry-classification";

function evidence(items: readonly Record<string, unknown>[]) {
  return { items, gaps: [] };
}

function secItem(sic: string) {
  return {
    category: "sec-edgar",
    title: "issuer fundamentals",
    summary: "",
    sourceIds: [],
    observedAt: "2026-08-14T00:00:00.000Z",
    metrics: { sic, revenue: 1 },
  };
}

describe("depository issuer classification", () => {
  test("classifies every depository form the same way", () => {
    // Major group 60 in full, plus the two deposit-funded forms numbered outside it.
    for (const sic of ["6021", "6022", "6029", "6035", "6036", "6099", "6120", "6712"]) {
      expect(depositoryIssuerSic(evidence([secItem(sic)]))).toBe(sic);
    }
  });

  test("leaves nondepository issuers out, including SIC 6199", () => {
    // MARA files as 6199: it funds itself in the capital markets, so enterprise value holds.
    for (const sic of ["6199", "6111", "6200", "6798", "3571", "7372"]) {
      expect(depositoryIssuerSic(evidence([secItem(sic)]))).toBeUndefined();
    }
  });

  test("reads the issuer's SIC only from the sec-edgar item", () => {
    const peerCarryingABankSic = {
      category: "valuation",
      title: "peer comps",
      summary: "",
      sourceIds: [],
      observedAt: "2026-08-14T00:00:00.000Z",
      metrics: { sic: "6022" },
    };

    expect(depositoryIssuerSic(evidence([peerCarryingABankSic, secItem("3571")]))).toBeUndefined();
  });

  test("rejects malformed SIC values instead of trusting the 60 prefix", () => {
    // "60", "60x" and "60000" all pass a bare startsWith("60"); classifying them as banks would
    // Suppress valid metrics for an issuer whose upstream data is malformed.
    for (const sic of ["", "60", "60x", "60000", "6O22", "  6022", "6022 ", "060222"]) {
      expect(depositoryIssuerSic(evidence([secItem(sic)]))).toBeUndefined();
    }
    expect(
      depositoryIssuerSic(evidence([{ category: "sec-edgar", metrics: { sic: 6022 } }])),
    ).toBeUndefined();
  });

  test("returns undefined when no SIC is on the evidence at all", () => {
    const noEvidence: unknown = undefined;
    expect(depositoryIssuerSic(noEvidence)).toBeUndefined();
    expect(depositoryIssuerSic(evidence([]))).toBeUndefined();
    expect(depositoryIssuerSic(evidence([{ category: "sec-edgar", metrics: {} }]))).toBeUndefined();
  });
});
