import { describe, expect, test } from "bun:test";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  auditOfflineCorpusCase,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
  runOfflineFinancialStatementCorpus,
} from "../src/corpus/offline-financial-statements-corpus";

describe("offline financial-statement corpus", () => {
  test("locks every issuer projection and classifies every consumer difference offline", async () => {
    const expectedClassifications = {
      aapl: { matched: 16, allowances: 6 },
      msft: { matched: 22, allowances: 4 },
      mara: { matched: 11, allowances: 10 },
      nbis: { matched: 3, allowances: 9 },
      "fpi-quarterly": { matched: 3, allowances: 20 },
      "fpi-ifrs-semiannual": { matched: 4, allowances: 17 },
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
      "../src/corpus/offline-financial-statements-corpus.ts",
      "../src/corpus/offline-financial-corpus-compare.ts",
      "../src/corpus/offline-financial-history-roster.ts",
      "../src/corpus/offline-financial-history-facts.ts",
      "../src/corpus/offline-financial-history-aliases.ts",
      "../src/corpus/offline-financial-lens-properties.ts",
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
      "financialLens.Financial Strength.metrics.cashRunwayYears",
      "financialLens.Financial Strength.metrics.debt",
      "financialLens.Financial Strength.metrics.netDebt",
      "financialLens.Financial Strength.metrics.trailingOperatingCashFlow",
      "financialLens.Quality.metrics.consolidatedNetIncome",
      "financialLens.Quality.metrics.freeCashFlowProxy",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    expect(exactPeriodPaths).toEqual([
      "financialLens.Financial Strength.metrics.cashRunwayYears",
      "financialLens.Financial Strength.metrics.trailingOperatingCashFlow",
      "financialLens.Quality.metrics.consolidatedNetIncome",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    // MARA last tagged GrossProfit for FY2022, so canonical withholds it as stale like legacy.
    expect(
      maraCase.execution.differences.filter(
        (difference) =>
          difference.path.includes("grossMargin") || difference.path.includes("grossProfit"),
      ),
    ).toEqual([]);
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

const fact = (val: number, end: string, accn: string, filed: string) => ({
  val,
  end,
  accn,
  filed,
  form: "10-K",
  fy: Number(end.slice(0, 4)),
  fp: "FY",
});
const prior = (val: number) => fact(val, "2024-12-31", "0001000000-25-000010", "2025-02-15");
const latest = (val: number) => fact(val, "2025-12-31", "0001000000-26-000010", "2026-02-15");

test("a withheld latest debt instant selects no older debt fact", () => {
  const tags = {
    Revenues: [
      { ...prior(900), start: "2024-01-01" },
      { ...latest(1000), start: "2025-01-01" },
    ],
    CashAndCashEquivalentsAtCarryingValue: [prior(150), latest(200)],
    // FY2025's lease-inclusive 950 disputes its own 100 + 800 legs; FY2024's agree.
    LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities: [prior(900), latest(950)],
    LongTermDebtAndCapitalLeaseObligationsCurrent: [prior(100), latest(100)],
    LongTermDebtAndCapitalLeaseObligations: [prior(800), latest(800)],
  };
  const { projection } = runOfflineFinancialStatementCorpus({
    fixture: "withheld-debt",
    symbol: "ACME",
    analysisAsOf: "2026-06-01T00:00:00.000Z",
    sourceId: "acme-sec",
    provenance: { companyFacts: "synthetic", submissions: "synthetic" },
    submissions: undefined,
    companyFacts: {
      facts: {
        "us-gaap": Object.fromEntries(
          Object.entries(tags).map(([concept, usd]) => [concept, { units: { USD: usd } }]),
        ),
      },
    },
  });
  const { debt } = projection.statements;
  expect(debt?.annual.map(({ periodEnd, value }) => [periodEnd, value])).toEqual([
    ["2024-12-31", 900],
  ]);
  expect(debt?.selectedFact).toBeNull();
  expect(debt?.selectedConcept).toBeNull();
});
