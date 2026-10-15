import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { collectedSources } from "./support/fixtures";
import { config, contextWithHistory } from "./support/research-context-helpers";
import { sourceGapScopedReportText } from "../src/domain/source-gaps";
import { expect, test } from "bun:test";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  collectValuationWorkbench,
  type BuildValuationWorkbenchInput,
} from "../src/sources/extended-evidence/valuation-workbench";
import { valuationPeriodInputs } from "./support/valuation-workbench-legacy/valuation-workbench-inputs";
import {
  assertWorkbenchParity,
  assertWorkbenchProperties,
  workbenchWaiverPrecondition,
} from "./support/valuation-workbench-parity";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  loadOfflineCorpusCase,
} from "./support/offline-financial-statements-corpus";

const fact = (value: number, unit: string, instant = false) => ({
  units: {
    [unit]: [
      {
        val: value,
        start: instant ? undefined : "2024-01-01",
        end: "2024-12-31",
        filed: "2025-02-15",
        form: "10-K",
        fy: 2024,
        fp: "FY",
        accn: "test-2024",
      },
    ],
  },
});

function input(): BuildValuationWorkbenchInput {
  const statements = deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: fact(1000, "USD"),
          NetIncomeLoss: fact(100, "USD"),
          EarningsPerShareDiluted: fact(10, "USD/shares"),
          WeightedAverageNumberOfDilutedSharesOutstanding: fact(10, "shares"),
          NetCashProvidedByUsedInOperatingActivities: fact(300, "USD"),
          PaymentsToAcquirePropertyPlantAndEquipment: fact(100, "USD"),
          CashAndCashEquivalentsAtCarryingValue: fact(50, "USD", true),
          LongTermDebt: fact(100, "USD", true),
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: "2025-06-01T00:00:00.000Z",
      analysisAsOf: "2025-06-01T00:00:00.000Z",
      sourceId: "filed",
    },
  );
  return {
    symbol: "TEST",
    generatedAt: statements.generatedAt,
    financialStatements: statements,
    priceHistory: [{ date: "2025-02-18", close: 20 }],
    priceSourceId: "price",
    quoteCurrency: "USD",
  };
}
async function evaluate(value: BuildValuationWorkbenchInput) {
  return collectValuationWorkbench({
    ...value,
    fetchImpl: async () => {
      throw new Error("network forbidden");
    },
  });
}
function counts(value: BuildValuationWorkbenchInput, result: Awaited<ReturnType<typeof evaluate>>) {
  return assertWorkbenchParity(value, result.artifact, result.metricSections, result.sourceGaps);
}

test("workbench comments stay within the two-line budget", async () => {
  const source = await Bun.file(
    new URL("../src/sources/extended-evidence/valuation-workbench.ts", import.meta.url),
  ).text();
  expect(source.match(/(?:^ *\/\/[^\n]*\n){3,}/mu)).toBeNull();
});

test("workbench oracle agrees on all four metrics and refuses forged values, lineage, or missing sections", async () => {
  const value = input();
  const result = await evaluate(value);
  expect(counts(value, result)).toEqual({ W1: 0, W2: 0, W3: 0 });
  expect(
    result.artifact.historicalMultiples.observations[0]?.metrics.priceToFreeCashFlow.value,
  ).toBe(1);
  const missing = { ...result, metricSections: [] };
  expect(() => counts(value, missing)).toThrow();
  for (const field of ["value", "sourceIds", "inputs"] as const) {
    const forged = structuredClone(result);
    const metric = forged.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
    Object.assign(metric, { [field]: field === "value" ? 999 : [] });
    expect(() => counts(value, forged)).toThrow();
  }
});

test.each(["inputs", "observationSources", "artifactSources"] as const)(
  "workbench parity rejects changed %s",
  async (field) => {
    const value = input();
    const result = await evaluate(value);
    const forged = structuredClone(result);
    const observation = forged.artifact.historicalMultiples.observations[0]!;
    if (field === "inputs") {
      Object.assign(observation.inputs.revenue!, { value: 999 });
    } else {
      Object.assign(field === "artifactSources" ? forged.artifact : observation, { sourceIds: [] });
    }
    expect(() => counts(value, forged)).toThrow();
  },
);

