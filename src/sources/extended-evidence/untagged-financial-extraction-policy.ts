import type {
  UntaggedFinancialExtractorEvaluation,
  UntaggedFinancialExtractionExecutionPolicy,
} from "./untagged-financial-tables-contract";

export const UNTAGGED_FINANCIAL_EXTRACTOR_EVALUATION: UntaggedFinancialExtractorEvaluation =
  Object.freeze({
    status: "passed",
    corpusVersion: 1,
    evaluatedAt: "2026-07-23T00:00:00.000Z",
    supportedCaseCount: 8,
    acceptedCaseCount: 7,
    silentMismatchCount: 0,
    sourceCellMismatchCount: 0,
  });

export const UNTAGGED_FINANCIAL_PRODUCTION_EXECUTION_POLICY: UntaggedFinancialExtractionExecutionPolicy =
  Object.freeze({ enabled: false });
