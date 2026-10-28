import { expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { marketSnapshot, verifiedMarketSnapshot } from "./support/fixtures";

function instrumentCommand(argv: readonly string[]): InstrumentCommand {
  const command = parseArgs(argv);
  if (command.jobType !== "equity") {
    throw new Error("not an equity command");
  }
  return command;
}

const AS_OF = "2026-06-22T00:00:00.000Z";
const command = instrumentCommand(["equity", "AAPL", "--deep"]);

function annualFact(value: number, start: string, end: string) {
  return {
    val: value,
    form: "10-K",
    fp: "FY",
    fy: Number(end.slice(0, 4)),
    filed: "2026-05-01",
    start,
    end,
  };
}

function instantFact(value: number, end: string) {
  return {
    val: value,
    form: "10-Q",
    fp: "Q2",
    fy: Number(end.slice(0, 4)),
    filed: "2026-05-01",
    end,
  };
}

function statements(concepts: Record<string, unknown>, analysisAsOf = AS_OF) {
  return deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "AAPL",
      generatedAt: analysisAsOf,
      analysisAsOf,
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

const VALUATION_ITEM: ExtendedEvidence["items"][number] = {
  category: "valuation",
  title: "AAPL Valuation Evidence",
  summary: "Valuation Evidence.",
  sourceIds: ["market-yahoo-equity-aapl"],
  observedAt: AS_OF,
  metrics: {
    enterpriseValue: 985,
    annualizedRevenue: 400,
    evToAnnualizedRevenue: 2.46,
    marketCapToAnnualizedRevenue: 2.5,
    valuationSupportability: "supported",
    revenuePeriodEnd: "2025-12-31",
    revenuePeriodMonths: 12,
  },
};

function evidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "AAPL SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-aapl-filings", "extended-sec-edgar-aapl-fundamentals"],
        observedAt: AS_OF,
        metrics: { revenue: 999, revenuePeriodEnd: "2025-12-31", revenuePeriodMonths: 12 },
      },
      VALUATION_ITEM,
    ],
    gaps: [],
  };
}

function synthetic(concepts: Record<string, unknown>, analysisAsOf = AS_OF) {
  const statementsArtifact = statements(concepts, analysisAsOf);
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    withCanonicalFinancialLensInputs(evidence(), statementsArtifact),
    verifiedMarketSnapshot(),
    analysisAsOf,
    undefined,
    undefined,
    statementsArtifact,
  );
  const input = {
    marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    financialStatements: statementsArtifact,
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { financialLenses: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
    sourceGaps: result.metricSectionGaps ?? [],
  };
  return { input };
}

const REVENUE: Record<string, unknown> = {
  Revenues: { units: { USD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
};
const D7_ALIGNED_MARGIN: Record<string, unknown> = {
  ...REVENUE,
  GrossProfit: { units: { USD: [annualFact(30, "2025-01-01", "2025-12-31")] } },
};

test("cash carries its filed CAD currency instead of the USD quote currency", () => {
  const { input } = synthetic({
    Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { CAD: [instantFact(80, "2025-12-31")] } },
  });
  expect(
    input.financialLenses?.lenses.flatMap((lens) => lens.metrics).find((row) => row.key === "cash"),
  ).toMatchObject({ value: 80, periodEnd: "2025-12-31", currency: "CAD" });
  expect(
    input.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === "cash"),
  ).toMatchObject({ status: "value", value: 80, periodEnd: "2025-12-31", currency: "CAD" });
});

