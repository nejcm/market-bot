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
      aapl: { matched: 74, allowances: 0 },
      msft: { matched: 78, allowances: 0 },
      mara: { matched: 59, allowances: 19 },
      nbis: { matched: 37, allowances: 39 },
      "fpi-quarterly": { matched: 24, allowances: 52 },
      "fpi-ifrs-semiannual": { matched: 33, allowances: 43 },
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
      "support/offline-financial-history-roster.ts",
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

  test("keeps MARA allowances fixture-specific and source-reproduced", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const exactPeriodPaths = maraCase.allowances
      .filter((allowance) => allowance.kind === "canonical-exact-period-correction")
      .map((allowance) => allowance.path)
      .toSorted();

    expect(maraCase.allowances.map((allowance) => allowance.path).toSorted()).toEqual([
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
        value: Number("-1.445805446630059"),
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

  test("re-derives or explicitly reclassifies every history allowance", async () => {
    const cases = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(
          async (fixture) => [fixture, await loadOfflineCorpusCase(fixture)] as const,
        ),
      ),
    );
    const historyAllowances = [...cases.values()]
      .flatMap((corpusCase) => corpusCase.allowances)
      .filter((allowance) => allowance.path.startsWith("fundamentalHistory."));
    const reclassified = historyAllowances.filter(
      (allowance) => allowance.kind === "history-property-not-rederivable",
    );
    const wouldFailReDerivation = historyAllowances.filter((allowance) => {
      const [, seriesKey, field] = allowance.path.split(".");
      const { projection } = cases.get(allowance.fixture)!.execution;
      const canonical = projection.canonical.fundamentalHistory[seriesKey!];
      const legacy = projection.legacy.fundamentalHistory[seriesKey!];
      if (field === "concept") {
        return (
          typeof canonical?.concept === "string" &&
          legacy?.concept === null &&
          canonical.annual.length > 0 &&
          canonical.annual.every((point) => point.form === "20-F") &&
          legacy.annual.length === 0
        );
      }
      const series = [canonical, legacy].filter((value) => value !== undefined);
      return (
        field === "annual" &&
        series.every(
          (value) =>
            (value.cagr === null || value.cagr === undefined) &&
            (value.marginChange === null || value.marginChange === undefined),
        )
      );
    });

    expect(historyAllowances).toHaveLength(89);
    expect(historyAllowances.length - reclassified.length).toBe(61);
    expect(reclassified).toHaveLength(28);
    expect(
      reclassified.map((allowance) => `${allowance.fixture}:${allowance.path}`).toSorted(),
    ).toEqual(
      wouldFailReDerivation.map((allowance) => `${allowance.fixture}:${allowance.path}`).toSorted(),
    );
    expect(
      reclassified.every((allowance) => allowance.justification.includes("B9 cannot re-derive")),
    ).toBe(true);
    expect(
      Object.fromEntries(
        reclassified
          .map((allowance) => allowance.path.split(".").at(-1)!)
          .reduce((counts, field) => counts.set(field, (counts.get(field) ?? 0) + 1), new Map()),
      ),
    ).toEqual({ annual: 10, concept: 18 });
  });

  test("does not permit property-bearing annual or TTM allowances to claim reclassification", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const overriddenMara = mutateOfflineCorpusCase(maraCase, {
      allowanceUpdates: [
        { path: "fundamentalHistory.capex.annual", kind: "history-property-not-rederivable" },
      ],
    });
    const fpiCase = await loadOfflineCorpusCase("fpi-quarterly");
    const overriddenFpi = mutateOfflineCorpusCase(fpiCase, {
      allowanceUpdates: [
        { path: "fundamentalHistory.revenue.ttm", kind: "history-property-not-rederivable" },
      ],
    });

    expect(() => auditOfflineCorpusCase(overriddenMara)).toThrow(
      /mara fundamentalHistory\.capex\.annual is not eligible for history-property reclassification/u,
    );
    expect(() => auditOfflineCorpusCase(overriddenFpi)).toThrow(
      /fpi-quarterly fundamentalHistory\.revenue\.ttm is not eligible for history-property reclassification/u,
    );
  });

  test("rejects dumping an unsupported concept shape into the reclassification bucket", async () => {
    const msftCase = await loadOfflineCorpusCase("msft");
    const { revenue } = msftCase.execution.projection.canonical.fundamentalHistory;
    if (revenue === undefined) {
      throw new Error("MSFT golden is missing revenue history");
    }
    const mutated = mutateOfflineCorpusCase(msftCase, {
      mutations: [["fundamentalHistory.revenue.concept", "set", "InjectedConcept"]],
      allowanceUpdates: [
        {
          path: "fundamentalHistory.revenue.concept",
          kind: "history-property-not-rederivable",
          justification: "Injected concept bucket probe",
        },
      ],
    });

    expect(() => auditOfflineCorpusCase(mutated)).toThrow(
      /msft fundamentalHistory\.revenue\.concept is not eligible for history-property reclassification/u,
    );
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
});