test("W1 accepts only a filed non-year-aligned annual input and rejects the same suppression for a full FY", async () => {
  const value = input();
  const statements = structuredClone(value.financialStatements!);
  Object.assign(statements.statements.perShare.dilutedEps.annual[0]!, {
    periodStart: "2023-12-01",
  });
  const changed = { ...value, financialStatements: statements };
  const period = valuationPeriodInputs(statements).periods[0]!;
  expect(workbenchWaiverPrecondition("W1", changed, period, "priceToEarnings")).toBe(true);
  const result = await evaluate(changed);
  expect(counts(changed, result).W1).toBe(1);
  const clean = input();
  expect(
    workbenchWaiverPrecondition(
      "W1",
      clean,
      valuationPeriodInputs(clean.financialStatements!).periods[0]!,
      "priceToEarnings",
    ),
  ).toBe(false);
  const forged = await evaluate(clean);
  Object.assign(forged.artifact.historicalMultiples.observations[0]!.metrics.priceToEarnings, {
    status: "missing",
    reason: "annual input outside 350–380 days",
    value: undefined,
  });
  expect(() => counts(clean, forged)).toThrow();
});

test("W1 rejects an unrelated non-year-aligned fact at the same period end", () => {
  const value = input();
  const statements = structuredClone(value.financialStatements!);
  const selected = statements.statements.perShare.dilutedEps.annual[0]!;
  Object.assign(statements.statements.perShare.dilutedEps, {
    annual: [
      selected,
      {
        ...selected,
        value: 999,
        periodStart: "2023-12-01",
        periodKey: "duration:13|2024-12-31",
      },
    ],
  });
  const changed = { ...value, financialStatements: statements };
  const period = valuationPeriodInputs(statements).periods[0]!;
  expect(period.dilutedEps?.value).toBe(10);
  expect(workbenchWaiverPrecondition("W1", changed, period, "priceToEarnings")).toBe(false);
});

test("W2 requires known incompatible filed currency; unknown currency keeps the ratio", async () => {
  const value = input();
  const statements = structuredClone(value.financialStatements!);
  Object.assign(statements.statements.balanceSheet.cash.annual[0]!, {
    currency: "CAD",
    unit: "CAD",
  });
  const changed = { ...value, financialStatements: statements };
  const result = await evaluate(changed);
  expect(counts(changed, result).W2).toBe(1);
  const clean = input();
  expect(
    workbenchWaiverPrecondition(
      "W2",
      clean,
      valuationPeriodInputs(clean.financialStatements!).periods[0]!,
      "enterpriseValueToRevenue",
    ),
  ).toBe(false);
  const forged = await evaluate(clean);
  Object.assign(
    forged.artifact.historicalMultiples.observations[0]!.metrics.enterpriseValueToRevenue,
    { status: "missing", reason: "incompatible currency", value: undefined },
  );
  expect(() => counts(clean, forged)).toThrow();
  Object.assign(statements.statements.balanceSheet.cash.annual[0]!, {
    currency: null,
    unit: "USD",
  });
  expect(
    (await evaluate({ ...value, financialStatements: statements })).artifact.historicalMultiples
      .observations[0]!.metrics.enterpriseValueToRevenue.status,
  ).toBe("value");
});

test("W3 narrows citations from filed inputs and rejects losing a required filed id even if section and artifact agree", async () => {
  const value = input();
  const statements = structuredClone(value.financialStatements!);
  Object.assign(statements.statements.balanceSheet.cash.annual[0]!, { sourceIds: ["cash-only"] });
  const changed = { ...value, financialStatements: statements };
  const result = await evaluate(changed);
  expect(counts(changed, result).W3).toBe(3);
  const metric = result.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
  Object.assign(metric, {
    sourceIds: ["price"],
    inputs: metric.inputs.filter(({ artifact }) => artifact !== "statements"),
  });
  expect(() => counts(changed, result)).toThrow();
});

test("workbench absence emits a missing section and Source Gap, with one emission policy", async () => {
  const value: BuildValuationWorkbenchInput = {
    symbol: "TEST",
    generatedAt: "2025-06-01T00:00:00.000Z",
    priceHistory: [],
  };
  const result = await evaluate(value);
  expect(result.artifact.historicalMultiples.observations).toEqual([]);
  assertWorkbenchProperties(value, result.artifact, result.metricSections, result.sourceGaps);
  expect(() => assertWorkbenchProperties(value, result.artifact, [], result.sourceGaps)).toThrow();
  expect(() =>
    assertWorkbenchProperties(value, result.artifact, result.metricSections, []),
  ).toThrow();
});

