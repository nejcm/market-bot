import { expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { reportInvariantViolations } from "../src/corpus/report-invariants";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { postureFrom } from "../src/sources/extended-evidence/financial-lens-inputs";
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

test.each([
  [[true, true, true, true], "criteria-supported"],
  [[true, false, true, true], "criteria-mixed"],
  [[false, false, undefined, false], "criteria-not-supported"],
  [[true, true, undefined, true], "insufficient-data"],
  [[true, false, undefined, true], "criteria-mixed"],
  [[undefined, undefined, undefined, undefined], "insufficient-data"],
] as const)(
  "posture of %p is %s: an unassessed criterion never yields support",
  (criteria, posture) => {
    expect(postureFrom(criteria)).toBe(posture);
  },
);

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

const INCOMPATIBLE = "filed amounts and quote market cap have incompatible currency";
const UNDECLARED = "filed amounts or quote market cap have an undeclared currency";

test("PCF withholds CAD operating cash flow beside a USD market cap", () => {
  const pcf = (unit: string) =>
    synthetic({
      Revenues: { units: { [unit]: [annualFact(100, "2025-01-01", "2025-12-31")] } },
      NetCashProvidedByUsedInOperatingActivities: {
        units: { [unit]: [annualFact(50, "2025-01-01", "2025-12-31")] },
      },
    })
      .input.metricSections?.flatMap((section) => section.metrics)
      .find((metric) => metric.id === "pcfRatio");
  expect(pcf("CAD")).toMatchObject({
    status: "missing",
    reason: INCOMPATIBLE,
  });
  expect(pcf("USD")).toMatchObject({ status: "value", value: 20 });
});

test.each([
  ["both USD", "USD", "USD", undefined],
  ["both CAD", "CAD", "CAD", undefined],
  ["a CAD filing beside a USD quote", "USD", "CAD", INCOMPATIBLE],
  ["an undeclared quote currency", undefined, "USD", UNDECLARED],
  ["an undeclared filed currency", "USD", null, UNDECLARED],
] as const)("market leverage on %s", (_, quoteCurrency, filedCurrency, reason) => {
  const unit = filedCurrency ?? "USD";
  const artifact = statements({
    Revenues: { units: { [unit]: [annualFact(100, "2025-01-01", "2025-12-31")] } },
    LongTermDebt: { units: { [unit]: [instantFact(40, "2026-03-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { [unit]: [instantFact(10, "2026-03-31")] } },
  });
  const withCurrency = (key: "cash" | "debt") => ({
    ...artifact.statements.balanceSheet[key],
    interim: artifact.statements.balanceSheet[key].interim.map((fact) => ({
      ...fact,
      currency: filedCurrency,
    })),
  });
  const filed = {
    ...artifact,
    statements: {
      ...artifact.statements,
      balanceSheet: {
        ...artifact.statements.balanceSheet,
        debt: withCurrency("debt"),
        cash: withCurrency("cash"),
      },
    },
  };
  const result = addFinancialLensEvidence(
    command,
    [
      marketSnapshot({
        sourceId: "market-yahoo-equity-aapl",
        marketCap: 1000,
        identity: quoteCurrency === undefined ? {} : { quoteCurrency },
      }),
    ],
    evidence(),
    undefined,
    AS_OF,
    undefined,
    undefined,
    filed,
  );
  for (const [id, value] of [
    ["debtToMarketCap", 0.04],
    ["netDebtToMarketCap", 0.03],
  ] as const) {
    expect(
      result.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === id),
    ).toMatchObject(
      reason === undefined ? { status: "value", value } : { status: "missing", reason },
    );
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

test("CAD statements without the reporting currency trip currency-mix-without-fx", () => {
  const artifact = statements({
    Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
    LongTermDebt: { units: { CAD: [instantFact(50, "2025-12-31")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { CAD: [instantFact(10, "2025-12-31")] } },
    NetCashProvidedByUsedInOperatingActivities: {
      units: { CAD: [annualFact(20, "2025-01-01", "2025-12-31")] },
    },
  });
  expect(artifact.reportingCurrency).toBe("CAD");
  const snapshots = [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })];
  const base = withCanonicalFinancialLensInputs(
    { ...evidence(), items: evidence().items.filter((item) => item.category !== "valuation") },
    artifact,
  );
  const hits = (reportingCurrency?: string) => {
    const valued = addValuationEvidence(command, snapshots, base, AS_OF, reportingCurrency);
    const { metricSections = [] } = addFinancialLensEvidence(
      command,
      snapshots,
      valued.extendedEvidence,
      verifiedMarketSnapshot(),
      AS_OF,
      undefined,
      undefined,
      artifact,
    );
    return reportInvariantViolations(metricSections).filter(
      ({ invariant }) => invariant === "currency-mix-without-fx",
    );
  };
  expect(hits().map(({ metric }) => metric)).toEqual([
    "enterpriseValue",
    "annualizedRevenue",
    "evToAnnualizedRevenue",
    "marketCapToAnnualizedRevenue",
  ]);
  expect(hits(artifact.reportingCurrency)).toEqual([]);
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

test("lens withholds gross margin and YoY when gross profit stops years before revenue", () => {
  const metric = (concepts: Record<string, unknown>, id: string) =>
    synthetic(concepts)
      .input.metricSections?.flatMap((section) => section.metrics)
      .find((row) => row.id === id);
  const revenue = {
    Revenues: {
      units: {
        USD: [
          annualFact(90, "2017-01-01", "2017-12-31"),
          annualFact(95, "2018-01-01", "2018-12-31"),
          annualFact(100, "2025-01-01", "2025-12-31"),
        ],
      },
    },
  };
  const stale = {
    ...revenue,
    GrossProfit: {
      units: {
        USD: [
          annualFact(27, "2017-01-01", "2017-12-31"),
          annualFact(30, "2018-01-01", "2018-12-31"),
        ],
      },
    },
  };
  const reason =
    "latest gross profit period ends 2018-12-31, more than a year before the newest filed period 2025-12-31";

  for (const id of ["grossMargin", "grossProfitDeltaPercent"]) {
    expect(metric(stale, id)).toMatchObject({ status: "missing", reason });
  }
  expect(metric(D7_ALIGNED_MARGIN, "grossMargin")).toMatchObject({ status: "value", value: 0.3 });
});

// EQIX's continuing-operations diluted EPS stops in FY2018 while total diluted EPS runs on.
test("a stale continuing EPS YoY keeps its scope so it never reads as total diluted EPS YoY", () => {
  const eps = (rows: readonly (readonly [number, string])[]) => ({
    units: {
      "USD/shares": rows.map(([value, year]) =>
        annualFact(value, `${year}-01-01`, `${year}-12-31`),
      ),
    },
  });
  const labels = synthetic({
    Revenues: {
      units: {
        USD: [
          annualFact(95, "2024-01-01", "2024-12-31"),
          annualFact(100, "2025-01-01", "2025-12-31"),
        ],
      },
    },
    EarningsPerShareDiluted: eps([
      [1, "2024"],
      [1.2, "2025"],
    ]),
    IncomeLossFromContinuingOperationsPerDilutedShare: eps([
      [0.8, "2017"],
      [0.9, "2018"],
    ]),
  })
    .input.metricSections?.flatMap((section) => section.metrics)
    .filter(
      (row) => row.id === "dilutedEpsDeltaPercent" || row.id === "continuingDilutedEpsDeltaPercent",
    )
    .map(({ id, label }) => ({ id, label }));

  expect(labels).toEqual([
    { id: "dilutedEpsDeltaPercent", label: "Diluted EPS YoY" },
    { id: "continuingDilutedEpsDeltaPercent", label: "Diluted EPS YoY (continuing operations)" },
  ]);
});

// VKTX 10-Q 0001193125-26-436432 (Q3 2026, filed 2026-10-29) and 10-K 0001193125-26-046876 (FY2025).
const VKTX_AS_OF = "2026-11-20T06:07:17.253Z";

function q3Fact(value: number, end: string, start?: string) {
  return {
    val: value,
    form: "10-Q",
    fp: "Q3",
    fy: 2026,
    filed: "2026-10-29",
    accn: "0001193125-26-436432",
    ...(start === undefined ? {} : { start }),
    end,
  };
}

function vktxConcepts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      units: { USD: [{ ...annualFact(0, "2025-01-01", "2025-12-31"), filed: "2026-02-11" }] },
    },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [q3Fact(677_609_000, "2026-09-30")] } },
    AvailableForSaleSecuritiesDebtSecuritiesCurrent: {
      units: { USD: [q3Fact(282_204_000, "2026-09-30")] },
    },
    ConvertibleLongTermNotesPayable: { units: { USD: [q3Fact(250_656_000, "2026-09-30")] } },
    AssetsCurrent: { units: { USD: [q3Fact(972_999_000, "2026-09-30")] } },
    LiabilitiesCurrent: { units: { USD: [q3Fact(133_897_000, "2026-09-30")] } },
    StockholdersEquity: { units: { USD: [q3Fact(588_600_000, "2026-09-30")] } },
    NetCashProvidedByUsedInOperatingActivities: {
      units: {
        USD: [
          { ...annualFact(-278_685_000, "2025-01-01", "2025-12-31"), filed: "2026-02-11" },
          q3Fact(-193_395_000, "2025-09-30", "2025-01-01"),
          q3Fact(-377_342_000, "2026-09-30", "2026-01-01"),
        ],
      },
    },
    ...overrides,
  };
}

function vktxStrength(
  concepts: Record<string, unknown>,
  edit: (artifact: ReturnType<typeof statements>) => ReturnType<typeof statements> = (a) => a,
) {
  const statementsArtifact = edit(statements(concepts, VKTX_AS_OF));
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 3_295_000_000 })],
    withCanonicalFinancialLensInputs(evidence(), statementsArtifact),
    verifiedMarketSnapshot(),
    VKTX_AS_OF,
    undefined,
    undefined,
    statementsArtifact,
  );
  const section = result.metricSections?.find(({ title }) => title.endsWith("Financial Strength"));
  const metric = (id: string) => section?.metrics.find((candidate) => candidate.id === id);
  const posture = result.artifact?.lenses.find(
    ({ name }) => name === "Financial Strength",
  )?.posture;
  return { metric, posture };
}

