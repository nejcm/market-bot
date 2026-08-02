import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  classifyOfflineCorpusDifferences,
  loadOfflineCorpusAllowances,
  loadOfflineCorpusGolden,
  loadOfflineFinancialStatementInput,
  recompareOfflineCorpusProjection,
  runOfflineFinancialStatementCorpus,
} from "./support/offline-financial-statements-corpus";

function exactValueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

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

  test("re-derives or explicitly reclassifies every history allowance", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const historyAllowances = allowances.filter((allowance) =>
      allowance.path.startsWith("fundamentalHistory."),
    );
    const projections = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(
          async (fixture) =>
            [
              fixture,
              runOfflineFinancialStatementCorpus(await loadOfflineFinancialStatementInput(fixture))
                .projection,
            ] as const,
        ),
      ),
    );
    const reclassified = historyAllowances.filter(
      (allowance) => allowance.kind === "history-property-not-rederivable",
    );
    const wouldFailReDerivation = historyAllowances.filter((allowance) => {
      const [, seriesKey, field] = allowance.path.split(".");
      const projection = projections.get(allowance.fixture)!;
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

  test("rejects a history defect even when its whole-value allowance hash is regenerated", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const { grossMargin } = execution.projection.canonical.fundamentalHistory;
    const originalMarginChange = grossMargin?.marginChange;
    if (
      grossMargin === undefined ||
      originalMarginChange === null ||
      originalMarginChange === undefined
    ) {
      throw new Error("MARA golden is missing gross-margin history");
    }
    for (const marginChange of [
      {
        ...originalMarginChange,
        percentagePoints: originalMarginChange.percentagePoints * -1,
      },
      { ...originalMarginChange, years: originalMarginChange.years + 1 },
    ]) {
      const injectedProjection = {
        ...execution.projection,
        canonical: {
          ...execution.projection.canonical,
          fundamentalHistory: {
            ...execution.projection.canonical.fundamentalHistory,
            grossMargin: {
              ...grossMargin,
              marginChange,
            },
          },
        },
      };
      const injected = recompareOfflineCorpusProjection(execution, injectedProjection);
      const changed = injected.differences.find(
        (difference) => difference.path === "fundamentalHistory.grossMargin.marginChange",
      );
      if (changed === undefined) {
        throw new Error("Injected MARA margin-change difference is missing");
      }
      const regeneratedAllowances = allowances.map((allowance) =>
        allowance.fixture === "mara" &&
        allowance.path === "fundamentalHistory.grossMargin.marginChange"
          ? { ...allowance, canonicalSha256: exactValueHash(changed.canonical) }
          : allowance,
      );

      expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).toThrow(
        /unclassified mara difference fundamentalHistory\.grossMargin\.annual: fundamental-history property re-derivation failed/u,
      );
    }
  });

  test("catches a CAGR percent sign flip after its allowance hash is regenerated", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("nbis"),
    );
    const { revenue } = execution.projection.canonical.fundamentalHistory;
    const cagr = revenue?.cagr;
    if (revenue === undefined || cagr === null || cagr === undefined) {
      throw new Error("NBIS golden is missing revenue CAGR history");
    }
    const injected = recompareOfflineCorpusProjection(execution, {
      ...execution.projection,
      canonical: {
        ...execution.projection.canonical,
        fundamentalHistory: {
          ...execution.projection.canonical.fundamentalHistory,
          revenue: { ...revenue, cagr: { ...cagr, percent: cagr.percent * -1 } },
        },
      },
    });
    const changed = injected.differences.find(
      (difference) => difference.path === "fundamentalHistory.revenue.cagr",
    );
    if (changed === undefined) {
      throw new Error("Injected NBIS revenue CAGR difference is missing");
    }
    const regeneratedAllowances = allowances.map((allowance) =>
      allowance.fixture === "nbis" && allowance.path === "fundamentalHistory.revenue.cagr"
        ? { ...allowance, canonicalSha256: exactValueHash(changed.canonical) }
        : allowance,
    );

    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).toThrow(
      /unclassified nbis difference fundamentalHistory\.revenue\.annual: fundamental-history property re-derivation failed/u,
    );
  });

  test("rejects a degenerate single-point margin summary with regenerated hashes", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const { grossMargin } = execution.projection.canonical.fundamentalHistory;
    const point = grossMargin?.annual.at(-1);
    if (grossMargin === undefined || point === undefined) {
      throw new Error("MARA golden is missing gross-margin history");
    }
    const injected = recompareOfflineCorpusProjection(execution, {
      ...execution.projection,
      canonical: {
        ...execution.projection.canonical,
        fundamentalHistory: {
          ...execution.projection.canonical.fundamentalHistory,
          grossMargin: {
            ...grossMargin,
            annual: [point],
            marginChange: {
              percentagePoints: 0,
              years: 0,
              periodStart: point.periodEnd,
              periodEnd: point.periodEnd,
            },
          },
        },
      },
    });
    const regeneratedAllowances = allowances.map((allowance) => {
      if (
        allowance.fixture !== "mara" ||
        (allowance.path !== "fundamentalHistory.grossMargin.annual" &&
          allowance.path !== "fundamentalHistory.grossMargin.marginChange")
      ) {
        return allowance;
      }
      const changed = injected.differences.find((difference) => difference.path === allowance.path);
      if (changed === undefined) {
        throw new Error(`Injected MARA difference is missing: ${allowance.path}`);
      }
      return { ...allowance, canonicalSha256: exactValueHash(changed.canonical) };
    });

    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).toThrow(
      /unclassified mara difference fundamentalHistory\.grossMargin\.annual: fundamental-history property re-derivation failed/u,
    );
  });

  test("rejects malformed raw and derived TTM values with regenerated hashes", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("fpi-quarterly"),
    );
    const { dilutedEps, grossMargin } = execution.projection.canonical.fundamentalHistory;
    const dilutedEpsTtm = dilutedEps?.ttm;
    const grossMarginTtm = grossMargin?.ttm;
    if (
      dilutedEps === undefined ||
      dilutedEpsTtm === null ||
      dilutedEpsTtm === undefined ||
      grossMargin === undefined ||
      grossMarginTtm === null ||
      grossMarginTtm === undefined
    ) {
      throw new Error("FPI quarterly golden is missing TTM history");
    }
    for (const { seriesKey, series, ttm } of [
      {
        seriesKey: "dilutedEps",
        series: dilutedEps,
        ttm: { ...dilutedEpsTtm, form: "20-F" as const },
      },
      {
        seriesKey: "grossMargin",
        series: grossMargin,
        ttm: { ...grossMarginTtm, value: grossMarginTtm.value + 0.01 },
      },
    ] as const) {
      const injected = recompareOfflineCorpusProjection(execution, {
        ...execution.projection,
        canonical: {
          ...execution.projection.canonical,
          fundamentalHistory: {
            ...execution.projection.canonical.fundamentalHistory,
            [seriesKey]: { ...series, ttm },
          },
        },
      });
      const path = `fundamentalHistory.${seriesKey}.ttm`;
      const changed = injected.differences.find((difference) => difference.path === path);
      if (changed === undefined) {
        throw new Error(`Injected FPI quarterly difference is missing: ${path}`);
      }
      const regeneratedAllowances = allowances.map((allowance) =>
        allowance.fixture === "fpi-quarterly" && allowance.path === path
          ? { ...allowance, canonicalSha256: exactValueHash(changed.canonical) }
          : allowance,
      );

      expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).toThrow(
        new RegExp(
          `unclassified fpi-quarterly difference ${path.replaceAll(".", String.raw`\.`)}: fundamental-history property re-derivation failed`,
          "u",
        ),
      );
    }
  });

  test("catches an operating-cash-flow TTM value mutation with regenerated hashes", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("fpi-quarterly"),
    );
    const { operatingCashFlow } = execution.projection.canonical.fundamentalHistory;
    const ttm = operatingCashFlow?.ttm;
    if (operatingCashFlow === undefined || ttm === null || ttm === undefined) {
      throw new Error("FPI quarterly golden is missing operating-cash-flow TTM history");
    }
    const injected = recompareOfflineCorpusProjection(execution, {
      ...execution.projection,
      canonical: {
        ...execution.projection.canonical,
        fundamentalHistory: {
          ...execution.projection.canonical.fundamentalHistory,
          operatingCashFlow: {
            ...operatingCashFlow,
            ttm: { ...ttm, value: ttm.value * 2 },
          },
        },
      },
    });
    const path = "fundamentalHistory.operatingCashFlow.ttm";
    const changed = injected.differences.find((difference) => difference.path === path);
    if (changed === undefined) {
      throw new Error(`Injected FPI quarterly difference is missing: ${path}`);
    }
    const regeneratedAllowances = allowances.map((allowance) =>
      allowance.fixture === "fpi-quarterly" && allowance.path === path
        ? { ...allowance, canonicalSha256: exactValueHash(changed.canonical) }
        : allowance,
    );

    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).toThrow(
      /unclassified fpi-quarterly difference fundamentalHistory\.operatingCashFlow\.ttm: fundamental-history property re-derivation failed/u,
    );
  });

  test("does not permit property-bearing annual or TTM allowances to claim reclassification", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const maraExecution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const invalidMaraAllowances = allowances.map((allowance) =>
      allowance.fixture === "mara" && allowance.path === "fundamentalHistory.capex.annual"
        ? { ...allowance, kind: "history-property-not-rederivable" as const }
        : allowance,
    );
    const fpiExecution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("fpi-quarterly"),
    );
    const invalidFpiAllowances = allowances.map((allowance) =>
      allowance.fixture === "fpi-quarterly" && allowance.path === "fundamentalHistory.revenue.ttm"
        ? { ...allowance, kind: "history-property-not-rederivable" as const }
        : allowance,
    );

    expect(() => classifyOfflineCorpusDifferences(maraExecution, invalidMaraAllowances)).toThrow(
      /mara fundamentalHistory\.capex\.annual is not eligible for history-property reclassification/u,
    );
    expect(() => classifyOfflineCorpusDifferences(fpiExecution, invalidFpiAllowances)).toThrow(
      /fpi-quarterly fundamentalHistory\.revenue\.ttm is not eligible for history-property reclassification/u,
    );
  });

  test("rejects dumping an unsupported concept shape into the reclassification bucket", async () => {
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("msft"),
    );
    const { revenue } = execution.projection.canonical.fundamentalHistory;
    if (revenue === undefined) {
      throw new Error("MSFT golden is missing revenue history");
    }
    const injected = recompareOfflineCorpusProjection(execution, {
      ...execution.projection,
      canonical: {
        ...execution.projection.canonical,
        fundamentalHistory: {
          ...execution.projection.canonical.fundamentalHistory,
          revenue: { ...revenue, concept: "InjectedConcept" },
        },
      },
    });
    const changed = injected.differences.find(
      (difference) => difference.path === "fundamentalHistory.revenue.concept",
    );
    if (changed === undefined) {
      throw new Error("Injected MSFT revenue concept difference is missing");
    }
    const dumpedAllowance = {
      fixture: "msft" as const,
      path: changed.path,
      canonicalSha256: exactValueHash(changed.canonical),
      legacySha256: exactValueHash(changed.legacy),
      kind: "history-property-not-rederivable" as const,
      justification: "Injected concept bucket probe",
    };

    expect(() => classifyOfflineCorpusDifferences(injected, [dumpedAllowance])).toThrow(
      /msft fundamentalHistory\.revenue\.concept is not eligible for history-property reclassification/u,
    );
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

  test("rejects the original truncated-history defect on an allowance-backed path", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const maraExecution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const msftExecution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("msft"),
    );
    const { grossMargin: maraGrossMargin } = maraExecution.projection.canonical.fundamentalHistory;
    const { grossMargin: msftGrossMargin } = msftExecution.projection.canonical.fundamentalHistory;
    const originalMarginChange = msftGrossMargin?.marginChange;
    const annual = msftGrossMargin?.annual.slice(Math.floor(msftGrossMargin.annual.length / 2));
    const first = annual?.at(0);
    const last = annual?.at(-1);
    if (
      maraGrossMargin === undefined ||
      msftGrossMargin === undefined ||
      originalMarginChange === null ||
      originalMarginChange === undefined ||
      annual === undefined ||
      first === undefined ||
      last === undefined
    ) {
      throw new Error("MSFT golden is missing gross-margin history");
    }
    expect(allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.annual",
      }),
    );
    expect(allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.marginChange",
      }),
    );
    expect(() => classifyOfflineCorpusDifferences(maraExecution, allowances)).not.toThrow();

    const injectedMarginChange = {
      percentagePoints: (last.value - first.value) * 100,
      years:
        (Date.parse(last.periodEnd) - Date.parse(first.periodEnd)) /
        (365.2425 * 24 * 60 * 60 * 1000),
      periodStart: first.periodEnd,
      periodEnd: last.periodEnd,
    };
    const injectedProjection = {
      ...maraExecution.projection,
      canonical: {
        ...maraExecution.projection.canonical,
        fundamentalHistory: {
          ...maraExecution.projection.canonical.fundamentalHistory,
          grossMargin: {
            ...maraGrossMargin,
            annual,
            marginChange: injectedMarginChange,
          },
        },
      },
    };
    const injected = recompareOfflineCorpusProjection(maraExecution, injectedProjection);

    expect(originalMarginChange.percentagePoints).toBeCloseTo(3.42, 2);
    expect(originalMarginChange.years).toBeCloseTo(9, 2);
    expect(injectedMarginChange.percentagePoints).toBeCloseTo(-0.46, 2);
    expect(injectedMarginChange.years).toBeCloseTo(4, 2);
    expect(() => classifyOfflineCorpusDifferences(injected, allowances)).toThrow(
      /Offline comparator alarm: unclassified mara difference/u,
    );
  });
});
