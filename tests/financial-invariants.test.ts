import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type { FinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import {
  financialStatementFacts,
  latestFinancialStatementFact,
} from "../src/sources/extended-evidence/financial-statement-selection";
import { identityTolerance } from "../src/sources/extended-evidence/untagged-financial-table-validation";
import { runFixture, type RunFixtureResult } from "./support/run-fixtures";
import {
  assertBalanceSheetFactIdentity,
  assertCompositeFactIntegrity,
  assertFundamentalHistoryInvariants,
  assertRetainedDurationFactsIdentical,
  assertSourceIdClosure,
  balanceSheetIdentityCoverage,
  financialStatementDurationProjection,
} from "./support/run-fixtures/financial-invariants";

function financialStatements(result: RunFixtureResult): FinancialStatementsArtifact {
  const artifact = result.deepEquityEvidenceBundle?.derived.financialStatements;
  if (artifact === undefined) {
    throw new Error("Fixture has no financial statements");
  }
  return artifact;
}

function fixtureResult(results: readonly RunFixtureResult[], index: number): RunFixtureResult {
  const result = results.at(index);
  if (result === undefined) {
    throw new Error(`Fixture result ${String(index)} is unavailable`);
  }
  return result;
}

function companyfactsInstant(
  value: number,
  periodEnd: string,
  form: "10-K" | "10-Q",
  fiscalPeriod: string,
  filedAt: string,
): Record<string, unknown> {
  return {
    val: value,
    form,
    fy: Number.parseInt(periodEnd.slice(0, 4), 10),
    fp: fiscalPeriod,
    filed: filedAt,
    end: periodEnd,
    accn: `${filedAt.replaceAll("-", "")}-${form}`,
  };
}

describe("live financial invariant negative controls", () => {
  let results: readonly RunFixtureResult[] = [];

  beforeAll(async () => {
    results = await Promise.all([
      runFixture("equity-aapl-deep", { llm: "replay" }),
      runFixture("equity-nbis-deep", { llm: "replay" }),
    ]);
  });

  afterAll(async () => {
    await Promise.all(results.map((result) => result.cleanup()));
  });

  test("A1 fires when a retained duration fact is stripped", () => {
    const result = fixtureResult(results, 0);
    const retained = financialStatementDurationProjection(financialStatements(result));
    expect(retained.length).toBeGreaterThan(0);

    expect(() => assertRetainedDurationFactsIdentical(retained.slice(1), retained)).toThrow(
      /\[A1\]/u,
    );
  });

  test("B9 fires when a margin-change sign is negated", () => {
    const result = fixtureResult(results, 0);
    const history = result.deepEquityEvidenceBundle?.derived.fundamentalHistory;
    const entry = Object.values(history?.series ?? {}).find(
      (series) => series.marginChange !== undefined && series.marginChange.percentagePoints !== 0,
    );
    if (history === undefined || entry?.marginChange === undefined) {
      throw new Error("AAPL deep fixture has no non-zero margin change");
    }
    const injected = {
      ...history,
      series: {
        ...history.series,
        [entry.key]: {
          ...entry,
          marginChange: {
            ...entry.marginChange,
            percentagePoints: -entry.marginChange.percentagePoints,
          },
        },
      },
    };

    expect(() => assertFundamentalHistoryInvariants(injected, true)).toThrow(
      /\[B9\].*sign disagrees/u,
    );
  });

  test("A6 fires when total assets move by twice the identity tolerance", () => {
    const artifact = financialStatements(fixtureResult(results, 1));
    const assetsSeries = artifact.statements.balanceSheet.totalAssets;
    const liabilitiesSeries = artifact.statements.balanceSheet.totalLiabilities;
    const equitySeries = artifact.statements.balanceSheet.stockholdersEquity;
    const assetFact = financialStatementFacts(assetsSeries).find((candidate) => {
      const liabilities = financialStatementFacts(liabilitiesSeries).find(
        (fact) => fact.periodEnd === candidate.periodEnd,
      );
      const equity = financialStatementFacts(equitySeries).find(
        (fact) => fact.periodEnd === candidate.periodEnd,
      );
      return (
        liabilities !== undefined &&
        equity !== undefined &&
        Math.abs(candidate.value - liabilities.value - equity.value) <=
          identityTolerance([candidate, liabilities, equity])
      );
    });
    const liabilityFact = financialStatementFacts(liabilitiesSeries).find(
      (fact) => fact.periodEnd === assetFact?.periodEnd,
    );
    const equityFact = financialStatementFacts(equitySeries).find(
      (fact) => fact.periodEnd === assetFact?.periodEnd,
    );
    if (assetFact === undefined || liabilityFact === undefined || equityFact === undefined) {
      throw new Error("NBIS fixture has no passing complete balance-sheet identity period");
    }
    expect(() =>
      assertBalanceSheetFactIdentity(assetFact, liabilityFact, equityFact),
    ).not.toThrow();
    const tolerance = identityTolerance([assetFact, liabilityFact, equityFact]);
    const residual = assetFact.value - liabilityFact.value - equityFact.value;
    const injectedAsset = {
      ...assetFact,
      value: assetFact.value + (Math.sign(residual) || 1) * tolerance * 2,
    };
    expect(() => assertBalanceSheetFactIdentity(injectedAsset, liabilityFact, equityFact)).toThrow(
      /\[A6\]/u,
    );
  });

  test("A6 retains broad identity coverage after structural equity-stack guards", () => {
    const nbis = balanceSheetIdentityCoverage(financialStatements(fixtureResult(results, 1)));

    expect(nbis.completePeriods).toBeGreaterThanOrEqual(15);
    expect(nbis.asserted).toBe(nbis.completePeriods);
    expect(nbis.skipped).toBe(0);
    expect(nbis.failing).toBe(0);
  });

  test("C12 fires when a sourceIds entry is rewritten", () => {
    const result = fixtureResult(results, 0);
    const artifact = financialStatements(result);
    const { revenue } = artifact.statements.incomeStatement;
    const [annualFirst] = revenue.annual;
    const [interimFirst] = revenue.interim;
    const first = annualFirst ?? interimFirst;
    if (first === undefined) {
      throw new Error("AAPL deep fixture has no revenue fact");
    }
    const injected = {
      ...artifact,
      statements: {
        ...artifact.statements,
        incomeStatement: {
          ...artifact.statements.incomeStatement,
          revenue: {
            ...revenue,
            [first.periodType]: revenue[first.periodType].map((fact) =>
              fact === first ? { ...fact, sourceIds: ["missing-source"] } : fact,
            ),
          },
        },
      },
    };
    const knownSourceIds = new Set(result.report.sources.map((source) => source.id));

    expect(() => assertSourceIdClosure(injected, knownSourceIds)).toThrow(/\[C12\]/u);
  });
});

describe("composite statement fact integrity", () => {
  test("A8 fires when a composite component value is mutated", () => {
    const artifact = deriveFinancialStatements(
      {
        facts: {
          "us-gaap": {
            Revenues: {
              units: {
                USD: [
                  {
                    val: 100,
                    form: "10-K",
                    fy: 2025,
                    fp: "FY",
                    filed: "2026-02-15",
                    start: "2025-01-01",
                    end: "2025-12-31",
                    accn: "rev-2025",
                  },
                ],
              },
            },
            LongTermDebtCurrent: {
              units: {
                USD: [companyfactsInstant(875_000_000, "2026-06-27", "10-Q", "Q2", "2026-08-06")],
              },
            },
            LongTermDebtNoncurrent: {
              units: {
                USD: [companyfactsInstant(2_351_000_000, "2026-06-27", "10-Q", "Q2", "2026-08-06")],
              },
            },
          },
        },
      },
      {
        symbol: "TEST",
        generatedAt: "2026-08-28T00:00:00.000Z",
        analysisAsOf: "2026-08-28T00:00:00.000Z",
        sourceId: "extended-sec-edgar-test-fundamentals",
      },
    );
    const debtSeries = artifact.statements.balanceSheet.debt;
    const debt = latestFinancialStatementFact([...debtSeries.annual, ...debtSeries.interim]);
    if (debt?.composite === undefined) {
      throw new Error("expected a composite debt fact");
    }
    expect(() => assertCompositeFactIntegrity(artifact)).not.toThrow();
    const [first] = debt.composite.components;
    if (first === undefined) {
      throw new Error("expected composite contributors");
    }
    const tolerance = identityTolerance([
      { value: debt.value, unitScale: debt.unitScale },
      ...debt.composite.components.map((component) => ({
        value: component.value,
        unitScale: debt.unitScale,
      })),
    ]);
    const mutated = {
      ...debt,
      composite: {
        ...debt.composite,
        components: [
          { ...first, value: first.value + tolerance * 2 },
          ...debt.composite.components.slice(1),
        ],
      },
    };
    const injected = {
      ...artifact,
      statements: {
        ...artifact.statements,
        balanceSheet: {
          ...artifact.statements.balanceSheet,
          debt: {
            ...debtSeries,
            [debt.periodType]: debtSeries[debt.periodType].map((fact) =>
              fact === debt ? mutated : fact,
            ),
          },
        },
      },
    };

    expect(() => assertCompositeFactIntegrity(injected)).toThrow(/\[A8\]/u);
  });
});
