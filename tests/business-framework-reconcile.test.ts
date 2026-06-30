import { describe, expect, test } from "bun:test";
import { reconcileBusinessFramework } from "../src/sources/extended-evidence/business-framework-reconcile";
import {
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkGapCode,
  type BusinessFrameworkGapValue,
  type BusinessFrameworkSection,
} from "../src/sources/extended-evidence/business-framework";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileAnswer,
} from "../src/sources/extended-evidence/web-subject-profile";

function answer(text: string, sourceIds: readonly string[] = ["web-1"]): WebSubjectProfileAnswer {
  return { answer: text, sourceIds: [...sourceIds] };
}

function gap(code: BusinessFrameworkGapCode) {
  return QUALITATIVE_GAPS.find((candidate) => candidate.code === code)!;
}

function companyProfile(
  overrides: Partial<
    Record<
      | "howItMakesMoney"
      | "customers"
      | "purchaseRecurrence"
      | "managementTrackRecord"
      | "capitalAllocation"
      | "companyKpis"
      | "riskFactors",
      WebSubjectProfileAnswer
    >
  > = {},
): WebSubjectProfileArtifact {
  return {
    version: 3,
    generatedAt: "2026-06-28T00:00:00.000Z",
    subjectKind: "company",
    subjectId: "AAPL",
    symbol: "AAPL",
    subjectSummary: answer("Apple makes consumer electronics."),
    questions: {
      whatItDoes: answer("Consumer electronics"),
      howItMakesMoney: overrides.howItMakesMoney ?? answer("Hardware and services", ["segment"]),
      customers: overrides.customers ?? answer("Consumers and enterprises", ["customers"]),
      geography: answer("Worldwide"),
      purchaseRecurrence:
        overrides.purchaseRecurrence ?? answer("Upgrades and subscriptions", ["recurrence"]),
      pricingPower: answer("Premium pricing"),
      recessionCyclicality: answer("Moderate"),
      managementTrackRecord:
        overrides.managementTrackRecord ?? answer("Management execution record", ["management"]),
      capitalAllocation:
        overrides.capitalAllocation ?? answer("Repurchases and dividends", ["allocation"]),
      companyKpis: overrides.companyKpis ?? answer("Installed base and services", ["kpis"]),
      riskFactors: overrides.riskFactors ?? answer("Supply chain and regulation", ["risks"]),
    },
    recentMaterialEvents: [],
    factLedger: [],
    openGaps: [],
    sourceIds: ["web-1"],
  };
}

function section(
  name: BusinessFrameworkSection["name"],
  gaps: readonly BusinessFrameworkGapValue[] = [],
): BusinessFrameworkSection {
  return {
    name,
    posture: "criteria-supported",
    summary: name,
    metrics: [],
    sourceIds: ["sec"],
    gaps,
  };
}

function framework(
  gaps: readonly BusinessFrameworkGapValue[] = [...QUALITATIVE_GAPS],
  version: 1 | 2 = 2,
): BusinessFrameworkArtifact {
  return {
    version,
    generatedAt: "2026-06-28T00:00:00.000Z",
    symbol: "AAPL",
    phase: "capital-return",
    sections: [
      section("Business", gaps),
      section("Phase"),
      section("Moat"),
      section("Growth"),
      section("Management"),
      section("Risk"),
      section("Valuation"),
    ],
    sourceIds: ["sec"],
    gaps,
  };
}

