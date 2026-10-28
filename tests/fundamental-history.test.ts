import { describe, expect, test } from "bun:test";
import { NEGATIVE_CAPEX_REASON } from "../src/sources/extended-evidence/financial-statement-definitions";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";

interface FactOverrides {
  readonly form?: "10-K" | "10-Q" | "10-K/A" | "10-Q/A" | "20-F" | "6-K";
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly start?: string;
  readonly end?: string;
  readonly accn?: string;
}

function fact(val: number, overrides: FactOverrides = {}): Record<string, unknown> {
  return {
    val,
    form: "10-K",
    fp: "FY",
    fy: 2024,
    filed: "2024-11-01",
    start: "2023-10-01",
    end: "2024-09-30",
    ...overrides,
  };
}

function annualFacts(
  values: readonly number[] = [100, 120, 150],
): readonly Record<string, unknown>[] {
  return values.map((value, index) => {
    const fy = 2022 + index;
    return fact(value, {
      fy,
      filed: `${String(fy)}-11-01`,
      start: `${String(fy - 1)}-10-01`,
      end: `${String(fy)}-09-30`,
    });
  });
}

function latestYtd(overrides: FactOverrides = {}, value = 130): Record<string, unknown> {
  return fact(value, {
    form: "10-Q",
    fp: "Q3",
    fy: 2025,
    filed: "2025-07-25",
    start: "2024-10-01",
    end: "2025-06-30",
    ...overrides,
  });
}

function priorYtd(overrides: FactOverrides = {}, value = 105): Record<string, unknown> {
  return fact(value, {
    form: "10-Q",
    fp: "Q3",
    fy: 2024,
    filed: "2024-07-25",
    start: "2023-10-01",
    end: "2024-06-30",
    ...overrides,
  });
}

function payload(
  concepts: Readonly<
    Record<string, { readonly unit?: string; readonly facts: readonly unknown[] }>
  >,
): unknown {
  return {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries(concepts).map(([concept, entry]) => [
          concept,
          { units: { [entry.unit ?? "USD"]: entry.facts } },
        ]),
      ),
    },
  };
}

function derive(companyFacts: unknown, analysisAsOf = "2025-08-01T00:00:00.000Z") {
  return deriveFundamentalHistoryFromFinancialStatements(
    deriveFinancialStatements(companyFacts, {
      symbol: "TEST",
      generatedAt: analysisAsOf,
      analysisAsOf,
      sourceId: "extended-sec-edgar-test-fundamentals",
    }),
  );
}

function noteStartsWith(notes: readonly string[], prefix: string): boolean {
  return notes.some((note) => note.startsWith(prefix));
}

