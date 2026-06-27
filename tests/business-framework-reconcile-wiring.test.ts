import { describe, expect, test } from "bun:test";
import { reconcileBusinessFrameworkEvidence } from "../src/research/orchestrator";
import {
  frameworkGap,
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkSection,
} from "../src/sources/extended-evidence/business-framework";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileAnswer,
} from "../src/sources/extended-evidence/web-subject-profile";
import type { ExtendedEvidence, SourceGap } from "../src/domain/types";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";

function answer(text: string): WebSubjectProfileAnswer {
  return { answer: text, sourceIds: ["web-1"] };
}

type CompanyProfile = Extract<WebSubjectProfileArtifact, { subjectKind: "company" }>;

function profile(): CompanyProfile {
  return {
    version: 2,
    generatedAt: "2026-06-28T00:00:00.000Z",
    subjectKind: "company",
    subjectId: "AAPL",
    symbol: "AAPL",
    subjectSummary: answer("Apple makes devices"),
    questions: {
      whatItDoes: answer("Electronics"),
      howItMakesMoney: answer("Hardware + services"),
      customers: answer("Consumers"),
      geography: answer("Worldwide"),
      purchaseRecurrence: answer("High"),
      pricingPower: answer("Premium"),
      recessionCyclicality: answer("Moderate"),
    },
    recentMaterialEvents: [],
    factLedger: [{ claim: "Revenue grew", sourceIds: ["web-1"] }],
    openGaps: [],
    sourceIds: ["web-1"],
  };
}

function section(
  name: BusinessFrameworkSection["name"],
  gaps: readonly string[] = [],
): BusinessFrameworkSection {
  return {
    name,
    posture: "criteria-supported",
    summary: `${name}`,
    metrics: [],
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    gaps: [...gaps],
  };
}

function framework(sections: readonly BusinessFrameworkSection[]): BusinessFrameworkArtifact {
  return {
    version: 1,
    generatedAt: "2026-06-28T00:00:00.000Z",
    symbol: "AAPL",
    phase: "capital-return",
    sections,
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    gaps: [...new Set(sections.flatMap((s) => s.gaps))],
  };
}

function bundle(art: BusinessFrameworkArtifact, gap: SourceGap) {
  const extendedEvidence: ExtendedEvidence = {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [],
    // The collector writes the framework gap into extendedEvidence.gaps too.
    gaps: [gap],
  };
  return collectedSourceBundle({
    businessFramework: art,
    webSubjectProfile: profile(),
    extendedEvidence,
    sourceGaps: [gap],
  });
}

describe("reconcileBusinessFrameworkEvidence wiring", () => {
  test("regenerated gap replaces stale gap in BOTH sourceGaps and extendedEvidence.gaps", () => {
    const art = framework([
      section("Business", [QUALITATIVE_GAPS[0]]),
      section("Moat", [QUALITATIVE_GAPS[0]]),
      section("Growth", [QUALITATIVE_GAPS[2]]),
    ]);
    const staleGap = frameworkGap("AAPL", art.gaps);
    const collected = bundle(art, staleGap);

    const result = reconcileBusinessFrameworkEvidence(collected);

    // Reconciled artifact swapped on.
    expect(result.businessFramework!.reconciliation).toBeDefined();
    expect(result.businessFramework!.gaps).not.toContain(QUALITATIVE_GAPS[0]);

    // SourceGaps: stale gap gone, regenerated gap present without GAP[0] text.
    const sgFramework = result.sourceGaps.filter((g) => g.source === "business-framework");
    expect(sgFramework).toHaveLength(1);
    expect(sgFramework[0]!.message).not.toContain("Segment mix");
    expect(sgFramework[0]!.message).toContain("Analyst estimates");

    // ExtendedEvidence gaps mirror sourceGaps: stale gap gone, regenerated present.
    const eeFramework = result.extendedEvidence!.gaps.filter(
      (g) => g.source === "business-framework",
    );
    expect(eeFramework).toHaveLength(1);
    expect(eeFramework[0]!.message).not.toContain("Segment mix");
    expect(eeFramework[0]).toEqual(sgFramework[0]!);
  });

  test("gap dropped from BOTH collections when no qualitative gaps remain", () => {
    const art = framework([
      section("Business", [QUALITATIVE_GAPS[0]]),
      section("Moat", [QUALITATIVE_GAPS[0]]),
    ]);
    const staleGap = frameworkGap("AAPL", art.gaps);
    const collected = bundle(art, staleGap);

    const result = reconcileBusinessFrameworkEvidence(collected);

    expect(result.sourceGaps.filter((g) => g.source === "business-framework")).toHaveLength(0);
    expect(
      result.extendedEvidence!.gaps.filter((g) => g.source === "business-framework"),
    ).toHaveLength(0);
  });

  test("no-op leaves collectedSources reference unchanged", () => {
    // Empty customers answer means GAP[0] cannot resolve, so reconciliation is a no-op.
    const base = profile();
    const noResolveProfile: CompanyProfile = {
      ...base,
      questions: {
        whatItDoes: answer("Electronics"),
        howItMakesMoney: answer("Hardware + services"),
        customers: { answer: "", sourceIds: [] },
        geography: answer("Worldwide"),
        purchaseRecurrence: answer("High"),
        pricingPower: answer("Premium"),
        recessionCyclicality: answer("Moderate"),
      },
    };
    const art = framework([section("Business", [QUALITATIVE_GAPS[0]])]);
    const staleGap = frameworkGap("AAPL", art.gaps);
    const collected = collectedSourceBundle({
      businessFramework: art,
      webSubjectProfile: noResolveProfile,
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: [staleGap],
      },
      sourceGaps: [staleGap],
    });

    expect(reconcileBusinessFrameworkEvidence(collected)).toBe(collected);
  });

  test("preserves non-framework gaps in both collections", () => {
    const art = framework([
      section("Business", [QUALITATIVE_GAPS[0]]),
      section("Growth", [QUALITATIVE_GAPS[2]]),
    ]);
    const staleGap = frameworkGap("AAPL", art.gaps);
    const otherGap: SourceGap = {
      source: "web-subject-profile",
      message: "profile freshness gap",
      capability: "extended-evidence",
    };
    const collected = collectedSourceBundle({
      businessFramework: art,
      webSubjectProfile: profile(),
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: [staleGap, otherGap],
      },
      sourceGaps: [staleGap, otherGap],
    });

    const result = reconcileBusinessFrameworkEvidence(collected);

    expect(result.sourceGaps).toContainEqual(otherGap);
    expect(result.extendedEvidence!.gaps).toContainEqual(otherGap);
  });
});
