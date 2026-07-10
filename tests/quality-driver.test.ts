import { describe, expect, test } from "bun:test";
import type { EvidenceQualityAssessment, EvidenceQualityCheck } from "../src/domain/types";
import { deriveResearchQualityDriver } from "../src/research/quality-driver";

function check(
  capability: string,
  evidenceClass: EvidenceQualityCheck["evidenceClass"],
  failed: Partial<Pick<EvidenceQualityCheck, "coverage" | "freshness" | "corroboration">> = {},
): EvidenceQualityCheck {
  const coverage = failed.coverage ?? "pass";
  const freshness = failed.freshness ?? "not-applicable";
  const corroboration = failed.corroboration ?? "not-applicable";
  return {
    capability,
    evidenceClass,
    coverage,
    freshness,
    corroboration,
    passed: coverage !== "fail" && freshness !== "fail" && corroboration !== "fail",
    reasons: [],
  };
}

function assessment(
  label: EvidenceQualityAssessment["label"],
  checks: readonly EvidenceQualityCheck[],
): EvidenceQualityAssessment {
  return {
    version: 1,
    rubricVersion: 1,
    label,
    checks,
    limitingReasons: [],
  };
}

describe("deriveResearchQualityDriver", () => {
  test("returns undefined for high research quality", () => {
    expect(
      deriveResearchQualityDriver(assessment("high", []), {
        reportIntegrity: "high",
        researchQuality: "high",
        pruned: [],
      }),
    ).toBeUndefined();
  });

  test("describes evidence-bound quality using structured checks", () => {
    expect(
      deriveResearchQualityDriver(
        assessment("low", [check("market-data", "core", { coverage: "fail" })]),
        {
          reportIntegrity: "high",
          researchQuality: "low",
          pruned: [],
        },
      ),
    ).toBe(
      "market data evidence missing; remediation: rerun after primary market data is available",
    );
  });

  test("describes integrity-bound quality using pruned sections", () => {
    expect(
      deriveResearchQualityDriver(assessment("high", []), {
        reportIntegrity: "medium",
        researchQuality: "medium",
        pruned: [{ location: "keyFindings[0]" }, { location: "predictions[1]" }],
      }),
    ).toBe(
      "report integrity pruning removed unsupported content from key findings, predictions; remediation: improve source coverage for the pruned sections",
    );
  });

  test("combines evidence and integrity when both bind", () => {
    expect(
      deriveResearchQualityDriver(
        assessment("medium", [check("news", "material", { corroboration: "fail" })]),
        {
          reportIntegrity: "medium",
          researchQuality: "medium",
          pruned: [{ location: "risks[0]" }],
        },
      ),
    ).toBe(
      "news lacks corroboration; report integrity pruning removed unsupported content from risks; remediation: add a second current news source or rerun; improve source coverage for the pruned sections",
    );
  });

  test("caps evidence drivers at two failed lanes with core lanes first", () => {
    const driver = deriveResearchQualityDriver(
      assessment("low", [
        check("news", "material", { coverage: "fail" }),
        check("market-data", "core", { coverage: "fail" }),
        check("verified-price-history", "core", { freshness: "fail" }),
      ]),
      {
        reportIntegrity: "high",
        researchQuality: "low",
        pruned: [],
      },
    );

    expect(driver).toContain("market data evidence missing");
    expect(driver).toContain("verified price history evidence stale");
    expect(driver).not.toContain("news evidence missing");
  });

  test("emits every failed check kind from a capped lane", () => {
    expect(
      deriveResearchQualityDriver(
        assessment("low", [
          check("news", "material", {
            coverage: "fail",
            freshness: "fail",
            corroboration: "fail",
          }),
        ]),
        {
          reportIntegrity: "high",
          researchQuality: "low",
          pruned: [],
        },
      ),
    ).toBe(
      "news evidence missing; news evidence stale; news lacks corroboration; remediation: configure news providers or rerun with fresh news coverage; rerun with fresher news coverage; add a second current news source or rerun",
    );
  });

  test("uses lane-specific remediation for subject profile coverage", () => {
    expect(
      deriveResearchQualityDriver(
        assessment("medium", [check("subject-profile", "material", { coverage: "fail" })]),
        {
          reportIntegrity: "high",
          researchQuality: "medium",
          pruned: [],
        },
      ),
    ).toBe(
      "subject profile evidence missing; remediation: configure MARKET_BOT_EXA_API_KEY or rerun --deep",
    );
  });
});