test("cash does not take a currency carried only by an older period", () => {
  const artifact = statements({
    Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
    CashAndCashEquivalentsAtCarryingValue: {
      units: { CAD: [instantFact(70, "2025-12-31"), instantFact(80, "2026-03-31")] },
    },
  });
  const { cash } = artifact.statements.balanceSheet;
  const mixedCurrencies = {
    ...artifact,
    statements: {
      ...artifact.statements,
      balanceSheet: {
        ...artifact.statements.balanceSheet,
        cash: {
          ...cash,
          interim: cash.interim.map((fact) =>
            fact.periodEnd === "2025-12-31" ? { ...fact, currency: "USD" } : fact,
          ),
        },
      },
    },
  };
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    withCanonicalFinancialLensInputs(evidence(), mixedCurrencies),
    verifiedMarketSnapshot(),
    AS_OF,
    undefined,
    undefined,
    mixedCurrencies,
  );
  expect(
    result.artifact?.lenses.flatMap((lens) => lens.metrics).find((row) => row.key === "cash"),
  ).toMatchObject({ value: 80, periodEnd: "2026-03-31", currency: "CAD" });
  expect(
    result.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === "cash"),
  ).toMatchObject({ status: "value", value: 80, periodEnd: "2026-03-31", currency: "CAD" });
});

test("market leverage withholds mismatched currencies and retains quote currency in lineage", () => {
  const { input } = synthetic({
    Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
    LongTermDebt: { units: { CAD: [instantFact(40, "2026-03-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { CAD: [instantFact(10, "2026-03-31")] } },
  });
  for (const id of ["debtToMarketCap", "netDebtToMarketCap"]) {
    const row = input.metricSections
      ?.flatMap((section) => section.metrics)
      .find((metric) => metric.id === id);
    expect(row).toMatchObject({ status: "missing", reason: expect.stringContaining("currency") });
    expect(row?.inputs.find((candidate) => candidate.artifact === "quote")?.currency).toBe("USD");
  }
  expect(
    input.sourceGaps?.find((gap) => gap.source === "financial-lens-financial-strength")?.message,
  ).toContain("currency");
});

test("market leverage permits unknown filed currencies", () => {
  const artifact = statements({
    ...REVENUE,
    LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2026-03-31")] } },
  });
  const unknownCurrency = (key: "cash" | "debt") => ({
    ...artifact.statements.balanceSheet[key],
    interim: artifact.statements.balanceSheet[key].interim.map((fact) => ({
      ...fact,
      currency: null,
    })),
  });
  const unknownStatements = {
    ...artifact,
    statements: {
      ...artifact.statements,
      balanceSheet: {
        ...artifact.statements.balanceSheet,
        debt: unknownCurrency("debt"),
        cash: unknownCurrency("cash"),
      },
    },
  };
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    evidence(),
    undefined,
    AS_OF,
    undefined,
    undefined,
    unknownStatements,
  );
  for (const [id, value] of [
    ["debtToMarketCap", 0.04],
    ["netDebtToMarketCap", 0.03],
  ] as const) {
    expect(
      result.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === id),
    ).toMatchObject({ status: "value", value });
  }
});

test("missing partners preserve independently established not-filed causes", () => {
  const { input } = synthetic({
    ...D7_ALIGNED_MARGIN,
    OperatingIncomeLoss: { units: { USD: [annualFact(20, "2025-01-01", "2025-12-31")] } },
    NetIncomeLoss: { units: { USD: [annualFact(10, "2025-01-01", "2025-12-31")] } },
    NetCashProvidedByUsedInOperatingActivities: {
      units: { USD: [annualFact(30, "2025-01-01", "2025-12-31")] },
    },
    LongTermDebt: { units: { USD: [instantFact(40, "2025-12-31")] } },
    AssetsCurrent: { units: { USD: [instantFact(100, "2025-12-31")] } },
  });
  const rows = input.metricSections?.flatMap((section) => section.metrics) ?? [];
  for (const id of [
    "freeCashFlowProxy",
    "roe",
    "roa",
    "netDebt",
    "netDebtToMarketCap",
    "currentRatio",
    "debtToEquity",
  ]) {
    expect(rows.find((row) => row.id === id)).toMatchObject({
      status: "missing",
      cause: "not-filed",
    });
  }
  expect(input.sourceGaps?.find((gap) => gap.source === "financial-lens-quality")?.triage).toBe(
    "diagnostic",
  );
});
test("newer incomplete debt withholds net debt and preserves its warning from statements", () => {
  const artifact = statements({
    ...REVENUE,
    LongTermDebtCurrent: { units: { USD: [instantFact(10, "2025-12-31")] } },
    LongTermDebtNoncurrent: {
      units: { USD: [instantFact(30, "2025-12-31"), instantFact(50, "2026-03-31")] },
    },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2025-12-31")] } },
  });
  expect(artifact.omissionNotes).toContainEqual(
    expect.objectContaining({
      code: "incomplete-composite-series",
      seriesKey: "debt",
      periodKey: "instant|2026-03-31",
    }),
  );
  const snapshots = [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })];
  const before = addValuationEvidence(
    command,
    snapshots,
    withCanonicalFinancialLensInputs(
      { ...evidence(), items: evidence().items.filter((item) => item.category !== "valuation") },
      artifact,
    ),
    AS_OF,
  ).extendedEvidence;
  const result = addFinancialLensEvidence(
    command,
    snapshots,
    before,
    undefined,
    AS_OF,
    undefined,
    undefined,
    artifact,
  );
  const rows = result.metricSections?.flatMap((section) => section.metrics);
  for (const id of ["netDebt", "netDebtToMarketCap"]) {
    expect(rows?.find((row) => row.id === id)).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("incomplete"),
    });
  }
  expect(rows?.find((row) => row.id === "debt")).toMatchObject({
    status: "missing",
    reason: "incomplete debt as of 2026-03-31",
  });
});