describe("reconcileBusinessFramework", () => {
  test("resolves each cited profile field independently and leaves analyst consensus", () => {
    const result = reconcileBusinessFramework(framework(), companyProfile());

    expect(result.artifact.gaps).toEqual([gap("analyst-consensus")]);
    expect(result.artifact.reconciliation?.resolvedGaps).toEqual([
      "business-description",
      "capital-allocation",
      "company-kpis",
      "customer-concentration",
      "cyclicality",
      "geographic-mix",
      "management-track-record",
      "pricing-power",
      "purchase-recurrence",
      "risk-factors",
      "segment-mix",
    ]);
    expect(result.artifact.reconciliation?.profileSourceIds).toEqual([
      "allocation",
      "customers",
      "kpis",
      "management",
      "recurrence",
      "risks",
      "segment",
      "web-1",
    ]);
    expect(result.sourceGap?.message).toContain("Analyst consensus");
  });

  test("an uncited answer leaves only its matching gap unresolved", () => {
    const profile = companyProfile({
      customers: { answer: "Consumers", sourceIds: [] },
      companyKpis: { answer: "", sourceIds: ["kpis"] },
    });
    const result = reconcileBusinessFramework(framework(), profile);

    expect(result.artifact.gaps).toEqual([
      gap("customer-concentration"),
      gap("company-kpis"),
      gap("analyst-consensus"),
    ]);
    expect(result.artifact.reconciliation?.profileSourceIds).not.toContain("customers");
    expect(result.artifact.reconciliation?.profileSourceIds).not.toContain("kpis");
  });

  test("a cited non-answer does not clear its Business Framework gap", () => {
    const profile = companyProfile({
      howItMakesMoney: { answer: "Not disclosed in cited filings.", sourceIds: ["segment"] },
    });
    const result = reconcileBusinessFramework(framework(), profile);

    expect(result.artifact.gaps).toContain(gap("segment-mix"));
    expect(result.artifact.reconciliation?.resolvedGaps).not.toContain("segment-mix");
    expect(result.artifact.reconciliation?.profileSourceIds).not.toContain("segment");
    // Substantive answers still clear their own gaps.
    expect(result.artifact.reconciliation?.resolvedGaps).toContain("customer-concentration");
  });

  test("removes a resolved code from every section", () => {
    const gaps = [gap("segment-mix"), gap("analyst-consensus")];
    const result = reconcileBusinessFramework(framework(gaps), companyProfile());

    expect(result.artifact.sections[0]?.gaps).toEqual([gap("analyst-consensus")]);
    expect(result.artifact.gaps).toEqual([gap("analyst-consensus")]);
  });

  test("drops source gap when every present gap is resolved", () => {
    const result = reconcileBusinessFramework(
      framework([gap("segment-mix"), gap("risk-factors")]),
      companyProfile(),
    );

    expect(result.artifact.gaps).toEqual([]);
    expect(result.sourceGap).toBeUndefined();
  });

  test("does not reconcile legacy framework or company profile versions", () => {
    const legacyFramework = framework(["legacy qualitative gap"], 1);
    const currentProfile = companyProfile();
    expect(reconcileBusinessFramework(legacyFramework, currentProfile).artifact).toBe(
      legacyFramework,
    );

    const legacyProfile = { ...currentProfile, version: 2 as const };
    const currentFramework = framework();
    expect(reconcileBusinessFramework(currentFramework, legacyProfile).artifact).toBe(
      currentFramework,
    );
  });

  test("does not reconcile non-company profiles", () => {
    const profile: WebSubjectProfileArtifact = {
      version: 3,
      generatedAt: "2026-06-28T00:00:00.000Z",
      subjectKind: "crypto-asset",
      subjectId: "BTC",
      symbol: "BTC",
      subjectSummary: answer("Bitcoin"),
      questions: {
        whatItDoes: answer("Digital asset"),
        valueAccrual: answer("Scarcity"),
        supplyIssuance: answer("Fixed"),
        usageAdoption: answer("Global"),
        governanceBuilders: answer("Open source"),
        competitionMoat: answer("Network effects"),
        keyRisks: answer("Regulation"),
      },
      recentMaterialEvents: [],
      factLedger: [],
      openGaps: [],
      sourceIds: ["web-1"],
    };
    const original = framework();

    expect(reconcileBusinessFramework(original, profile).artifact).toBe(original);
  });
});
