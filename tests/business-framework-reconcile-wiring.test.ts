import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, SourceGap } from "../src/domain/types";
import type { WebSubjectProfileAnswer, WebSubjectProfileArtifact } from "../src/web-evidence";
// Internal seam: reconciliation wiring is not part of the package manifest.
import { reconcileBusinessFrameworkEvidence } from "../src/web-evidence/web-evidence-phase";
import {
  frameworkGaps,
  QUALITATIVE_GAPS,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkGapCode,
  type BusinessFrameworkGapValue,
  type BusinessFrameworkSection,
} from "../src/sources/extended-evidence/business-framework";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";

function answer(text: string): WebSubjectProfileAnswer {
  return { answer: text, sourceIds: ["web-1"] };
}

function gap(code: BusinessFrameworkGapCode) {
  return QUALITATIVE_GAPS.find((candidate) => candidate.code === code)!;
}

function profile(customers = answer("Consumers")): WebSubjectProfileArtifact {
  return {
    version: 3,
    generatedAt: "2026-06-28T00:00:00.000Z",
    subjectKind: "company",
    subjectId: "AAPL",
    symbol: "AAPL",
    subjectSummary: answer("Apple makes devices"),
    questions: {
      whatItDoes: answer("Electronics"),
      howItMakesMoney: answer("Hardware and services"),
      customers,
      geography: answer("Worldwide"),
      purchaseRecurrence: answer("Upgrades"),
      pricingPower: answer("Premium"),
      recessionCyclicality: answer("Moderate"),
      managementTrackRecord: answer("Execution record"),
      capitalAllocation: answer("Repurchases"),
      companyKpis: answer("Installed base"),
      riskFactors: answer("Supply chain"),
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

function framework(gaps: readonly BusinessFrameworkGapValue[]): BusinessFrameworkArtifact {
  return {
    version: 2,
    generatedAt: "2026-06-28T00:00:00.000Z",
    symbol: "AAPL",
    phase: "capital-return",
    sections: [section("Business", gaps)],
    sourceIds: ["sec"],
    gaps,
  };
}

function bundle(
  artifact: BusinessFrameworkArtifact,
  staleGaps: readonly SourceGap[],
  webProfile = profile(),
) {
  const extendedEvidence: ExtendedEvidence = {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [],
    gaps: [...staleGaps],
  };
  return collectedSourceBundle({
    businessFramework: artifact,
    webSubjectProfile: webProfile,
    extendedEvidence,
    sourceGaps: [...staleGaps],
  });
}

describe("reconcileBusinessFrameworkEvidence wiring", () => {
  test("replaces the stale gap in source and extended evidence collections", () => {
    const artifact = framework([gap("segment-mix"), gap("analyst-consensus")]);
    const result = reconcileBusinessFrameworkEvidence(
      bundle(artifact, frameworkGaps("AAPL", artifact.gaps)),
    );

    expect(result.businessFramework?.gaps).toEqual([gap("analyst-consensus")]);
    const sourceGap = result.sourceGaps.filter((entry) => entry.source === "business-framework");
    const evidenceGap = result.extendedEvidence?.gaps.filter(
      (entry) => entry.source === "business-framework",
    );
    expect(sourceGap).toHaveLength(1);
    expect(sourceGap[0]?.message).toContain("Analyst consensus");
    expect(evidenceGap).toEqual(sourceGap);
  });

  test("removes the gap from both collections when all present codes resolve", () => {
    const artifact = framework([gap("segment-mix")]);
    const result = reconcileBusinessFrameworkEvidence(
      bundle(artifact, frameworkGaps("AAPL", artifact.gaps)),
    );

    expect(result.sourceGaps.filter((entry) => entry.source === "business-framework")).toEqual([]);
    expect(
      result.extendedEvidence?.gaps.filter((entry) => entry.source === "business-framework"),
    ).toEqual([]);
  });

  test("reconciles normally against a partial (salvaged) profile as long as sourceIds survived (B2.3)", () => {
    // A partially-accepted profile (e.g. Workstream B salvage: some facts/
    // Questions rejected but sourceIds non-empty) must not be treated as the
    // Profile.sourceIds.length === 0 skip case.
    const partialProfile: WebSubjectProfileArtifact = {
      ...profile(),
      recentMaterialEvents: [],
      factLedger: [],
      sourceIds: ["web-1"],
    };
    const artifact = framework([gap("segment-mix"), gap("analyst-consensus")]);
    const result = reconcileBusinessFrameworkEvidence(
      bundle(artifact, frameworkGaps("AAPL", artifact.gaps), partialProfile),
    );

    expect(result.businessFramework?.gaps).toEqual([gap("analyst-consensus")]);
  });

  test("returns the original collection when no present code resolves", () => {
    const artifact = framework([gap("customer-concentration")]);
    const staleGaps = frameworkGaps("AAPL", artifact.gaps);
    const collected = bundle(artifact, staleGaps, profile({ answer: "Consumers", sourceIds: [] }));

    expect(reconcileBusinessFrameworkEvidence(collected)).toBe(collected);
  });

  test("preserves unrelated gaps", () => {
    const artifact = framework([
      gap("segment-mix"),
      gap("customer-concentration"),
      gap("analyst-consensus"),
    ]);
    const staleGaps = frameworkGaps("AAPL", artifact.gaps);
    const otherGap: SourceGap = {
      source: "web-subject-profile",
      message: "profile freshness gap",
      capability: "extended-evidence",
    };
    const collected = collectedSourceBundle({
      ...bundle(artifact, staleGaps, profile({ answer: "Consumers", sourceIds: [] })),
      sourceGaps: [...staleGaps, otherGap],
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: [...staleGaps, otherGap],
      },
    });

    const result = reconcileBusinessFrameworkEvidence(collected);
    expect(result.sourceGaps.filter((entry) => entry.source === "business-framework")).toHaveLength(
      2,
    );
    expect(result.sourceGaps).toContainEqual(otherGap);
    expect(result.extendedEvidence?.gaps).toContainEqual(otherGap);
  });
});