describe("fundamental history", () => {
  test("dedupes annual periods with the latest-filed restatement", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts([100, 120]),
            fact(140, { filed: "2024-10-20" }),
            fact(150, { filed: "2025-01-15" }),
          ],
        },
      }),
    );

    expect(history.series.revenue.annual.at(-1)?.value).toBe(150);
    expect(history.series.revenue.annual).toHaveLength(3);
  });

  test("dedupes same-filed 10-K and 10-K/A by amendment, not input order", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts([100, 120]),
            fact(100, { filed: "2025-01-15", accn: "0001-original" }),
            fact(110, { form: "10-K/A", filed: "2025-01-15", accn: "0001-amendment" }),
          ],
        },
      }),
    );

    expect(history.series.revenue.annual.at(-1)?.value).toBe(110);
    expect(history.series.revenue.annual).toHaveLength(3);
  });

  test("dedupes same-filed 10-K/A facts by accession, not input order", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts([100, 120]),
            fact(100, { form: "10-K/A", filed: "2025-01-15", accn: "0001" }),
            fact(110, { form: "10-K/A", filed: "2025-01-15", accn: "0002" }),
          ],
        },
      }),
    );

    expect(history.series.revenue.annual.at(-1)?.value).toBe(110);
    expect(history.series.revenue.annual).toHaveLength(3);
  });

  test("dedupes same-filed 10-Q and 10-Q/A YTD by amendment, not input order", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts(),
            priorYtd(),
            latestYtd({ accn: "0001-original" }),
            fact(140, {
              form: "10-Q/A",
              fp: "Q3",
              fy: 2025,
              filed: "2025-07-25",
              start: "2024-10-01",
              end: "2025-06-30",
              accn: "0001-amendment",
            }),
          ],
        },
      }),
    );

    expect(history.series.revenue.ttm?.value).toBe(185);
  });

  test("dedupes same-filed 10-Q/A YTD facts by accession, not input order", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts(),
            priorYtd(),
            fact(130, {
              form: "10-Q/A",
              fp: "Q3",
              fy: 2025,
              filed: "2025-07-25",
              start: "2024-10-01",
              end: "2025-06-30",
              accn: "0001",
            }),
            fact(140, {
              form: "10-Q/A",
              fp: "Q3",
              fy: 2025,
              filed: "2025-07-25",
              start: "2024-10-01",
              end: "2025-06-30",
              accn: "0002",
            }),
          ],
        },
      }),
    );

    expect(history.series.revenue.ttm?.value).toBe(185);
  });

  test("excludes transition-period 10-K facts outside 10 to 14 months", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts(),
            fact(20, {
              fy: 2021,
              filed: "2021-06-15",
              start: "2021-01-01",
              end: "2021-05-31",
            }),
          ],
        },
      }),
    );

    expect(history.series.revenue.annual.map((point) => point.fy)).toEqual([2022, 2023, 2024]);
  });

  test("derives TTM as full FY plus latest YTD less prior-year YTD", () => {
    const history = derive(
      payload({ Revenues: { facts: [...annualFacts(), priorYtd(), latestYtd()] } }),
    );

    expect(history.series.revenue.ttm).toMatchObject({
      value: 175,
      form: "TTM",
      periodStart: "2024-07-01",
      periodEnd: "2025-06-30",
      periodMonths: 12,
    });
  });

  test.each([
    { name: "fiscal year", comparative: { fy: 2025, filed: "2025-07-25" } },
    { name: "fiscal period", comparative: { fy: 2025, fp: "Q1", filed: "2025-04-25" } },
  ])(
    "derives TTM from the latest-filed prior-year YTD whatever its filing $name",
    ({ comparative }) => {
      const companyFacts = payload({
        Revenues: { facts: annualFacts() },
        EarningsPerShareDiluted: {
          unit: "USD/shares",
          facts: [
            ...annualFacts([2, 2.5, 3]),
            priorYtd(),
            { ...priorYtd(comparative), val: 21 },
            latestYtd(),
          ],
        },
      });
      const canonical = deriveFundamentalHistoryFromFinancialStatements(
        deriveFinancialStatements(companyFacts, {
          symbol: "TEST",
          generatedAt: "2025-08-01T00:00:00.000Z",
          analysisAsOf: "2025-08-01T00:00:00.000Z",
          sourceId: "extended-sec-edgar-test-fundamentals",
        }),
      );

      expect(derive(companyFacts).series.dilutedEps.ttm?.value).toBe(3 + 130 - 21);
      expect(canonical.series.dilutedEps.ttm?.value).toBe(3 + 130 - 21);
    },
  );

  test("prefers Apple's current revenue concept over stale legacy revenue facts", () => {
    const companyFacts = payload({
      Revenues: {
        facts: [
          fact(90, {
            fy: 2018,
            filed: "2018-11-01",
            start: "2017-10-01",
            end: "2018-09-29",
          }),
        ],
      },
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        facts: [...annualFacts(), { ...priorYtd(), val: 105 }, { ...latestYtd(), val: 130 }],
      },
      OperatingIncomeLoss: {
        facts: [
          ...annualFacts([20, 25, 30]),
          { ...priorYtd(), val: 18 },
          { ...latestYtd(), val: 25 },
        ],
      },
    });
    const canonical = deriveFinancialStatements(companyFacts, {
      symbol: "AAPL",
      generatedAt: "2025-08-01T00:00:00.000Z",
      analysisAsOf: "2025-08-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    });
    const history = deriveFundamentalHistoryFromFinancialStatements(canonical);

    expect(history.series.revenue.concept).toBe(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(history.series.revenue.annual.map((point) => point.value)).toEqual([100, 120, 150]);
    expect(history.series.revenue.ttm?.value).toBe(175);
    expect(history.series.operatingMargin.annual.map((point) => point.value)).toEqual([
      0.2,
      25 / 120,
      0.2,
    ]);
    expect(history.series.operatingMargin.ttm?.value).toBe(37 / 175);
  });

  test("records the fixed diluted-EPS TTM approximation note", () => {
    const history = derive(
      payload({
        Revenues: { facts: annualFacts() },
        EarningsPerShareDiluted: {
          unit: "USD/shares",
          facts: [...annualFacts([2, 2.5, 3]), priorYtd(), latestYtd()],
        },
      }),
    );

    expect(history.series.dilutedEps.ttm).toBeDefined();
    expect(noteStartsWith(history.series.dilutedEps.notes, "ttm:eps-approximation:")).toBe(true);
  });

  test.each([
    {
      name: "missing full FY",
      facts: [priorYtd(), latestYtd()],
    },
    {
      name: "missing latest YTD",
      facts: annualFacts(),
    },
    {
      name: "missing prior-year YTD",
      facts: [...annualFacts(), latestYtd()],
    },
    {
      name: "misaligned YTD periods",
      facts: [...annualFacts(), priorYtd(), latestYtd({ start: "2025-01-01" })],
    },
    {
      name: "misaligned FY and YTD periods",
      facts: [
        annualFacts()[0]!,
        annualFacts()[1]!,
        fact(150, { start: "2023-11-15" }),
        priorYtd(),
        latestYtd(),
      ],
    },
  ])("omits TTM when the $name gate fails", ({ facts }) => {
    const history = derive(payload({ Revenues: { facts } }));

    expect(history.series.revenue.ttm).toBeUndefined();
    expect(noteStartsWith(history.series.revenue.notes, "ttm:unreconciled:")).toBe(true);
  });

  test("pairs free-cash-flow proxy points only on matching period ends", () => {
    const history = derive(
      payload({
        NetCashProvidedByUsedInOperatingActivities: { facts: annualFacts([50, 60, 70]) },
        PaymentsToAcquirePropertyPlantAndEquipment: {
          facts: [annualFacts([10, 12, 15])[0]!, annualFacts([10, 12, 15])[2]!],
        },
      }),
    );

    expect(
      history.series.freeCashFlowProxy.annual.map((point) => [point.periodEnd, point.value]),
    ).toEqual([
      ["2022-09-30", 40],
      ["2024-09-30", 55],
    ]);
    expect(noteStartsWith(history.series.freeCashFlowProxy.notes, "annual:unmatched-period:")).toBe(
      true,
    );
  });

  test("withholds free-cash-flow proxy points where capex is filed negative", () => {
    const history = derive(
      payload({
        NetCashProvidedByUsedInOperatingActivities: { facts: annualFacts([50, 60, 70]) },
        PaymentsToAcquirePropertyPlantAndEquipment: { facts: annualFacts([10, -12, 0]) },
      }),
    );

    expect(
      history.series.freeCashFlowProxy.annual.map((point) => [point.periodEnd, point.value]),
    ).toEqual([
      ["2022-09-30", 40],
      ["2024-09-30", 70],
    ]);
    expect(history.series.freeCashFlowProxy.notes).toContain(
      `annual:negative-capex: 2023-09-30 omitted; ${NEGATIVE_CAPEX_REASON}`,
    );
  });

  test.each([
    { latest: 5, prior: 4, expected: 79 },
    { latest: -5, prior: 4, expected: undefined },
    { latest: 5, prior: -4, expected: undefined },
    { latest: 5, prior: 30, expected: undefined },
  ])(
    "TTM free-cash-flow proxy with capex YTD $latest / prior $prior on both paths",
    ({ latest, prior, expected }) => {
      const facts = payload({
        NetCashProvidedByUsedInOperatingActivities: {
          facts: [...annualFacts([50, 60, 70]), latestYtd(), priorYtd()],
        },
        PaymentsToAcquirePropertyPlantAndEquipment: {
          facts: [...annualFacts([10, 12, 15]), latestYtd({}, latest), priorYtd({}, prior)],
        },
      });
      const canonical = deriveFundamentalHistoryFromFinancialStatements(
        deriveFinancialStatements(facts, {
          symbol: "TEST",
          generatedAt: "2025-08-01T00:00:00.000Z",
          analysisAsOf: "2025-08-01T00:00:00.000Z",
          sourceId: "extended-sec-edgar-test-fundamentals",
        }),
      );
      for (const history of [derive(facts), canonical]) {
        expect(history.series.freeCashFlowProxy.ttm?.value).toBe(expected);
        const note = `ttm:negative-capex: 2025-06-30 omitted; ${NEGATIVE_CAPEX_REASON}`;
        expect(history.series.capex.notes.includes(note)).toBe(expected === undefined);
        expect(history.series.freeCashFlowProxy.notes.includes(note)).toBe(expected === undefined);
      }
    },
  );

  test("CAGR counts whole 52/53-week fiscal years: AMD FY2020-FY2025 revenue", () => {
    const years: readonly (readonly [string, string, number])[] = [
      ["2018-12-30", "2019-12-28", 6_731_000_000],
      ["2019-12-29", "2020-12-26", 9_763_000_000],
      ["2020-12-27", "2021-12-25", 16_434_000_000],
      ["2021-12-26", "2022-12-31", 23_601_000_000],
      ["2023-01-01", "2023-12-30", 22_680_000_000],
      ["2023-12-31", "2024-12-28", 25_785_000_000],
      ["2024-12-29", "2025-12-27", 34_639_000_000],
    ];
    const facts = payload({
      Revenues: {
        facts: years.map(([start, end, value]) =>
          fact(value, {
            fy: Number(end.slice(0, 4)),
            filed: `${String(Number(end.slice(0, 4)) + 1)}-02-01`,
            start,
            end,
          }),
        ),
      },
    });
    const canonical = deriveFundamentalHistoryFromFinancialStatements(
      deriveFinancialStatements(facts, {
        symbol: "TEST",
        generatedAt: "2026-03-01T00:00:00.000Z",
        analysisAsOf: "2026-03-01T00:00:00.000Z",
        sourceId: "extended-sec-edgar-test-fundamentals",
      }),
    );
    for (const history of [derive(facts, "2026-03-01T00:00:00.000Z"), canonical]) {
      const { cagr } = history.series.revenue;
      expect(cagr).toMatchObject({ years: 5, periodStart: "2020-12-26", periodEnd: "2025-12-27" });
      // (34,639 / 9,763)^(1/5) - 1
      expect(cagr?.percent).toBeCloseTo(28.824, 3);
    }
  });

  test("refuses CAGR when an endpoint is not a complete fiscal year", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts([100, 120]),
            fact(150, { fy: 2024, filed: "2024-11-01", start: "2023-12-01", end: "2024-09-30" }),
          ],
        },
      }),
    );

    expect(history.series.revenue.cagr).toBeUndefined();
    expect(noteStartsWith(history.series.revenue.notes, "cagr:incomplete-fiscal-year:")).toBe(true);
  });

  test("refuses CAGR across a fiscal-year-end transition with an omitted stub", () => {
    const years: readonly (readonly [string, string, number])[] = [
      ["2018-01-01", "2018-12-31", 100],
      ["2019-01-01", "2019-12-31", 110],
      ["2020-01-01", "2020-12-31", 120],
      ["2021-01-01", "2021-12-31", 130],
      ["2022-01-01", "2022-12-31", 140],
      ["2023-01-01", "2023-06-30", 70],
      ["2023-07-01", "2024-06-30", 160],
    ];
    const facts = payload({
      Revenues: {
        facts: years.map(([start, end, value]) =>
          fact(value, {
            fy: Number(end.slice(0, 4)),
            filed: `${end.slice(0, 4)}-09-01`,
            start,
            end,
          }),
        ),
      },
    });
    const canonical = deriveFundamentalHistoryFromFinancialStatements(
      deriveFinancialStatements(facts, {
        symbol: "TEST",
        generatedAt: "2025-03-01T00:00:00.000Z",
        analysisAsOf: "2025-03-01T00:00:00.000Z",
        sourceId: "extended-sec-edgar-test-fundamentals",
      }),
    );
    for (const history of [derive(facts, "2025-03-01T00:00:00.000Z"), canonical]) {
      expect(history.series.revenue.cagr).toBeUndefined();
      expect(noteStartsWith(history.series.revenue.notes, "cagr:fiscal-year-transition:")).toBe(
        true,
      );
    }
  });

  test("refuses CAGR when either endpoint is non-positive", () => {
    const history = derive(payload({ Revenues: { facts: annualFacts([100, 120, -5]) } }));

    expect(history.series.revenue.cagr).toBeUndefined();
    expect(noteStartsWith(history.series.revenue.notes, "cagr:non-positive-endpoint:")).toBe(true);
  });

  test("filters facts by the as-of cutoff before restatement dedupe", () => {
    const history = derive(
      payload({
        Revenues: {
          facts: [
            ...annualFacts([100, 120]),
            fact(140, { filed: "2025-01-15" }),
            fact(175, { filed: "2025-09-01" }),
          ],
        },
      }),
    );

    expect(history.series.revenue.annual.at(-1)?.value).toBe(140);
  });

  test("projects populated canonical statements into history", () => {
    const companyFacts = payload({
      Revenues: { facts: [...annualFacts(), priorYtd(), latestYtd()] },
      GrossProfit: { facts: [...annualFacts([40, 50, 60]), priorYtd(), latestYtd()] },
      OperatingIncomeLoss: { facts: [...annualFacts([20, 25, 30]), priorYtd(), latestYtd()] },
      NetIncomeLoss: { facts: [...annualFacts([15, 18, 21]), priorYtd(), latestYtd()] },
      EarningsPerShareDiluted: {
        unit: "USD/shares",
        facts: [...annualFacts([2, 2.5, 3]), priorYtd(), latestYtd()],
      },
      NetCashProvidedByUsedInOperatingActivities: {
        facts: [...annualFacts([50, 60, 70]), priorYtd(), latestYtd()],
      },
      PaymentsToAcquirePropertyPlantAndEquipment: {
        facts: [...annualFacts([10, 12, 15]), priorYtd(), latestYtd()],
      },
    });
    const { series } = derive(companyFacts);

    expect(series.revenue.annual.map((point) => point.value)).toEqual([100, 120, 150]);
    expect(series.revenue.ttm?.value).toBe(175);
    expect(series.freeCashFlowProxy.annual.map((point) => point.value)).toEqual([40, 48, 55]);
    expect(series.freeCashFlowProxy.ttm?.value).toBe(55);
    expect(series.grossMargin.annual.map((point) => point.value)).toEqual([0.4, 50 / 120, 0.4]);
  });

  test("projects 20-F annual history from canonical statements", () => {
    const companyFacts = payload({
      Revenues: {
        facts: annualFacts().map((entry) => ({
          ...entry,
          form: "20-F",
        })),
      },
    });
    const canonical = deriveFinancialStatements(companyFacts, {
      symbol: "FPI",
      generatedAt: "2025-08-01T00:00:00.000Z",
      analysisAsOf: "2025-08-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-fpi-fundamentals",
    });
    const migrated = deriveFundamentalHistoryFromFinancialStatements(canonical);

    expect(migrated.series.revenue.annual).toHaveLength(3);
    expect(migrated.series.revenue.annual.every((point) => point.form === "20-F")).toBe(true);
  });
});
