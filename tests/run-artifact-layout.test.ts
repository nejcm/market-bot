import { describe, expect, test } from "bun:test";
import { MUTABLE_SIDECARS, NORMALIZED_DIR, RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";

const FILE_VALUES = Object.values(RUN_ARTIFACT_FILES);

describe("run-artifact-layout", () => {
  test("canonical sidecar paths are pinned", () => {
    expect(RUN_ARTIFACT_FILES.report).toBe("report.json");
    expect(RUN_ARTIFACT_FILES.reportMarkdown).toBe("report.md");
    expect(RUN_ARTIFACT_FILES.trace).toBe("trace.json");
    expect(RUN_ARTIFACT_FILES.analytics).toBe("analytics.json");
    expect(RUN_ARTIFACT_FILES.score).toBe("score.json");
    expect(RUN_ARTIFACT_FILES.missAutopsy).toBe("miss-autopsy.json");
    expect(RUN_ARTIFACT_FILES.alphaValidation).toBe("alpha-validation.json");

    expect(RUN_ARTIFACT_FILES.marketSnapshots).toBe(`${NORMALIZED_DIR}/market-snapshots.json`);
    expect(RUN_ARTIFACT_FILES.sourceGaps).toBe(`${NORMALIZED_DIR}/source-gaps.json`);
    expect(RUN_ARTIFACT_FILES.sourcePlan).toBe(`${NORMALIZED_DIR}/source-plan.json`);
    expect(RUN_ARTIFACT_FILES.evidenceLanes).toBe(`${NORMALIZED_DIR}/evidence-lanes.json`);
    expect(RUN_ARTIFACT_FILES.sourceLedger).toBe(`${NORMALIZED_DIR}/source-ledger.json`);
    expect(RUN_ARTIFACT_FILES.verifiedMarketSnapshot).toBe(
      `${NORMALIZED_DIR}/verified-market-snapshot.json`,
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

  test("every value containing a slash is prefixed with NORMALIZED_DIR", () => {
    const slashed = FILE_VALUES.filter((path) => path.includes("/"));
    expect(slashed.length).toBeGreaterThan(0);
    for (const path of slashed) {
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