test("stale statement leverage is withheld with a Source Gap while historical margins remain", () => {
  const { input } = synthetic({
    Revenues: { units: { USD: [annualFact(100, "2024-01-01", "2024-12-31")] } },
    GrossProfit: { units: { USD: [annualFact(30, "2024-01-01", "2024-12-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2025-06-30")] } },
    LongTermDebt: { units: { USD: [instantFact(50, "2025-06-30")] } },
  });
  const rows = input.metricSections?.flatMap(({ metrics }) => metrics);
  for (const id of ["netDebt", "debtToMarketCap", "netDebtToMarketCap"]) {
    expect(rows?.find((row) => row.id === id)).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("stale"),
    });
    expect(
      input.extendedEvidence?.items.find(({ category }) => category === "financial-lens")
        ?.metrics?.[id],
    ).toBeUndefined();
    expect(
      input.financialLenses?.lenses.flatMap(({ metrics }) => metrics).some(({ key }) => key === id),
    ).toBe(false);
  }
  expect(rows?.find(({ id }) => id === "grossMargin")).toMatchObject({
    status: "value",
    value: 0.3,
  });
  expect(
    input.sourceGaps.find(({ source }) => source === "financial-lens-financial-strength"),
  ).toMatchObject({ triage: "material", message: expect.stringContaining("stale") });
});

test("debt/market cap needs no same-period cash partner and retains filed and quote citations", () => {
  for (const cash of [undefined, instantFact(10, "2025-12-31")]) {
    const { input } = synthetic({
      ...REVENUE,
      LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
      ...(cash === undefined
        ? {}
        : { CashAndCashEquivalentsAtCarryingValue: { units: { USD: [cash] } } }),
    });
    const row = input.metricSections
      ?.flatMap(({ metrics }) => metrics)
      .find(({ id }) => id === "debtToMarketCap");
    expect(row).toMatchObject({
      status: "value",
      value: 0.04,
      periodEnd: "2026-03-31",
      sourceIds: ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"],
    });
    expect(row?.inputs.map(({ artifact }) => artifact)).toEqual(["quote", "statements"]);
    expect(
      input.extendedEvidence?.items.find(({ category }) => category === "financial-lens")?.metrics,
    ).toMatchObject({ debtToMarketCap: 0.04, debtToMarketCapPeriodEnd: "2026-03-31" });
    expect(
      input.financialLenses?.lenses
        .find(({ name }) => name === "Financial Strength")
        ?.metrics.find(({ key }) => key === "debtToMarketCap"),
    ).toMatchObject({ value: 0.04, sourceIds: row?.sourceIds });
  }
});

