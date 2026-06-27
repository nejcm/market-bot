import { describe, expect, test } from "bun:test";
import { reconcileBusinessFramework } from "../src/sources/extended-evidence/business-framework-reconcile";
import {
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkSection,
} from "../src/sources/extended-evidence/business-framework";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileAnswer,
} from "../src/sources/extended-evidence/web-subject-profile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function answer(text: string, sourceIds: readonly string[] = ["web-1"]): WebSubjectProfileAnswer {
  return { answer: text, sourceIds: [...sourceIds] };
}

const EMPTY_ANSWER: WebSubjectProfileAnswer = { answer: "", sourceIds: [] };

function companyProfile(
  overrides: Partial<
    Record<
      | "whatItDoes"
      | "howItMakesMoney"
      | "customers"
      | "geography"
      | "purchaseRecurrence"
      | "pricingPower"
      | "recessionCyclicality",
      WebSubjectProfileAnswer
    >
  > = {},
): WebSubjectProfileArtifact {
  return {
    version: 2,
    generatedAt: "2026-06-28T00:00:00.000Z",
    subjectKind: "company",
    subjectId: "AAPL",
    symbol: "AAPL",
    subjectSummary: answer("Apple Inc. designs and sells consumer electronics."),
    questions: {
      whatItDoes: answer("Apple designs consumer electronics"),
      howItMakesMoney: overrides.howItMakesMoney ?? answer("Hardware sales + services"),
      customers: overrides.customers ?? answer("Global consumers and enterprises"),
      geography: answer("Worldwide"),
      purchaseRecurrence:
        overrides.purchaseRecurrence ?? answer("High — upgrade cycles and subscriptions"),
      pricingPower: answer("Premium brand pricing"),
      recessionCyclicality: answer("Moderate — discretionary but sticky"),
    },
    recentMaterialEvents: [],
    factLedger: [{ claim: "Revenue grew 6% YoY", sourceIds: ["web-1"] }],
    openGaps: [],
    sourceIds: ["web-1", "web-2"],
  };
}

function section(
  name: BusinessFrameworkSection["name"],
  gaps: readonly string[] = [],
  posture: BusinessFrameworkSection["posture"] = "criteria-supported",
): BusinessFrameworkSection {
  return {
    name,
    posture,
    summary: `${name} ${posture}`,
    metrics: [],
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    gaps: [...gaps],
  };
}

