import { describe, expect, test } from "bun:test";
import { buildWebCompanyProfileEvidence } from "../src/sources/extended-evidence/web-company-profile";
import type { Source } from "../src/domain/types";

const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
} as const;

const webSource: Source = {
  id: "web-aapl-12345678",
  title: "Apple company profile",
  fetchedAt: "2026-05-19T00:00:00.000Z",
  kind: "web",
  assetClass: "equity",
  symbol: "AAPL",
  provider: "exa",
};

function profilePayload(sourceId = webSource.id): string {
  const answer = { answer: "Apple sells devices and services.", sourceIds: [sourceId] };
  return JSON.stringify({
    companyName: "Apple Inc.",
    questions: {
      whatItDoes: answer,
      howItMakesMoney: answer,
      customers: answer,
      geography: answer,
      purchaseRecurrence: answer,
      pricingPower: answer,
      recessionCyclicality: answer,
    },
    recentMaterialEvents: [{ claim: "Apple expanded services disclosure.", sourceIds: [sourceId] }],
    factLedger: [{ claim: "Apple sells iPhone, Mac, and services.", sourceIds: [sourceId] }],
    openGaps: ["Customer concentration remains unclear from gathered web sources."],
  });
}

describe("buildWebCompanyProfileEvidence", () => {
  test("accepts cited web facts and emits an extended evidence item", () => {
    const result = buildWebCompanyProfileEvidence({
      command,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: profilePayload(),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact?.companyName).toBe("Apple Inc.");
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
    expect(result.extendedEvidence?.items).toEqual([
      expect.objectContaining({
        category: "web-company-profile",
        sourceIds: [webSource.id],
      }),
    ]);
  });

  test("rejects uncited facts and returns an empty profile with a gap", () => {
    const result = buildWebCompanyProfileEvidence({
      command,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: profilePayload("missing-source"),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.sourceIds).toEqual([]);
    expect(result.artifact?.factLedger).toEqual([]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "web-company-profile",
        cause: "validation-failed",
      }),
    ]);
    expect(result.extendedEvidence?.gaps).toEqual(result.sourceGaps);
  });

  test("malformed JSON becomes a validation gap", () => {
    const result = buildWebCompanyProfileEvidence({
      command,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: "not-json",
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.openGaps[0]).toContain("not valid JSON");
    expect(result.sourceGaps[0]).toMatchObject({ cause: "validation-failed" });
  });
});
