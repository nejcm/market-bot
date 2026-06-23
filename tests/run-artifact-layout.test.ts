import { describe, expect, test } from "bun:test";
import {
  MUTABLE_SIDECARS,
  NORMALIZED_DIR,
  RAW_DIR,
  RUN_ARTIFACT_FILES,
} from "../src/run-artifact-layout";

const FILE_VALUES = Object.values(RUN_ARTIFACT_FILES);

describe("run-artifact-layout", () => {
  test("canonical sidecar paths are pinned", () => {
    expect(RUN_ARTIFACT_FILES.report).toBe("report.json");
    expect(RUN_ARTIFACT_FILES.reportMarkdown).toBe("report.md");
    expect(RUN_ARTIFACT_FILES.trace).toBe("trace.json");
    expect(RUN_ARTIFACT_FILES.analytics).toBe("analytics.json");
    expect(RUN_ARTIFACT_FILES.stages).toBe("stages.json");
    expect(RUN_ARTIFACT_FILES.score).toBe("score.json");
    expect(RUN_ARTIFACT_FILES.missAutopsy).toBe("miss-autopsy.json");
    expect(RUN_ARTIFACT_FILES.alphaValidation).toBe("alpha-validation.json");
    expect(RUN_ARTIFACT_FILES.rawSnapshots).toBe(`${RAW_DIR}/snapshots.json`);

    expect(RUN_ARTIFACT_FILES.marketSnapshots).toBe(`${NORMALIZED_DIR}/market-snapshots.json`);
    expect(RUN_ARTIFACT_FILES.supplementalMarketSnapshots).toBe(
      `${NORMALIZED_DIR}/supplemental-market-snapshots.json`,
    );
    expect(RUN_ARTIFACT_FILES.newsSources).toBe(`${NORMALIZED_DIR}/news-sources.json`);
    expect(RUN_ARTIFACT_FILES.extendedSources).toBe(`${NORMALIZED_DIR}/extended-sources.json`);
    expect(RUN_ARTIFACT_FILES.extendedEvidence).toBe(`${NORMALIZED_DIR}/extended-evidence.json`);
    expect(RUN_ARTIFACT_FILES.marketContext).toBe(`${NORMALIZED_DIR}/market-context.json`);
    expect(RUN_ARTIFACT_FILES.sourceGaps).toBe(`${NORMALIZED_DIR}/source-gaps.json`);
    expect(RUN_ARTIFACT_FILES.sourcePlan).toBe(`${NORMALIZED_DIR}/source-plan.json`);
    expect(RUN_ARTIFACT_FILES.evidenceLanes).toBe(`${NORMALIZED_DIR}/evidence-lanes.json`);
    expect(RUN_ARTIFACT_FILES.sourceLedger).toBe(`${NORMALIZED_DIR}/source-ledger.json`);
    expect(RUN_ARTIFACT_FILES.historicalContext).toBe(`${NORMALIZED_DIR}/historical-context.json`);
    expect(RUN_ARTIFACT_FILES.verifiedMarketSnapshot).toBe(
      `${NORMALIZED_DIR}/verified-market-snapshot.json`,
    );
    expect(RUN_ARTIFACT_FILES.instrumentIdentity).toBe(
      `${NORMALIZED_DIR}/instrument-identity.json`,
    );
    expect(RUN_ARTIFACT_FILES.valuationComps).toBe(`${NORMALIZED_DIR}/valuation-comps.json`);
    expect(RUN_ARTIFACT_FILES.financialLenses).toBe(`${NORMALIZED_DIR}/financial-lenses.json`);
    expect(RUN_ARTIFACT_FILES.spotlightCandidates).toBe(
      `${NORMALIZED_DIR}/spotlight-candidates.json`,
    );
    expect(RUN_ARTIFACT_FILES.spotlightSelection).toBe(
      `${NORMALIZED_DIR}/spotlight-selection.json`,
    );
    expect(RUN_ARTIFACT_FILES.movers).toBe(`${NORMALIZED_DIR}/movers.json`);
    expect(RUN_ARTIFACT_FILES.forecastDisagreement).toBe(
      `${NORMALIZED_DIR}/forecast-disagreement.json`,
    );
    expect(RUN_ARTIFACT_FILES.socialCandidates).toBe(`${NORMALIZED_DIR}/social-candidates.json`);
    expect(RUN_ARTIFACT_FILES.secDiscoveryCandidates).toBe(
      `${NORMALIZED_DIR}/sec-discovery-candidates.json`,
    );
    expect(RUN_ARTIFACT_FILES.alphaSearchCandidates).toBe(
      `${NORMALIZED_DIR}/alpha-search-candidates.json`,
    );
    expect(RUN_ARTIFACT_FILES.listedUniverse).toBe(`${NORMALIZED_DIR}/listed-universe.json`);
    expect(RUN_ARTIFACT_FILES.researchLeads).toBe(`${NORMALIZED_DIR}/research-leads.json`);
    expect(RUN_ARTIFACT_FILES.secFundamentals).toBe(`${NORMALIZED_DIR}/sec-fundamentals.json`);
    expect(RUN_ARTIFACT_FILES.secFundamentalsSourceGaps).toBe(
      `${NORMALIZED_DIR}/sec-fundamentals-source-gaps.json`,
    );
    expect(RUN_ARTIFACT_FILES.candidateProfiles).toBe(`${NORMALIZED_DIR}/candidate-profiles.json`);
    expect(RUN_ARTIFACT_FILES.rejectedCandidates).toBe(
      `${NORMALIZED_DIR}/rejected-candidates.json`,
    );
  });

  test("every file value is unique", () => {
    const deduped = new Set(FILE_VALUES);
    expect(deduped.size).toBe(FILE_VALUES.length);
  });

  test("every normalized file value is prefixed with NORMALIZED_DIR", () => {
    const normalized = FILE_VALUES.filter((path) => path.startsWith(`${NORMALIZED_DIR}/`));
    expect(normalized.length).toBeGreaterThan(0);
    for (const path of normalized) {
      expect(path.startsWith(`${NORMALIZED_DIR}/`)).toBe(true);
    }
  });

  test("MUTABLE_SIDECARS is a subset of the file set", () => {
    const fileSet = new Set<string>(FILE_VALUES);
    for (const path of MUTABLE_SIDECARS) {
      expect(fileSet.has(path)).toBe(true);
    }
  });

  test("MUTABLE_SIDECARS is closed and pinned", () => {
    expect([...MUTABLE_SIDECARS]).toEqual([
      "score.json",
      "miss-autopsy.json",
      "alpha-validation.json",
      "normalized/candidate-profiles.json",
    ]);
  });

  test("no file value uses a backslash separator", () => {
    for (const path of FILE_VALUES) {
      expect(path.includes("\\")).toBe(false);
    }
  });
});
