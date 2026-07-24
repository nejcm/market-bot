export const UNTAGGED_FINANCIAL_COMPLETENESS_GATE = {
  passed: false,
  corpusVersion: 1,
  evaluatedAt: "2026-07-23T00:00:00.000Z",
  reason:
    "corpus v1 passed 6/7 supported full statements with zero silent mismatches, but Phase 3 keeps model-validated values outside canonical financial-core completeness",
} as const;
