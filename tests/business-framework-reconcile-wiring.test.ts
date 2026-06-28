import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence, SourceGap } from "../src/domain/types";
import { reconcileBusinessFrameworkEvidence } from "../src/research/orchestrator";
import {
  frameworkGap,
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

function bundle(artifact: BusinessFrameworkArtifact, staleGap: SourceGap, webProfile = profile()) {
  const extendedEvidence: ExtendedEvidence = {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [],
    gaps: [staleGap],
  };
  return collectedSourceBundle({
    businessFramework: artifact,
    webSubjectProfile: webProfile,
    extendedEvidence,
    sourceGaps: [staleGap],
  });
}

describe("reconcileBusinessFrameworkEvidence wiring", () => {
  test("replaces the stale gap in source and extended evidence collections", () => {
    const artifact = framework([gap("segment-mix"), gap("analyst-consensus")]);
    const result = reconcileBusinessFrameworkEvidence(
      bundle(artifact, frameworkGap("AAPL", artifact.gaps)),
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
      bundle(artifact, frameworkGap("AAPL", artifact.gaps)),
    );

    expect(result.sourceGaps.filter((entry) => entry.source === "business-framework")).toEqual([]);
    expect(
      result.extendedEvidence?.gaps.filter((entry) => entry.source === "business-framework"),
    ).toEqual([]);
  });

  test("returns the original collection when no present code resolves", () => {
    const artifact = framework([gap("customer-concentration")]);
    const staleGap = frameworkGap("AAPL", artifact.gaps);
    const collected = bundle(artifact, staleGap, profile({ answer: "Consumers", sourceIds: [] }));

    expect(reconcileBusinessFrameworkEvidence(collected)).toBe(collected);
  });

  test("preserves unrelated gaps", () => {
    const artifact = framework([gap("segment-mix"), gap("analyst-consensus")]);
    const staleGap = frameworkGap("AAPL", artifact.gaps);
    const otherGap: SourceGap = {
      source: "web-subject-profile",
      message: "profile freshness gap",
      capability: "extended-evidence",
    };
    const collected = collectedSourceBundle({
      ...bundle(artifact, staleGap),
      sourceGaps: [staleGap, otherGap],
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: [staleGap, otherGap],
      },
    });

    const result = reconcileBusinessFrameworkEvidence(collected);
    expect(result.sourceGaps).toContainEqual(otherGap);
    expect(result.extendedEvidence?.gaps).toContainEqual(otherGap);
  });
});
