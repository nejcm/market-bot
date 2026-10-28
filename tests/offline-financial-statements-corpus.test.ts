import { describe, expect, test } from "bun:test";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  auditOfflineCorpusCase,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
} from "./support/offline-financial-statements-corpus";

describe("offline financial-statement corpus", () => {
  test("locks every issuer projection and classifies every consumer difference offline", async () => {
    const expectedClassifications = {
      aapl: { matched: 16, allowances: 4 },
      msft: { matched: 20, allowances: 4 },
      mara: { matched: 13, allowances: 11 },
      nbis: { matched: 3, allowances: 16 },
      "fpi-quarterly": { matched: 2, allowances: 19 },
      "fpi-ifrs-semiannual": { matched: 3, allowances: 17 },
    } as const;
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
      let totalAllowances = 0;
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        const corpusCase = await loadOfflineCorpusCase(fixture);
        const audit = auditOfflineCorpusCase(corpusCase);

        expect(corpusCase.execution.projection).toEqual(corpusCase.golden);
        expect(audit.matchedCount).toBe(expectedClassifications[fixture].matched);
        expect(audit.allowances).toHaveLength(expectedClassifications[fixture].allowances);
        expect(audit.differences).toHaveLength(expectedClassifications[fixture].allowances);
        expect(
          Bun.file(
            new URL(`fixtures/financial-statements-corpus/${fixture}/input.json`, import.meta.url),
          ).size,
        ).toBeLessThan(250_000);
        expect(JSON.stringify(corpusCase.execution.input)).not.toMatch(
          /api[_-]?key|authorization|bearer\s|password|secret|access[_-]?token/iu,
        );
        classifiedAllowanceCount += audit.allowances.length;
        totalAllowances += corpusCase.allowances.length;
      }

      expect(classifiedAllowanceCount).toBe(totalAllowances);
      expect(networkAttempts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses no collector, credential, network, or model seam", async () => {
    for (const path of [
      "support/offline-financial-statements-corpus.ts",
      "support/offline-financial-corpus-compare.ts",
      "support/offline-financial-history-roster.ts",
      "support/offline-financial-history-facts.ts",
      "support/offline-financial-history-aliases.ts",
      "support/offline-financial-lens-properties.ts",
      "support/synthetic-alias-companyfacts.ts",
      "support/offline-corpus-test-helpers.ts",
      "support/offline-financial-history-fixtures.ts",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();

      expect(source).not.toMatch(
        /financial-statements-parity|collectSources|ModelProvider|\/model\/|\.generate\(|\bfetch\(/u,
      );
      expect(source).not.toContain("process.env");
    }
  });

  test("keeps the dated reason NBIS FY2023 debt is withheld", async () => {
    const { execution } = await loadOfflineCorpusCase("nbis");
    expect(execution.artifact.omissionNotes).toContainEqual(
      expect.objectContaining({
        code: "incomplete-composite-series",
        seriesKey: "debt",
        periodKey: "instant|2023-12-31",
        message: expect.stringContaining("establishes whether it includes current maturities"),
      }),
    );
  });

  test("withholds NBIS FY2022 and FY2023 net margin when NCI is reported and continuing income is parent-only", async () => {
    const { execution } = await loadOfflineCorpusCase("nbis");
    const periods = (execution.projection.canonical.fundamentalHistory.netMargin?.annual ?? []).map(
      (point) => point.periodEnd,
    );
    expect(periods).not.toContain("2022-12-31");
    expect(periods).not.toContain("2023-12-31");
    for (const year of ["2022", "2023"]) {
      expect(execution.artifact.omissionNotes).toContainEqual(
        expect.objectContaining({
          code: "withheld-derivation",
          seriesKey: "consolidatedContinuingIncome",
          periodKey: `duration:12|${year}-12-31`,
        }),
      );
    }
  });

  test("keeps MARA allowances fixture-specific and source-reproduced", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const exactPeriodPaths = maraCase.allowances
      .filter((allowance) => allowance.kind === "canonical-exact-period-correction")
      .map((allowance) => allowance.path)
      .toSorted();

    expect(maraCase.allowances.map((allowance) => allowance.path).toSorted()).toEqual([
      "financialLens.Financial Strength.metrics.cash",
      "financialLens.Financial Strength.metrics.debt",
      "financialLens.Financial Strength.metrics.netDebt",
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.consolidatedNetIncome",
      "financialLens.Quality.metrics.freeCashFlowProxy",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    expect(exactPeriodPaths).toEqual([
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.consolidatedNetIncome",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    expect(
      maraCase.execution.differences.find(
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
      maraCase.execution.differences.find(
        (difference) => difference.path === "financialLens.Quality.metrics.netMargin",
      ),
    ).toMatchObject({
      canonical: {
        // ProfitLoss -1,311.892M over revenue 907.093M; NetIncomeLoss is -1,311.480M.
        value: Number("-1.446259644821424"),
        periodEnd: "2025-12-31",
        periodMonths: 12,
      },
      legacy: null,
    });
    expect(maraCase.execution.projection.statements.revenue).toMatchObject({
      selectedConcept: "Revenues",
    });
    expect(JSON.stringify(maraCase.execution.input.companyFacts)).toContain(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(() => auditOfflineCorpusCase(maraCase)).not.toThrow();
  });

  test("fires the test-only comparator alarm on an injected ROE mismatch", async () => {
    const msftCase = await loadOfflineCorpusCase("msft");
    const quality = msftCase.execution.projection.canonical.financialLens.Quality;
    const roe = quality?.metrics.roe;
    if (quality === undefined || roe === undefined || typeof roe.value !== "number") {
      throw new Error("MSFT golden is missing canonical ROE");
    }
    const mutated = mutateOfflineCorpusCase(msftCase, {
      mutations: [["financialLens.Quality.metrics.roe.value", "add-cent"]],
    });

    expect(() => auditOfflineCorpusCase(mutated)).toThrow(
      /Offline comparator alarm: unclassified msft difference financialLens\.Quality\.metrics\.roe/u,
    );
  });

  test.each([
    ["fundamentalHistory.revenue.cagr.percent", "negate", "revenue.cagr"],
    ["fundamentalHistory.netMargin.ttm.value", "add-cent", "netMargin.ttm"],
    ["fundamentalHistory.operatingCashFlow.ttm.value", "add-cent", "operatingCashFlow.ttm"],
  ] as const)(
    "fires the canonical history property alarm on mutated %s",
    async (path, operation, failure) => {
      const aaplCase = await loadOfflineCorpusCase("aapl");
      expect(() => auditOfflineCorpusCase(aaplCase)).not.toThrow();
      const mutated = mutateOfflineCorpusCase(aaplCase, { mutations: [[path, operation]] });

      expect(() => auditOfflineCorpusCase(mutated)).toThrow(
        new RegExp(
          `canonical history properties failed: .*fundamentalHistory\\.${failure.replace(".", String.raw`\.`)}`,
          "u",
        ),
      );
    },
  );
});
