import type { ExtendedEvidenceItem } from "../../src/domain/evidence";
import {
  addFinancialLensEvidence,
  type FinancialLensName,
} from "../../src/sources/extended-evidence/financial-lens";
import type { FinancialLens } from "../../src/sources/extended-evidence/financial-lens-metrics";
import type { FinancialStatementsArtifact } from "../../src/sources/extended-evidence/financial-statements-contract";

export function summaryLens(
  item: ExtendedEvidenceItem | undefined,
  name: FinancialLensName,
  asOf = "2026-10-08T00:00:00.000Z",
  statements?: FinancialStatementsArtifact,
): FinancialLens {
  const result = addFinancialLensEvidence(
    { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
    [],
    { items: item === undefined ? [] : [item], gaps: [] },
    undefined,
    asOf,
    undefined,
    undefined,
    statements,
  );
  return result.artifact!.lenses.find((lens) => lens.name === name)!;
}