test("VKTX Q3 2026: liquidity adds short-term investments, burn reads TTM operating cash flow", () => {
  const { metric, posture } = vktxStrength(vktxConcepts());
  expect(metric("cash")).toMatchObject({ value: 677_609_000, periodEnd: "2026-09-30" });
  expect(metric("liquidity")).toMatchObject({
    status: "value",
    value: 959_813_000,
    currency: "USD",
    periodEnd: "2026-09-30",
  });
  // TTM = FY2025 -278.685M + 9M 2026 -377.342M - 9M 2025 -193.395M.
  expect(metric("trailingOperatingCashFlow")).toMatchObject({
    status: "value",
    value: -462_632_000,
    periodEnd: "2026-09-30",
    periodMonths: 12,
  });
  expect(metric("cashRunwayYears")?.value).toBeCloseTo(959_813_000 / 462_632_000, 12);
  expect(metric("netDebt")).toMatchObject({ value: 250_656_000 - 959_813_000 });
  // Every balance-sheet criterion passes; the operating cash outflow fails self-funding.
  expect(posture).toBe("criteria-mixed");
});

test("liquidity equals cash when no short-term investment concept is tagged", () => {
  const { metric } = vktxStrength(
    vktxConcepts({ AvailableForSaleSecuritiesDebtSecuritiesCurrent: undefined }),
  );
  expect(metric("liquidity")).toMatchObject({ status: "value", value: 677_609_000 });
});

