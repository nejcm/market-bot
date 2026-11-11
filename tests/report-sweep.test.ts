import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportLedgerRows, sweepReports } from "../scripts/report-sweep";
import { reportInvariantViolations } from "../src/corpus/report-invariants";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
import { valuationMetricSection } from "../src/sources/extended-evidence/valuation-workbench-metrics";
import { marketSnapshot } from "./support/fixtures";

function metric(fields: Record<string, unknown>) {
  return fields as { readonly id?: string };
}

function statementFact(series: string, periodKey: string, value: number) {
  return { artifact: "statements", series, periodKey, periodType: "annual", value };
}

function evidenceKey(key: string, value: number) {
  return { artifact: "evidence", key, value };
}

function filed(currency: string) {
  return [{ id: "revenue", inputs: [{ artifact: "statements", currency }] }];
}

function invariantsOf(
  row: Record<string, unknown>,
  extra: readonly Record<string, unknown>[] = [],
  section = "s",
): readonly string[] {
  return reportInvariantViolations([
    {
      id: section,
      metrics: [metric({ status: "value", ...row }), ...extra.map((fields) => metric(fields))],
    },
  ]).map(({ invariant }) => invariant);
}

function workbenchFact(series: string, value: number, instant = false) {
  const unit = series === "dilutedShares" ? "shares" : "USD";
  return {
    value,
    label: series,
    periodEnd: "2025-12-31",
    publicAt: "2026-02-15",
    currency: series === "dilutedShares" ? null : "USD",
    unit,
    sourceIds: ["filing"],
    lineage: [
      {
        artifact: "statements" as const,
        series,
        label: series,
        value,
        periodType: instant ? ("instant" as const) : ("annual" as const),
        ...(instant ? {} : { periodStart: "2025-01-01" }),
        periodEnd: "2025-12-31",
        periodKey: instant ? "instant|2025-12-31" : "duration:2025-01-01|2025-12-31",
        unit,
        ...(series === "dilutedShares" ? {} : { currency: "USD" }),
        sourceIds: ["filing"],
      },
    ],
  };
}

function fact(series: string, periodEnd: string, value: number, months = 12) {
  return {
    artifact: "statements",
    series,
    value,
    periodType: months === 12 ? "annual" : "interim",
    periodStart: `${String(Number(periodEnd.slice(0, 4)) - 1)}${periodEnd.slice(4)}`,
    periodEnd,
    periodKey: `duration:${String(months)}|${periodEnd}`,
    currency: "USD",
  };
}

function issuerCell(value: string, periodEnd: string) {
  return {
    label: "Profit attributable to owners",
    value,
    artifact: "issuerReport",
    periodType: "interim",
    periodEnd,
    unit: "MYR'000",
    currency: "MYR",
    sourceIds: ["web-issuer"],
  };
}