function framework(overrides: Partial<BusinessFrameworkArtifact> = {}): BusinessFrameworkArtifact {
  const sections = overrides.sections ?? [
    section("Business", [QUALITATIVE_GAPS[0]]),
    section("Phase"),
    section("Moat", [QUALITATIVE_GAPS[0]]),
    section("Growth", [QUALITATIVE_GAPS[2]]),
    section("Management", [QUALITATIVE_GAPS[1]], "insufficient-data"),
    section("Risk", [QUALITATIVE_GAPS[2]]),
    section("Valuation"),
  ];
  return {
    version: 1,
    generatedAt: "2026-06-28T00:00:00.000Z",
    symbol: "AAPL",
    phase: "capital-return",
    sections,
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    gaps: overrides.gaps ?? [...new Set(sections.flatMap((s) => s.gaps))],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("reconcileBusinessFramework", () => {
  test("clears GAP[0] when all three profile questions are cited", () => {
    const result = reconcileBusinessFramework(framework(), companyProfile());

    // GAP[0] removed from artifact-level gaps
    expect(result.artifact.gaps).not.toContain(QUALITATIVE_GAPS[0]);
    // GAP[1] and GAP[2] remain
    expect(result.artifact.gaps).toContain(QUALITATIVE_GAPS[1]);
    expect(result.artifact.gaps).toContain(QUALITATIVE_GAPS[2]);

    // Business and Moat sections no longer carry GAP[0]
    const business = result.artifact.sections.find((s) => s.name === "Business")!;
    const moat = result.artifact.sections.find((s) => s.name === "Moat")!;
    expect(business.gaps).not.toContain(QUALITATIVE_GAPS[0]);
    expect(moat.gaps).not.toContain(QUALITATIVE_GAPS[0]);

    // Growth still carries GAP[2]
    const growth = result.artifact.sections.find((s) => s.name === "Growth")!;
    expect(growth.gaps).toContain(QUALITATIVE_GAPS[2]);

    // Reconciliation marker present
    expect(result.artifact.reconciliation).toBeDefined();
    expect(result.artifact.reconciliation!.resolvedGaps).toEqual([QUALITATIVE_GAPS[0]]);
    expect(result.artifact.reconciliation!.profileSourceIds.length).toBeGreaterThan(0);

    // Source gap regenerated from remaining gaps
    expect(result.sourceGap).toBeDefined();
    expect(result.sourceGap!.message).not.toContain("Segment mix");
  });

  test("postures and phase are byte-identical before and after", () => {
    const original = framework();
    const result = reconcileBusinessFramework(original, companyProfile());

    expect(result.artifact.phase).toBe(original.phase);
    for (const reconciledSection of result.artifact.sections) {
      const orig = original.sections.find((s) => s.name === reconciledSection.name)!;
      expect(reconciledSection.posture).toBe(orig.posture);
    }
  });

  test("leaves gaps untouched when howItMakesMoney is empty", () => {
    const profile = companyProfile({ howItMakesMoney: EMPTY_ANSWER });
    const original = framework();
    const result = reconcileBusinessFramework(original, profile);

    // Reference equality — unchanged
    expect(result.artifact).toBe(original);
    expect(result.artifact.gaps).toContain(QUALITATIVE_GAPS[0]);
  });

  test("leaves gaps untouched when customers has no sourceIds", () => {
    const profile = companyProfile({
      customers: { answer: "Global consumers", sourceIds: [] },
    });
    const original = framework();
    const result = reconcileBusinessFramework(original, profile);

    expect(result.artifact).toBe(original);
  });

  test("leaves gaps untouched when purchaseRecurrence is empty", () => {
    const profile = companyProfile({ purchaseRecurrence: EMPTY_ANSWER });
    const original = framework();
    const result = reconcileBusinessFramework(original, profile);

    expect(result.artifact).toBe(original);
  });

  test("drops sourceGap entirely when no qualitative gaps remain", () => {
    // Framework with only GAP[0]
    const onlyGap0 = framework({
      sections: [
        section("Business", [QUALITATIVE_GAPS[0]]),
        section("Phase"),
        section("Moat", [QUALITATIVE_GAPS[0]]),
        section("Growth"),
        section("Management", [], "insufficient-data"),
        section("Risk"),
        section("Valuation"),
      ],
      gaps: [QUALITATIVE_GAPS[0]],
    });
    const result = reconcileBusinessFramework(onlyGap0, companyProfile());

    expect(result.artifact.gaps).toEqual([]);
    expect(result.sourceGap).toBeUndefined();
  });

  test("no-op for crypto profiles (no company questions)", () => {
    const cryptoProfile: WebSubjectProfileArtifact = {
      version: 2,
      generatedAt: "2026-06-28T00:00:00.000Z",
      subjectKind: "crypto-asset",
      subjectId: "BTC",
      symbol: "BTC",
      subjectSummary: answer("Bitcoin is a cryptocurrency."),
      questions: {
        whatItDoes: answer("Digital currency"),
        valueAccrual: answer("Scarcity"),
        supplyIssuance: answer("Fixed supply"),
        usageAdoption: answer("Growing"),
        governanceBuilders: answer("Decentralized"),
        competitionMoat: answer("Network effects"),
        keyRisks: answer("Regulatory"),
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: "BTC halving completed", sourceIds: ["web-1"] }],
      openGaps: [],
      sourceIds: ["web-1"],
    };
    const original = framework();
    const result = reconcileBusinessFramework(original, cryptoProfile);

    expect(result.artifact).toBe(original);
  });

  test("no-op when GAP[0] is already absent from the framework", () => {
    const noGap0 = framework({
      sections: [
        section("Business"),
        section("Phase"),
        section("Moat"),
        section("Growth", [QUALITATIVE_GAPS[2]]),
        section("Management", [QUALITATIVE_GAPS[1]], "insufficient-data"),
        section("Risk", [QUALITATIVE_GAPS[2]]),
        section("Valuation"),
      ],
      gaps: [QUALITATIVE_GAPS[1], QUALITATIVE_GAPS[2]],
    });
    const result = reconcileBusinessFramework(noGap0, companyProfile());

    expect(result.artifact).toBe(noGap0);
  });

  test("profileSourceIds collects union of cited sources from the three questions", () => {
    const profile = companyProfile({
      howItMakesMoney: answer("Hardware sales", ["web-1", "web-3"]),
      customers: answer("Consumers", ["web-2"]),
      purchaseRecurrence: answer("Upgrades", ["web-1", "web-2"]),
    });
    const result = reconcileBusinessFramework(framework(), profile);

    expect(result.artifact.reconciliation!.profileSourceIds).toEqual(["web-1", "web-2", "web-3"]);
  });
});
