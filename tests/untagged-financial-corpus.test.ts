import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluateUntaggedFinancialCorpus,
  UNTAGGED_FINANCIAL_CORPUS_DIR,
} from "./support/untagged-financial-corpus";

describe("untagged FPI financial exhibit corpus", () => {
  test("passes the pre-production extraction gate without silent mismatches", async () => {
    const evaluation = await evaluateUntaggedFinancialCorpus();

    expect(evaluation).toMatchObject({
      caseCount: 10,
      supportedFullStatementCount: 7,
      acceptedFullStatementCount: 6,
      insufficientCoverageCount: 2,
      unsupportedLayoutCount: 1,
      silentlyWrongValueCount: 0,
      sourceCellMismatchCount: 0,
      passed: true,
    });
    expect(evaluation.layoutFamilies.length).toBeGreaterThanOrEqual(3);
    expect(evaluation.acceptanceRate).toBeCloseTo(6 / 7, 12);
    expect(evaluation.cases.find((item) => item.id === "nbis-2026-q1")?.outcome).toBe("accepted");
    expect(evaluation.cases.find((item) => item.id === "baba-2026-fy")).toMatchObject({
      outcome: "rejected",
      validationIssues: [
        expect.objectContaining({ code: "balance-sheet-identity-failed" }),
        expect.objectContaining({ code: "incomplete-balance-sheet" }),
        expect.objectContaining({ code: "incomplete-cash-flow-statement" }),
      ],
    });
    expect(evaluation.cases.find((item) => item.id === "asml-2026-q2-image")).toMatchObject({
      outcome: "unsupported",
      unsupportedReason: "image-only",
    });
  });

  test("records an accepted cell-identical live NBIS comparison", async () => {
    const comparison = JSON.parse(
      await readFile(join(UNTAGGED_FINANCIAL_CORPUS_DIR, "nbis-live-comparison.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(comparison).toMatchObject({
      reachable: true,
      byteIdentical: true,
      fixtureStatus: "accepted",
      liveStatus: "accepted",
      valueCount: 14,
      cellValuesIdentical: true,
    });
  });
});