test("positive operating cash flow passes self-funding and emits no runway row", () => {
  const { metric, posture } = vktxStrength(
    vktxConcepts({
      NetCashProvidedByUsedInOperatingActivities: {
        units: {
          USD: [
            { ...annualFact(278_685_000, "2025-01-01", "2025-12-31"), filed: "2026-02-11" },
            q3Fact(193_395_000, "2025-09-30", "2025-01-01"),
            q3Fact(377_342_000, "2026-09-30", "2026-01-01"),
          ],
        },
      },
    }),
  );
  expect(metric("trailingOperatingCashFlow")).toMatchObject({ value: 462_632_000 });
  expect(metric("cashRunwayYears")).toBeUndefined();
  expect(posture).toBe("criteria-supported");
});

test("missing operating cash flow leaves self-funding unassessed, so no support", () => {
  const { metric, posture } = vktxStrength(
    vktxConcepts({ NetCashProvidedByUsedInOperatingActivities: undefined }),
  );
  expect(metric("trailingOperatingCashFlow")?.status).toBe("missing");
  expect(metric("cashRunwayYears")).toBeUndefined();
  expect(posture).toBe("insufficient-data");
});

test.each([
  ["a single quarter", "2026-07-01"],
  ["six months (AMRC-shaped)", "2026-04-01"],
])("%s of operating cash flow without a reconciled TTM is never annualized", (_label, start) => {
  const { metric, posture } = vktxStrength(
    vktxConcepts({
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [q3Fact(-12_000_000, "2026-09-30", start)] },
      },
    }),
  );
  expect(metric("trailingOperatingCashFlow")).toMatchObject({
    status: "missing",
    reason: "latest operating cash flow is neither a full fiscal year nor a reconciled TTM",
  });
  expect(metric("cashRunwayYears")).toBeUndefined();
  expect(posture).toBe("insufficient-data");
});