describe("report sweep", () => {
  test("flags a revenue multiple published beside a sibling the shared verdict withheld", () => {
    const workbench = (priceToSales: Record<string, unknown>) => [
      {
        id: "valuation-workbench-ttm-2025-12-31-2026-04-30",
        metrics: [
          metric({ id: "priceToSales", ...priceToSales }),
          metric({
            id: "enterpriseValueToRevenue",
            status: "not-meaningful",
            reason: "EV/revenue above the 50x ceiling",
          }),
        ],
      },
    ];
    expect(
      reportInvariantViolations(workbench({ status: "value", value: 40 })).map((row) => [
        row.invariant,
        row.metric,
      ]),
    ).toEqual([["revenue-multiple-published-when-not-meaningful", "priceToSales"]]);
    expect(
      reportInvariantViolations(
        workbench({ status: "not-meaningful", reason: "EV/revenue above the 50x ceiling" }),
      ),
    ).toEqual([]);
  });

  test("applies the current valuation verdict to Lens and Framework rows, not historical Workbench rows", () => {
    const sections = [
      {
        id: "financial-lens-value",
        metrics: [
          metric({ id: "valuationSupportability", status: "value", value: "not-meaningful" }),
          metric({ id: "marketCapToAnnualizedRevenue", status: "value", value: 30 }),
        ],
      },
      {
        id: "valuation-workbench-annual-2023-12-31-2024-03-01",
        metrics: [metric({ id: "priceToSales", status: "value", value: 12 })],
      },
    ];
    expect(
      reportInvariantViolations(sections).map((row) => [row.invariant, row.section, row.metric]),
    ).toEqual([
      [
        "revenue-multiple-published-when-not-meaningful",
        "financial-lens-value",
        "marketCapToAnnualizedRevenue",
      ],
    ]);
  });

  test("flags a current revenue multiple on revenue older than 180 days or undated", () => {
    const verdict = {
      id: "evToAnnualizedRevenue",
      status: "not-meaningful",
      reason: "revenue below the 2% of market cap de-minimis floor",
    };
    const sections = (periodEnd?: string) => [
      {
        id: "financial-lens-value",
        metrics: [
          metric({ ...verdict, periodEnd }),
          metric({ id: "marketCapToAnnualizedRevenue", status: "value", value: 18, periodEnd }),
          metric({ id: "evToAnnualizedRevenue", status: "missing", periodEnd }),
        ],
      },
      {
        id: "valuation-workbench-annual-2025-12-31-2026-04-30",
        metrics: [metric({ ...verdict, id: "priceToSales", periodEnd })],
      },
    ];
    const flagged = (periodEnd: string | undefined, generatedAt: string) =>
      reportInvariantViolations(sections(periodEnd), [], undefined, generatedAt)
        .filter(({ invariant }) => invariant === "revenue-multiple-on-stale-revenue")
        .map((row) => `${row.invariant} ${row.section}/${row.metric}: ${row.detail}`);
    expect(flagged("2025-12-31", "2026-06-30T00:00:00.000Z")).toEqual([
      "revenue-multiple-on-stale-revenue financial-lens-value/evToAnnualizedRevenue: not-meaningful 2025-12-31",
      "revenue-multiple-on-stale-revenue financial-lens-value/marketCapToAnnualizedRevenue: value 2025-12-31",
    ]);
    expect(flagged("2025-12-31", "2026-06-29T00:00:00.000Z")).toEqual([]);
    expect(flagged(undefined, "2026-06-29T00:00:00.000Z")).toHaveLength(2);
  });

  test("flags a currency instant published beside a sibling withheld as stale on the same date", () => {
    const sections = [
      {
        id: "financial-lens-financial-strength",
        metrics: [
          metric({
            id: "cash",
            status: "value",
            unit: "currency",
            value: 3.7e9,
            currency: "USD",
            periodEnd: "2025-12-31",
          }),
          metric({ id: "debt", status: "missing", reason: "stale debt as of 2025-12-31" }),
          metric({
            id: "revenue",
            status: "value",
            unit: "currency",
            value: 1,
            currency: "USD",
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections).map((row) => [row.invariant, row.metric])).toEqual([
      ["instant-published-beside-stale-sibling", "cash"],
    ]);
  });

  test("flags YoY and cash conversion published on a base below 2% of same-period revenue", () => {
    const sections = (incomeFy24: number) => [
      {
        id: "financial-lens-growth",
        metrics: [
          metric({
            id: "revenueDeltaPercent",
            status: "value",
            value: 0,
            inputs: [
              statementFact("revenue", "FY2024", 100),
              statementFact("revenue", "FY2025", 100),
            ],
          }),
          metric({
            id: "netIncomeDeltaPercent",
            status: "value",
            value: 1500,
            inputs: [
              statementFact("netIncome", "FY2024", incomeFy24),
              statementFact("netIncome", "FY2025", 30),
            ],
          }),
          metric({
            id: "cashConversion",
            status: "value",
            value: 5,
            inputs: [
              statementFact("operatingCashFlow", "FY2024", 10),
              statementFact("netIncome", "FY2024", incomeFy24),
            ],
          }),
        ],
      },
    ];
    expect(
      reportInvariantViolations(sections(1.9)).map((row) => [row.invariant, row.metric]),
    ).toEqual([
      ["yoy-on-near-zero-base", "netIncomeDeltaPercent"],
      ["watch:yoy-above-1000-percent", "netIncomeDeltaPercent"],
      ["cash-conversion-near-zero-denominator", "cashConversion"],
    ]);
    expect(reportInvariantViolations(sections(2)).map((row) => row.invariant)).toEqual([
      "watch:yoy-above-1000-percent",
    ]);
  });

  test("resolves EPS, evidence-key and issuer-report YoY to their prior-year base", () => {
    const priorProfit = issuerCell("4,500", "2024-06-30");
    const sections = (revenue: Record<string, unknown> = {}) => [
      {
        id: "financial-lens-growth",
        metrics: [
          metric({
            id: "revenueDeltaPercent",
            status: "value",
            value: 0,
            inputs: [
              statementFact("revenue", "FY2024", 100),
              statementFact("revenue", "FY2025", 100),
            ],
          }),
          metric({
            id: "netIncomeDeltaPercent",
            status: "not-meaningful",
            inputs: [
              statementFact("netIncome", "FY2024", 1),
              statementFact("netIncome", "FY2025", 30),
            ],
          }),
          metric({
            id: "dilutedEpsDeltaPercent",
            status: "value",
            value: 900,
            inputs: [
              statementFact("dilutedEps", "FY2024", 0.1),
              statementFact("dilutedEps", "FY2025", 1),
            ],
          }),
        ],
      },
      {
        id: "business-framework-growth",
        metrics: [
          metric({
            id: "revenueDeltaPercent",
            status: "value",
            value: 0,
            periodEnd: "2025-12-31",
            periodMonths: 12,
            inputs: [evidenceKey("revenuePrior", 100), evidenceKey("revenue", 100)],
          }),
          metric({
            id: "operatingIncomeDeltaPercent",
            status: "value",
            value: 900,
            periodEnd: "2025-12-31",
            periodMonths: 12,
            inputs: [evidenceKey("operatingIncomePrior", 1), evidenceKey("operatingIncome", 10)],
          }),
        ],
      },
      {
        id: "issuer-report",
        metrics: [
          metric({
            id: "issuer-report-revenue-quarter-2024-06-30",
            status: "value",
            value: 228_600_000,
            currency: "MYR",
            periodMonths: 3,
            inputs: [{ ...issuerCell("228,600", "2024-06-30"), label: "Revenue" }],
            ...revenue,
          }),
          metric({
            id: "issuer-report-profit-attributable-to-owners-quarter-2024-06-30",
            status: "value",
            value: 4_500_000,
            inputs: [priorProfit],
          }),
          metric({
            id: "issuer-report-profit-attributable-to-owners-yoy-quarter",
            status: "value",
            value: 25,
            periodMonths: 3,
            inputs: [issuerCell("118,580", "2025-06-30"), priorProfit],
          }),
        ],
      },
    ];
    const flagged = (revenue?: Record<string, unknown>) =>
      reportInvariantViolations(sections(revenue))
        .filter((row) => row.invariant === "yoy-on-near-zero-base")
        .map((row) => row.metric);
    const nonIssuer = ["dilutedEpsDeltaPercent", "operatingIncomeDeltaPercent"];
    expect(flagged()).toEqual([
      ...nonIssuer,
      "issuer-report-profit-attributable-to-owners-yoy-quarter",
    ]);
    expect(flagged({ currency: "USD" })).toEqual(nonIssuer);
    expect(flagged({ periodMonths: 6 })).toEqual(nonIssuer);
  });

  test("flags a Lens and Framework pair that disagrees on the same period", () => {
    const sections = [
      {
        id: "financial-lens-value",
        metrics: [
          metric({
            id: "evToAnnualizedRevenue",
            status: "value",
            value: 68,
            periodEnd: "2025-12-31",
            periodMonths: 12,
            priceAsOf: "2026-04-30",
          }),
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "business-framework-valuation",
        metrics: [
          metric({
            id: "evToAnnualizedRevenue",
            status: "not-meaningful",
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections).map((row) => [row.invariant, row.metric])).toEqual([
      ["surfaces-disagree", "evToAnnualizedRevenue"],
    ]);
  });

  test("does not compare a metric across sections that are not an equivalent pair", () => {
    const sections = [
      {
        id: "financial-lens-growth",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "valuation-workbench-ttm-2025-12-31-2026-04-30",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 2,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "business-framework-growth",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 3,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections)).toEqual([]);
  });

  test("flags a price-relative row without its quote date unless periodEnd is that date", () => {
    const quote = {
      artifact: "quote",
      series: "marketCap",
      value: 1e12,
      currency: "USD",
      sourceIds: ["market-aapl"],
    };
    const row = {
      id: "debtToMarketCap",
      unit: "ratio-percent",
      value: 0.1,
      periodEnd: "2025-12-31",
    };
    expect(invariantsOf({ ...row, inputs: [quote] })).toEqual(["price-relative-row-undated"]);
    expect(
      invariantsOf({
        ...row,
        id: "peRatio",
        inputs: [{ artifact: "evidence", key: "trailingPE" }],
      }),
    ).toEqual(["price-relative-row-undated"]);
    expect(invariantsOf({ ...row, priceAsOf: "2026-04-30", inputs: [quote] })).toEqual([]);
    // Another row's priceAsOf on that date does not stand in for the quote's own date.
    expect(
      invariantsOf({ ...row, periodEnd: "2026-04-30", inputs: [quote] }, [
        { id: "trailingPE", status: "value", priceAsOf: "2026-04-30 (fetch time)" },
      ]),
    ).toEqual(["price-relative-row-undated"]);
    expect(invariantsOf({ ...row, unit: "text", inputs: [quote] })).toEqual([]);
    const { periodEnd: _periodEnd, ...undated } = row;
    expect(
      invariantsOf({
        ...undated,
        inputs: [{ artifact: "evidence", key: "trailingPE", sourceIds: ["filing"] }],
      }),
    ).toEqual(["price-relative-row-undated"]);
  });

  test("accepts a same-day PCF the Lens producer leaves undated, by its own quote date", () => {
    const snapshot = marketSnapshot({
      symbol: "TEST",
      marketCap: 1000,
      observedAt: "2026-04-30T21:00:00Z",
      quoteTimeUtc: "2026-03-31T21:00:00Z",
    });
    const { sections } = financialLensMetrics({
      symbol: "TEST",
      snapshot,
      asOf: "2026-04-30T21:00:00Z",
      evidence: {
        instrument: { assetClass: "equity", symbol: "TEST" },
        gaps: [],
        items: [
          {
            category: "sec-edgar",
            title: "SEC",
            summary: "SEC",
            observedAt: "2026-04-30T21:00:00Z",
            sourceIds: ["filing"],
            metrics: {
              operatingCashFlow: 100,
              operatingCashFlowPeriodMonths: 12,
              operatingCashFlowPeriodEnd: "2026-03-31",
            },
          },
        ],
      },
    });
    const pcf = sections.flatMap((section) => section.metrics).find(({ id }) => id === "pcfRatio");
    expect(pcf).toMatchObject({ status: "value", value: 10, periodEnd: "2026-03-31" });
    expect(pcf?.priceAsOf).toBeUndefined();
    expect(reportInvariantViolations(sections, [snapshot])).toEqual([]);
    expect(
      reportInvariantViolations(sections, [{ ...snapshot, quoteTimeUtc: "2026-04-29T21:00:00Z" }]),
    ).toEqual([
      expect.objectContaining({ invariant: "price-relative-row-undated", metric: "pcfRatio" }),
    ]);
  });

  test("flags mixed input currencies without an fx input", () => {
    const inputs = [
      { artifact: "priceHistory", currency: "USD" },
      { artifact: "statements", currency: "CAD" },
    ];
    expect(invariantsOf({ id: "priceToSales", value: 3, inputs })).toEqual([
      "currency-mix-without-fx",
    ]);
    expect(
      invariantsOf({ id: "priceToSales", value: 3, inputs: [...inputs, { artifact: "fx" }] }),
    ).toEqual([]);
  });

  test("flags Valuation Evidence rows beside non-USD statements without fx", () => {
    const valuation = { artifact: "evidence", category: "valuation" };
    expect(
      invariantsOf({ id: "evToRevenue", value: 3, inputs: [valuation] }, filed("CAD")),
    ).toEqual(["currency-mix-without-fx"]);
    expect(
      invariantsOf({ id: "evToRevenue", value: 3, inputs: [valuation] }, filed("USD")),
    ).toEqual([]);
    expect(
      invariantsOf(
        { id: "evToRevenue", value: 3, inputs: [valuation, { artifact: "fx" }] },
        filed("CAD"),
      ),
    ).toEqual([]);
    const yahoo = { artifact: "evidence", category: "yahoo-fundamentals" };
    expect(invariantsOf({ id: "trailingPe", value: 3, inputs: [yahoo] }, filed("CAD"))).toEqual([]);
  });

  test("flags flow inputs from different periods unless a single-period series sits beside a change", () => {
    expect(
      invariantsOf({
        id: "freeCashFlowMargin",
        value: 0.1,
        inputs: [fact("operatingCashFlow", "2025-12-31", 2), fact("revenue", "2024-12-31", 10)],
      }),
    ).toEqual(["flow-inputs-period-mismatch"]);
    expect(
      invariantsOf({
        id: "freeCashFlowMargin",
        value: 0.1,
        inputs: [fact("operatingCashFlow", "2025-12-31", 2), fact("revenue", "2025-12-31", 10, 9)],
      }),
    ).toEqual(["flow-inputs-period-mismatch"]);
    expect(
      invariantsOf({
        id: "phase",
        unit: "text",
        value: "operating-leverage",
        inputs: [
          fact("revenue", "2024-12-31", 8),
          fact("revenue", "2025-12-31", 10),
          fact("operatingIncome", "2025-12-31", 3),
          fact("operatingIncome", "2024-12-31", 2),
          fact("dividendsPaid", "2025-12-31", 1),
        ],
      }),
    ).toEqual([]);
    expect(
      invariantsOf({
        id: "phase",
        unit: "text",
        value: "operating-leverage",
        inputs: [
          fact("revenue", "2024-12-31", 8),
          fact("revenue", "2025-12-31", 10),
          fact("operatingIncome", "2023-12-31", 2),
          fact("operatingIncome", "2024-12-31", 3),
        ],
      }),
    ).toEqual(["flow-inputs-period-mismatch"]);
  });

  test("flags a non-positive valuation multiple but not a negative non-multiple ratio", () => {
    expect(invariantsOf({ id: "forwardPE", unit: "ratio", value: -38.4 })).toEqual([
      "nonpositive-valuation-multiple",
    ]);
    expect(invariantsOf({ id: "forwardPE", unit: "ratio", value: 12 })).toEqual([]);
    expect(invariantsOf({ id: "interestCoverage", unit: "ratio", value: -17.7 })).toEqual([]);
  });

  test("accepts the negative EV/revenue the Workbench publishes when cash exceeds market cap plus debt", () => {
    const { section } = valuationMetricSection({
      symbol: "TEST",
      period: {
        basis: "annual",
        periodEnd: "2025-12-31",
        revenue: workbenchFact("revenue", 100),
        dilutedShares: workbenchFact("dilutedShares", 10),
        cash: workbenchFact("cash", 2000, true),
        debt: workbenchFact("debt", 100, true),
      },
      price: { close: 100, sessionDate: "2026-02-16", currency: "USD", sourceId: "price" },
      reportingCurrency: "USD",
      quoteCurrency: "USD",
    } as Parameters<typeof valuationMetricSection>[0]);
    expect(section.metrics.find(({ id }) => id === "enterpriseValueToRevenue")).toMatchObject({
      status: "value",
      value: -9,
    });
    expect(reportInvariantViolations([section])).toEqual([]);
  });

  test("a Lens ratio joins one period even when one operand spans two", () => {
    const gross = {
      id: "grossMargin",
      unit: "ratio-percent",
      value: 100 / 189,
      inputs: [
        fact("grossProfit", "2026-03-31", 100, 6),
        fact("revenue", "2025-03-31", 189, 6),
        fact("grossProfit", "2025-03-31", 88, 6),
      ],
    };
    expect(invariantsOf(gross, [], "financial-lens-quality")).toEqual([
      "flow-inputs-period-mismatch",
    ]);
    expect(
      invariantsOf(
        { ...gross, id: "grossProfitDeltaPercent", inputs: gross.inputs.toSpliced(1, 1) },
        [],
        "financial-lens-growth",
      ),
    ).toEqual([]);
  });

  test("reads issuer growth bases from the checked figure rows, not the quoted cell text", () => {
    const prior = issuerCell("(87,009)", "2025-09-30");
    const current = issuerCell("254,821", "2026-09-30");
    const figures = [
      { id: "issuer-report-prior", status: "value", value: -87_009_000, inputs: [prior] },
      { id: "issuer-report-current", status: "value", value: 254_821_000, inputs: [current] },
    ];
    const growth = (id: string, inputs: readonly unknown[]) =>
      invariantsOf({ id, value: 3.93, inputs }, figures);
    expect(growth("issuer-report-profit-attributable-to-owners-yoy-ytd", [current, prior])).toEqual(
      ["growth-on-nonpositive-base-or-sign-flip"],
    );
    expect(growth("netIncomeDeltaPercent", [prior, current])).toEqual([
      "growth-on-nonpositive-base-or-sign-flip",
    ]);
    const positivePrior = issuerCell("87,009", "2025-09-30");
    expect(
      invariantsOf(
        { id: "netIncomeDeltaPercent", value: 192.9, inputs: [positivePrior, current] },
        [figures[1]!, { ...figures[0]!, value: 87_009_000, inputs: [positivePrior] }],
      ),
    ).toEqual([]);
  });

  test("flags growth over a non-positive base or across a sign flip", () => {
    const growth = (prior: number, latest: number) =>
      invariantsOf({
        id: "netIncomeDeltaPercent",
        value: 1,
        inputs: [fact("netIncome", "2025-12-31", latest), fact("netIncome", "2024-12-31", prior)],
      });
    expect(growth(-4.1e6, 121.4e6)).toEqual(["growth-on-nonpositive-base-or-sign-flip"]);
    expect(growth(47e6, -37.2e6)).toEqual(["growth-on-nonpositive-base-or-sign-flip"]);
    expect(growth(0, 5)).toEqual(["growth-on-nonpositive-base-or-sign-flip"]);
    expect(growth(47e6, 52e6)).toEqual([]);
    expect(growth(47e6, 0)).toEqual([]);
  });

  test("a consistent report has no violations", () => {
    const sections = [
      {
        id: "a",
        metrics: [metric({ id: "revenue", status: "value", value: 1, periodEnd: "2025-12-31" })],
      },
      {
        id: "b",
        metrics: [metric({ id: "revenue", status: "value", value: 1, periodEnd: "2025-12-31" })],
      },
    ];
    expect(reportInvariantViolations(sections)).toEqual([]);
    expect(reportInvariantViolations([])).toEqual([]);
  });

  test("ledger rows map statuses and keep duplicate metric ids distinct", () => {
    const rows = reportLedgerRows("run-1", "AAA", [
      {
        id: "s",
        metrics: [
          metric({ id: "pe", status: "value", value: 10, periodEnd: "2025-12-31" }),
          metric({ id: "pe", status: "not-meaningful", reason: "negative" }),
          metric({ id: "ps", status: "missing" }),
        ],
      },
    ]);
    expect(rows.map((row) => [row.metric, row.period, row.status])).toEqual([
      ["s/pe", "2025-12-31", "published"],
      ["s/pe#1", "", "not-meaningful"],
      ["s/ps", "", "missing"],
    ]);
  });

  test("an empty runs directory sweeps to nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "report-sweep-"));
    try {
      expect(await sweepReports(dir, join(dir, "replays"))).toMatchObject({
        runs: 0,
        replayed: 0,
        noCapture: [],
        upstreamOnly: [],
        failures: [],
        ledger: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds the ledger from a replayed capture and lists runs without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "report-sweep-"));
    try {
      const runsDir = join(dir, "runs");
      await mkdir(join(runsDir, "captured"), { recursive: true });
      await mkdir(join(runsDir, "uncaptured"));
      // The saved report has no Metric Sections, so every ledger row must come from the replay.
      await writeFile(join(runsDir, "captured", "report.json"), "{}");
      await writeFile(join(runsDir, "uncaptured", "report.json"), "{}");
      await symlink(
        join(import.meta.dir, "fixtures/runs/equity-nbis-deep"),
        join(runsDir, "captured", "replay"),
      );
      const sweep = await sweepReports(runsDir, join(dir, "replays"));
      expect(sweep).toMatchObject({
        runs: 2,
        replayed: 1,
        withSections: 1,
        noCapture: ["uncaptured"],
        failures: [],
      });
      expect(sweep.ledger.length).toBeGreaterThan(0);
      expect(new Set(sweep.ledger.map((row) => `${row.cik} ${row.symbol}`))).toEqual(
        new Set(["captured NBIS"]),
      );
      expect(
        sweep.violationCounts["revenue-multiple-published-when-not-meaningful"],
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("salvages Metric Sections only when every replay miss is final-synthesis", async () => {
    const dir = await mkdtemp(join(tmpdir(), "report-sweep-"));
    try {
      const runsDir = join(dir, "runs");
      const fixtureDir = join(import.meta.dir, "fixtures/runs/equity-bursa-brief");
      const cassette = JSON.parse(await readFile(join(fixtureDir, "llm-cassette.json"), "utf8"));
      // The web-subject-profile miss is swallowed, so that run still reaches the checkpoint.
      for (const [run, droppedStages] of [
        ["synthesis-miss", ["final-synthesis|gpt-6-luna"]],
        ["profile-miss", ["web-subject-profile|gpt-6-luna", "final-synthesis|gpt-6-luna"]],
      ] as const) {
        const replayDir = join(runsDir, run, "replay");
        await cp(fixtureDir, replayDir, { recursive: true });
        await writeFile(join(runsDir, run, "report.json"), "{}");
        const entries = Object.fromEntries(
          Object.entries(cassette.entries).filter(
            ([key]) => !(droppedStages as readonly string[]).includes(key),
          ),
        );
        await writeFile(
          join(replayDir, "llm-cassette.json"),
          JSON.stringify({ ...cassette, entries }),
        );
      }
      const sweep = await sweepReports(runsDir, join(dir, "replays"));
      expect(sweep).toMatchObject({ runs: 2, replayed: 0, withSections: 1 });
      expect(sweep.upstreamOnly).toEqual([
        {
          run: "synthesis-miss",
          error: expect.stringMatching(/^incomplete: .*final-synthesis\|/u),
        },
      ]);
      expect(sweep.failures).toEqual([
        {
          run: "profile-miss",
          error: expect.stringMatching(/^incomplete: .*final-synthesis\|/u),
        },
      ]);
      expect(sweep.ledger.length).toBeGreaterThan(0);
      expect(new Set(sweep.ledger.map((row) => `${row.cik} ${row.symbol}`))).toEqual(
        new Set(["synthesis-miss 0097.KL"]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