test("misaligned annual and unmatched latest periods never fall back to older margins", () => {
  for (const concepts of [
    {
      Revenues: { units: { USD: [annualFact(100, "2024-10-01", "2025-10-31")] } },
      GrossProfit: {
        units: {
          USD: [
            annualFact(10, "2024-10-01", "2025-10-31"),
            annualFact(20, "2024-11-01", "2025-10-31"),
          ],
        },
      },
    },
    {
      Revenues: { units: { USD: [annualFact(100, "2024-01-01", "2024-12-31")] } },
      GrossProfit: {
        units: {
          USD: [
            annualFact(30, "2024-01-01", "2024-12-31"),
            annualFact(35, "2025-01-01", "2025-12-31"),
          ],
        },
      },
    },
  ]) {
    const { input } = synthetic(concepts);
    expect(
      input.metricSections
        ?.find(({ id }) => id === "financial-lens-quality")
        ?.metrics.find(({ id }) => id === "grossMargin"),
    ).toMatchObject({ status: "missing" });
  }
});

test("valuation figures cite their own filing and quote, never the peer-widened item", () => {
  // Operating cash flow gives the Value section the filed input it needs to be emitted.
  const artifact = statements({
    ...REVENUE,
    NetCashProvidedByUsedInOperatingActivities: {
      units: { USD: [annualFact(30, "2025-01-01", "2025-12-31")] },
    },
  });
  const peerIds = ["market-yahoo-equity-nvda", "extended-sec-edgar-nvda-fundamentals"];
  const widened = {
    ...evidence(),
    items: evidence().items.map((item) =>
      item.category === "valuation"
        ? {
            ...item,
            sourceIds: [
              "market-yahoo-equity-aapl",
              "extended-sec-edgar-aapl-filings",
              "extended-sec-edgar-aapl-fundamentals",
              ...peerIds,
            ],
          }
        : item,
    ),
  };
  const rows = (snapshots: Parameters<typeof addFinancialLensEvidence>[1]) => {
    const result = addFinancialLensEvidence(
      command,
      snapshots,
      withCanonicalFinancialLensInputs(widened, artifact),
      verifiedMarketSnapshot(),
      AS_OF,
      undefined,
      undefined,
      artifact,
    );
    return {
      metric: (id: string) =>
        result.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === id),
      gaps: result.metricSectionGaps ?? [],
    };
  };
  const cited = rows([marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })]);
  expect(cited.metric("annualizedRevenue")?.sourceIds).toEqual([
    "extended-sec-edgar-aapl-fundamentals",
  ]);
  for (const id of ["enterpriseValue", "evToAnnualizedRevenue", "marketCapToAnnualizedRevenue"]) {
    expect(cited.metric(id)?.status).toBe("value");
    expect(cited.metric(id)?.sourceIds).toEqual([
      "market-yahoo-equity-aapl",
      "extended-sec-edgar-aapl-fundamentals",
    ]);
  }
  expect(cited.metric("valuationSupportability")?.sourceIds).toEqual(
    widened.items.find(({ category }) => category === "valuation")?.sourceIds,
  );

  const unquoted = rows([]);
  expect(unquoted.metric("evToAnnualizedRevenue")).toMatchObject({
    status: "missing",
    reason: "no cited EV/revenue source",
    sourceIds: [],
  });
  expect(unquoted.metric("annualizedRevenue")?.status).toBe("value");
  expect(unquoted.gaps.find(({ source }) => source === "financial-lens-value")?.message).toContain(
    "no cited EV/revenue source",
  );
});
