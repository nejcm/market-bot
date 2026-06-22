// Run Artifact Layout — the pure-data contract for on-disk run artifacts.
// Sidecar filenames, the normalized/ prefix convention, and the
// Mutable-vs-immutable classification live here. No I/O imports: this is a
// Leaf module so the reader, writers, freshness check, health probe, and
// Console cross one seam instead of re-declaring the same string constants.
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
  stages: "stages.json",
  score: "score.json",
  missAutopsy: "miss-autopsy.json",
  alphaValidation: "alpha-validation.json",
  // Raw/ sidecars
  rawSnapshots: `${RAW_DIR}/snapshots.json`,
  // Normalized/ sidecars carry their prefix in the value
  marketSnapshots: `${NORMALIZED_DIR}/market-snapshots.json`,
  supplementalMarketSnapshots: `${NORMALIZED_DIR}/supplemental-market-snapshots.json`,
  newsSources: `${NORMALIZED_DIR}/news-sources.json`,
  extendedSources: `${NORMALIZED_DIR}/extended-sources.json`,
  extendedEvidence: `${NORMALIZED_DIR}/extended-evidence.json`,
  marketContext: `${NORMALIZED_DIR}/market-context.json`,
  sourceGaps: `${NORMALIZED_DIR}/source-gaps.json`,
  sourcePlan: `${NORMALIZED_DIR}/source-plan.json`,
  evidenceLanes: `${NORMALIZED_DIR}/evidence-lanes.json`,
  sourceLedger: `${NORMALIZED_DIR}/source-ledger.json`,
  historicalContext: `${NORMALIZED_DIR}/historical-context.json`,
  forecastDisagreement: `${NORMALIZED_DIR}/forecast-disagreement.json`,
  verifiedMarketSnapshot: `${NORMALIZED_DIR}/verified-market-snapshot.json`,
  instrumentIdentity: `${NORMALIZED_DIR}/instrument-identity.json`,
  valuationComps: `${NORMALIZED_DIR}/valuation-comps.json`,
  financialLenses: `${NORMALIZED_DIR}/financial-lenses.json`,
  spotlightCandidates: `${NORMALIZED_DIR}/spotlight-candidates.json`,
  spotlightSelection: `${NORMALIZED_DIR}/spotlight-selection.json`,
  movers: `${NORMALIZED_DIR}/movers.json`,
  socialCandidates: `${NORMALIZED_DIR}/social-candidates.json`,
  secDiscoveryCandidates: `${NORMALIZED_DIR}/sec-discovery-candidates.json`,
  alphaSearchCandidates: `${NORMALIZED_DIR}/alpha-search-candidates.json`,
  listedUniverse: `${NORMALIZED_DIR}/listed-universe.json`,
  researchLeads: `${NORMALIZED_DIR}/research-leads.json`,
  secFundamentals: `${NORMALIZED_DIR}/sec-fundamentals.json`,
  secFundamentalsSourceGaps: `${NORMALIZED_DIR}/sec-fundamentals-source-gaps.json`,
  candidateProfiles: `${NORMALIZED_DIR}/candidate-profiles.json`,
  rejectedCandidates: `${NORMALIZED_DIR}/rejected-candidates.json`,
} as const;

export type RunArtifactFileName = (typeof RUN_ARTIFACT_FILES)[keyof typeof RUN_ARTIFACT_FILES];

// Index freshness depends on this set; it must stay closed over the layout.
// These sidecars are mutated in place after the initial run write, so the
// Freshness check stats them against the index.
export const MUTABLE_SIDECARS: readonly string[] = [
  RUN_ARTIFACT_FILES.score,
  RUN_ARTIFACT_FILES.missAutopsy,
  RUN_ARTIFACT_FILES.alphaValidation,
  RUN_ARTIFACT_FILES.candidateProfiles,
];
