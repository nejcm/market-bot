import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/guards";
import { readCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import {
  readFinancialStatementsArtifact,
  type FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { readReverseDcfArtifact } from "../src/sources/extended-evidence/reverse-dcf";
import { parseFinancialTableMappingOutput } from "../src/sources/extended-evidence/untagged-financial-table-validation";
import { readValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";

// Lifts the frozen v1 facts to the current shape so the drop tests isolate one malformed field.
function withFirstPublicAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withFirstPublicAt(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const lifted = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withFirstPublicAt(item)]),
  );
  return "filedAt" in value && "periodKey" in value
    ? { ...lifted, firstPublicAt: value.filedAt }
    : lifted;
}

describe("frozen historical artifacts", () => {
  test("reads capital ownership version 1", async () => {
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/capital-ownership-aapl-readable-v1.json", import.meta.url),
    ).json();

    expect(readCapitalOwnershipArtifact(artifact)).toBeDefined();
  });

  test("reads financial statements version 1, dating facts without firstPublicAt to filedAt", async () => {
    const artifact = (await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json()) as FinancialStatementsArtifact;

    const read = readFinancialStatementsArtifact(artifact);

    expect(read?.statements.incomeStatement.revenue.annual).toEqual(
      artifact.statements.incomeStatement.revenue.annual.map((fact) => ({
        ...fact,
        firstPublicAt: fact.filedAt,
      })),
    );
    const ttm = read?.statements.incomeStatement.netIncome.ttm?.components.fiscalYear;
    expect(ttm?.firstPublicAt).toBe("2026-03-02");
    expect(read?.readDiagnostics?.droppedObservationCount).toBe(0);
    expect(read?.readDiagnostics?.backfills).toContainEqual({
      reason: "financialStatements.revenue.annual.firstPublicAt-backfilled",
      count: 2,
    });
  });

  test("drops a fact with a non-string firstPublicAt", async () => {
    const frozen: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();
    const artifact = withFirstPublicAt(frozen) as FinancialStatementsArtifact;
    const { revenue } = artifact.statements.incomeStatement;
    const malformed = {
      ...artifact,
      statements: {
        ...artifact.statements,
        incomeStatement: {
          ...artifact.statements.incomeStatement,
          revenue: { ...revenue, annual: [{ ...revenue.annual[0], firstPublicAt: 0 }] },
        },
      },
    };

    const read = readFinancialStatementsArtifact(malformed);

    expect(read?.statements.incomeStatement.revenue.annual).toEqual([]);
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: 1,
      drops: [{ reason: "financialStatements.revenue.annual.invalid", count: 1 }],
    });
  });

  test("drops a fact with a malformed restatedFrom and keeps a well-formed one", async () => {
    const frozen: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();
    const artifact = withFirstPublicAt(frozen) as FinancialStatementsArtifact;
    const { revenue } = artifact.statements.incomeStatement;
    const withRestatement = (restatedFrom: unknown) =>
      readFinancialStatementsArtifact({
        ...artifact,
        statements: {
          ...artifact.statements,
          incomeStatement: {
            ...artifact.statements.incomeStatement,
            revenue: { ...revenue, annual: [{ ...revenue.annual[0], restatedFrom }] },
          },
        },
      })?.statements.incomeStatement.revenue.annual;

    expect(withRestatement(null)).toEqual([]);
    expect(withRestatement({ value: 1, filedAt: "2025-01-01" })).toHaveLength(1);
  });

  test("drops only an unreadable financial statement fact", async () => {
    const frozen: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();
    const artifact = withFirstPublicAt(frozen) as FinancialStatementsArtifact;
    const { revenue } = artifact.statements.incomeStatement;
    const malformed = {
      ...artifact,
      statements: {
        ...artifact.statements,
        incomeStatement: {
          ...artifact.statements.incomeStatement,
          revenue: {
            ...revenue,
            annual: [{ ...revenue.annual[0], taxonomy: "retired" }, ...revenue.annual.slice(1)],
          },
        },
      },
    };

    const read = readFinancialStatementsArtifact(malformed);

    expect(read?.statements.incomeStatement.revenue.annual).toEqual(revenue.annual.slice(1));
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: 1,
      drops: [{ reason: "financialStatements.revenue.annual.invalid", count: 1 }],
    });
  });

  test("drops only an unreadable equity-stack fact", async () => {
    const frozen: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();
    const artifact = withFirstPublicAt(frozen) as FinancialStatementsArtifact;
    const fact = artifact.statements.incomeStatement.revenue.annual[0]!;
    const malformed = {
      ...artifact,
      equityStack: {
        totalAssets: [{ ...fact, taxonomy: "retired" }, fact],
        totalLiabilities: [fact],
        stockholdersEquity: [fact],
        minorityInterest: [fact],
        stockholdersEquityIncludingNoncontrollingInterest: [fact],
        temporaryEquity: [fact],
      },
    };

    const read = readFinancialStatementsArtifact(malformed);

    expect(read?.equityStack?.totalAssets).toEqual([fact]);
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: 1,
      drops: [{ reason: "financialStatements.equityStack.totalAssets.invalid", count: 1 }],
    });
  });

  test("drops only an unreadable TTM observation", async () => {
    const frozen: unknown = await Bun.file(
      new URL("fixtures/artifacts/financial-statements-asts-readable-v1.json", import.meta.url),
    ).json();
    const artifact = withFirstPublicAt(frozen) as FinancialStatementsArtifact;
    const { netIncome } = artifact.statements.incomeStatement;
    const malformed = {
      ...artifact,
      statements: {
        ...artifact.statements,
        incomeStatement: {
          ...artifact.statements.incomeStatement,
          netIncome: { ...netIncome, ttm: { ...netIncome.ttm!, formula: "retired" } },
        },
      },
    };

    const read = readFinancialStatementsArtifact(malformed);

    expect(read?.statements.incomeStatement.netIncome.ttm).toBeUndefined();
    expect(read?.readDiagnostics).toEqual({
      droppedObservationCount: 1,
      drops: [{ reason: "financialStatements.netIncome.ttm.invalid", count: 1 }],
    });
  });

  test("reads reverse DCF version 1", async () => {
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/reverse-dcf-aapl-readable-v1.json", import.meta.url),
    ).json();

    expect(readReverseDcfArtifact(artifact)).toBeDefined();
  });

  test("reads financial table mapping version 1", async () => {
    const content = await Bun.file(
      new URL("fixtures/artifacts/financial-table-mapping-nbis-readable-v1.json", import.meta.url),
    ).text();

    expect(parseFinancialTableMappingOutput(content)).toHaveProperty("mapping");
  });

  test("reads a pre-0008 valuation workbench with a retired suppression reason", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    const artifact: unknown = await Bun.file(
      new URL("fixtures/artifacts/valuation-workbench-bns-pre-0008.json", import.meta.url),
    ).json();

    expect(JSON.stringify(artifact).match(/quote-reporting-currency-mismatch/gu)).toHaveLength(9);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });

  test("reads valuation workbench version 1 with a retired price-selection rule", async () => {
    // This real on-disk artifact is outside fixtures/runs/**/golden-output by design. Never regenerate it.
    // The rule string it carries was retired in 6f45873, unrelated to plan 0008.
    const artifact: unknown = await Bun.file(
      new URL(
        "fixtures/artifacts/valuation-workbench-aapl-retired-price-rule.json",
        import.meta.url,
      ),
    ).json();

    expect(artifact).toMatchObject({ version: 1 });
    expect(
      JSON.stringify(artifact).match(/first verified close on or after publicAt/gu),
    ).toHaveLength(1);
    expect(readValuationWorkbenchArtifact(artifact)).toBeDefined();
  });
});