test("short-term investments in a currency other than cash's withhold liquidity and runway", () => {
  const { metric } = vktxStrength(vktxConcepts(), (artifact) => ({
    ...artifact,
    enterpriseValueBridge: {
      ...artifact.enterpriseValueBridge!,
      shortTermInvestments: artifact.enterpriseValueBridge!.shortTermInvestments.map((fact) => ({
        ...fact,
        currency: "CAD",
      })),
    },
  }));
  expect(metric("liquidity")).toMatchObject({
    status: "missing",
    reason: "short-term investments are not filed in cash's currency USD at 2026-09-30",
  });
  expect(metric("cashRunwayYears")?.status).toBe("missing");
});

test("an interim span that rounds to 12 months is neither a fiscal year nor a TTM", () => {
  const { metric } = vktxStrength(
    vktxConcepts({
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [q3Fact(-50_000_000, "2026-09-30", "2025-10-14")] },
      },
    }),
  );
  expect(metric("trailingOperatingCashFlow")).toMatchObject({
    status: "missing",
    reason: "latest operating cash flow is neither a full fiscal year nor a reconciled TTM",
  });
  expect(metric("cashRunwayYears")).toBeUndefined();
});

test("a TTM whose legs mix continuing and total operations scope is withheld", () => {
  const [fiscalYear, priorYearToDate, latestYearToDate] = (
    vktxConcepts().NetCashProvidedByUsedInOperatingActivities as { units: { USD: unknown[] } }
  ).units.USD;
  const { metric } = vktxStrength(
    vktxConcepts({
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [priorYearToDate, latestYearToDate] },
      },
      NetCashProvidedByUsedInOperatingActivitiesContinuingOperations: {
        units: { USD: [fiscalYear] },
      },
    }),
  );
  expect(metric("trailingOperatingCashFlow")).toMatchObject({
    status: "missing",
    reason: "TTM operating cash flow legs mix continuing-operations and total-operations scope",
  });
  expect(metric("cashRunwayYears")).toBeUndefined();
});

test("continuing-only operating cash flow is scope-labelled and never divides issuer-wide liquidity", () => {
  const { metric } = vktxStrength(
    vktxConcepts({
      NetCashProvidedByUsedInOperatingActivities: undefined,
      NetCashProvidedByUsedInOperatingActivitiesContinuingOperations:
        vktxConcepts().NetCashProvidedByUsedInOperatingActivities,
    }),
  );
  expect(metric("trailingOperatingCashFlow")).toMatchObject({
    label: "Operating cash flow (trailing) (continuing operations)",
  });
  expect(metric("cashRunwayYears")).toMatchObject({
    status: "missing",
    reason:
      "operating cash flow covers continuing operations only while cash + short-term investments is issuer-wide",
  });
});
