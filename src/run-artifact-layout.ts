// Run Artifact Layout — the pure-data contract for on-disk run artifacts.
// Sidecar filenames, the normalized/ prefix convention, and the
// Mutable-vs-immutable classification live here. No I/O imports: this is a
// Leaf module so the reader, writers, freshness check, and health probe
// Cross one seam instead of re-declaring the same string constants.
//
// Only artifacts whose paths are actually consumed through this module live
// Here. As remaining writers/readers migrate off hardcoded literals, add
// Their entries alongside the migration — not ahead of it.
export const NORMALIZED_DIR = "normalized";
export const RAW_DIR = "raw";

// Canonical run-dir relative paths. One source of truth.
// Values use forward slashes; node:path join accepts them on Windows too,
// And the run-artifact index stores paths with forward slashes.
export const RUN_ARTIFACT_FILES = {
  // Top-level sidecars (run-dir relative)
  report: "report.json",
  reportMarkdown: "report.md",
  trace: "trace.json",
  analytics: "analytics.json",
  score: "score.json",
  missAutopsy: "miss-autopsy.json",
  alphaValidation: "alpha-validation.json",
  // Normalized/ sidecars carry their prefix in the value
  marketSnapshots: `${NORMALIZED_DIR}/market-snapshots.json`,
  sourceGaps: `${NORMALIZED_DIR}/source-gaps.json`,
  sourcePlan: `${NORMALIZED_DIR}/source-plan.json`,
  evidenceLanes: `${NORMALIZED_DIR}/evidence-lanes.json`,
  sourceLedger: `${NORMALIZED_DIR}/source-ledger.json`,
  verifiedMarketSnapshot: `${NORMALIZED_DIR}/verified-market-snapshot.json`,
  candidateProfiles: `${NORMALIZED_DIR}/candidate-profiles.json`,
  rejectedCandidates: `${NORMALIZED_DIR}/rejected-candidates.json`,
} as const;

export type RunArtifactFileName = (typeof RUN_ARTIFACT_FILES)[keyof typeof RUN_ARTIFACT_FILES];

// Index freshness depends on this set; it must stay closed over the layout.
// These sidecars are mutated in place after the initial run write, so the
// Freshness check stats them against the index.
export const MUTABLE_SIDECARS: readonly RunArtifactFileName[] = [
  RUN_ARTIFACT_FILES.score,
  RUN_ARTIFACT_FILES.missAutopsy,
  RUN_ARTIFACT_FILES.alphaValidation,
  RUN_ARTIFACT_FILES.candidateProfiles,
];
