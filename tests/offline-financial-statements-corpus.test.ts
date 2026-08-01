import { describe, expect, test } from "bun:test";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  classifyOfflineCorpusDifferences,
  loadOfflineCorpusAllowances,
  loadOfflineCorpusGolden,
  loadOfflineFinancialStatementInput,
  recompareOfflineCorpusProjection,
  runOfflineFinancialStatementCorpus,
} from "./support/offline-financial-statements-corpus";

describe("offline financial-statement corpus", () => {
  test("locks every issuer projection and classifies every consumer difference offline", async () => {
    const expectedClassifications = {
      aapl: { matched: 74, allowances: 0 },
      msft: { matched: 78, allowances: 0 },
      mara: { matched: 59, allowances: 19 },
      nbis: { matched: 37, allowances: 39 },
      "fpi-quarterly": { matched: 24, allowances: 52 },
      "fpi-ifrs-semiannual": { matched: 33, allowances: 43 },
    } as const;
    const allowances = await loadOfflineCorpusAllowances();
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        networkAttempts += 1;
        throw new Error("Offline financial-statement corpus attempted network access");
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      let classifiedAllowanceCount = 0;
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        const input = await loadOfflineFinancialStatementInput(fixture);
        const execution = runOfflineFinancialStatementCorpus(input);
        const golden = await loadOfflineCorpusGolden(fixture);
        const classification = classifyOfflineCorpusDifferences(execution, allowances);

        expect(execution.projection).toEqual(golden);
        expect(classification.matchedCount).toBe(expectedClassifications[fixture].matched);
        expect(classification.allowances).toHaveLength(expectedClassifications[fixture].allowances);
        expect(execution.differences).toHaveLength(expectedClassifications[fixture].allowances);
        expect(
          Bun.file(
            new URL(`fixtures/financial-statements-corpus/${fixture}/input.json`, import.meta.url),
          ).size,
        ).toBeLessThan(250_000);
        expect(JSON.stringify(input)).not.toMatch(
          /api[_-]?key|authorization|bearer\s|password|secret|access[_-]?token/iu,
        );
        classifiedAllowanceCount += classification.allowances.length;
      }

      expect(classifiedAllowanceCount).toBe(allowances.length);
      expect(networkAttempts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses no collector, credential, network, or model seam", async () => {
    const source = await Bun.file(
      new URL("support/offline-financial-statements-corpus.ts", import.meta.url),
    ).text();

    expect(source).not.toMatch(
      /financial-statements-parity|collectSources|ModelProvider|\/model\/|\.generate\(|\bfetch\(/u,
    );
    expect(source).not.toContain("process.env");
  });

  test("keeps MARA allowances fixture-specific and source-reproduced", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const maraAllowances = allowances.filter((allowance) => allowance.fixture === "mara");
    const exactPeriodPaths = maraAllowances
      .filter((allowance) => allowance.kind === "canonical-exact-period-correction")
      .map((allowance) => allowance.path)
      .toSorted();

    expect(maraAllowances.map((allowance) => allowance.path).toSorted()).toEqual([
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.cashConversion",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
      "fundamentalHistory.capex.annual",
      "fundamentalHistory.dilutedEps.annual",
      "fundamentalHistory.freeCashFlowProxy.annual",
      "fundamentalHistory.grossMargin.annual",
      "fundamentalHistory.grossMargin.marginChange",
      "fundamentalHistory.grossProfit.annual",
      "fundamentalHistory.netIncome.annual",
      "fundamentalHistory.netMargin.annual",
      "fundamentalHistory.operatingCashFlow.annual",
      "fundamentalHistory.operatingIncome.annual",
      "fundamentalHistory.operatingMargin.annual",
      "fundamentalHistory.revenue.annual",
    ]);
    expect(exactPeriodPaths).toEqual([
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.cashConversion",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    expect(
      execution.differences.find(
        (difference) => difference.path === "financialLens.Quality.metrics.grossMargin",
      ),
    ).toMatchObject({
      canonical: {
        value: Number("-0.28594600562193745"),
        periodEnd: "2022-12-31",
        periodMonths: 12,
      },
      legacy: null,
    });
    expect(
      execution.differences.find(
        (difference) => difference.path === "financialLens.Quality.metrics.netMargin",
      ),
    ).toMatchObject({
      canonical: {
        value: Number("-1.445805446630059"),
        periodEnd: "2025-12-31",
        periodMonths: 12,
      },
      legacy: null,
    });
    expect(execution.projection.statements.revenue).toMatchObject({
      selectedConcept: "Revenues",
    });
    expect(JSON.stringify(execution.input.companyFacts)).toContain(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(() => classifyOfflineCorpusDifferences(execution, allowances)).not.toThrow();
  });

  test("fires the test-only comparator alarm on an injected ROE mismatch", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("msft"),
    );
    const quality = execution.projection.canonical.financialLens.Quality;
    const roe = quality?.metrics.roe;
    if (quality === undefined || roe === undefined || typeof roe.value !== "number") {
      throw new Error("MSFT golden is missing canonical ROE");
    }
    const injectedProjection = {
      ...execution.projection,
      canonical: {
        ...execution.projection.canonical,
        financialLens: {
          ...execution.projection.canonical.financialLens,
          Quality: {
            ...quality,
            metrics: {
              ...quality.metrics,
              roe: { ...roe, value: roe.value + 0.01 },
            },
          },
        },
      },
    };
    const injected = recompareOfflineCorpusProjection(execution, injectedProjection);

    expect(() => classifyOfflineCorpusDifferences(injected, allowances)).toThrow(
      /Offline comparator alarm: unclassified msft difference financialLens\.Quality\.metrics\.roe/u,
    );
  });
});