test("missing FCF partners propagate independently filed absence and keep available lineage", async () => {
  const value = input();
  const statements = structuredClone(value.financialStatements!);
  Object.assign(statements.statements.cashFlowStatement.capitalExpenditure, {
    annual: [],
    interim: [],
  });
  Object.assign(statements, { unfiledSeries: ["capitalExpenditure"] });
  const result = await evaluate({ ...value, financialStatements: statements });
  const metric = result.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
  expect(metric).toMatchObject({ status: "missing", cause: "not-filed" });
  expect(metric.inputs.some(({ series }) => series === "operatingCashFlow")).toBe(true);
  expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  Object.assign(statements, { unfiledSeries: [] });
  expect(
    (await evaluate({ ...value, financialStatements: statements })).sourceGaps[0]?.triage,
  ).toBe("material");
});

test("P/FCF keeps zero and negative denominators not meaningful and discloses its price basis", async () => {
  for (const cashFlow of [100, 90]) {
    const value = input();
    const statements = structuredClone(value.financialStatements!);
    Object.assign(statements.statements.cashFlowStatement.operatingCashFlow.annual[0]!, {
      value: cashFlow,
    });
    const result = await evaluate({ ...value, financialStatements: statements });
    const metric = result.artifact.historicalMultiples.observations[0]!.metrics.priceToFreeCashFlow;
    expect(metric).toMatchObject({
      status: "not-meaningful",
      reason: cashFlow === 100 ? "zero-denominator" : "negative-denominator",
    });
    expect(metric.basis).toContain("close 2025-02-18 USD");
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  }
});

test("non-positive denominators remain diagnostic despite incompatible filed currency", async () => {
  for (const denominator of [0, -10]) {
    const value = input();
    const statements = structuredClone(value.financialStatements!);
    Object.assign(statements.statements.perShare.dilutedEps.annual[0]!, {
      value: denominator,
      currency: "CAD",
      unit: "CAD/shares",
    });
    Object.assign(statements.statements.incomeStatement.revenue.annual[0]!, {
      value: denominator,
    });
    Object.assign(statements.statements.balanceSheet.cash.annual[0]!, {
      currency: "CAD",
      unit: "CAD",
    });
    Object.assign(statements.statements.cashFlowStatement.operatingCashFlow.annual[0]!, {
      value: 100 + denominator,
    });
    Object.assign(statements.statements.perShare.dilutedShares.annual[0]!, {
      currency: "CAD",
    });
    const changed = { ...value, financialStatements: statements };
    const result = await evaluate(changed);
    for (const metric of Object.values(
      result.artifact.historicalMultiples.observations[0]!.metrics,
    )) {
      expect(metric).toMatchObject({
        status: "not-meaningful",
        reason: denominator === 0 ? "zero-denominator" : "negative-denominator",
      });
    }
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(counts(changed, result).W2).toBe(0);
  }
});

test("model payloads gain declared gaps while workbench metric values stay outside prompts", async () => {
  const value = input();
  const result = await evaluate({ ...value, priceHistory: [] });
  const command = {
    jobType: "equity",
    assetClass: "equity",
    depth: "deep",
    symbol: "TEST",
  } as const;
  const sources = collectedSources({
    valuationWorkbench: result.artifact,
    metricSections: result.metricSections,
    sourceGaps: result.sourceGaps,
  });
  for (const webSourceText of ["metadata", "profile"] as const) {
    for (const sourceGapView of ["all", "web-gather"] as const) {
      const payload = buildEvidencePayload(
        { includePriorCalibration: false, sourceGapView, webSourceText },
        command,
        sources,
        config,
        contextWithHistory(command),
      );
      expect(payload.sourceGaps).toEqual(
        expect.arrayContaining(result.sourceGaps.map(sourceGapScopedReportText)),
      );
      expect(payload).not.toHaveProperty("metricSections");
      expect(payload).not.toHaveProperty("valuationWorkbench");
    }
  }
});

for (const name of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
  test(`workbench parity over the offline statements branch: ${name}`, async () => {
    const { execution } = await loadOfflineCorpusCase(name);
    const { artifact } = execution;
    const { periods } = valuationPeriodInputs(artifact);
    const value: BuildValuationWorkbenchInput = {
      symbol: artifact.symbol,
      generatedAt: artifact.generatedAt,
      financialStatements: artifact,
      priceHistory: periods.map((period) => ({
        date: Object.values(period)
          .flatMap((row) => (typeof row === "object" && "publicAt" in row ? [row.publicAt] : []))
          .toSorted()
          .at(-1)!,
        close: 100,
      })),
      priceSourceId: `offline-price-${name}`,
      ...(artifact.reportingCurrency === undefined
        ? {}
        : { quoteCurrency: artifact.reportingCurrency }),
    };
    const result = await evaluate(value);
    const accepted = counts(value, result);
    process.stdout.write(
      `P8 corpus ${name} ${JSON.stringify(accepted)} observations=${periods.length}\n`,
    );
  });
}
