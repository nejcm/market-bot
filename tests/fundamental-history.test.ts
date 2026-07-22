import { describe, expect, test } from "bun:test";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";

interface FactOverrides {
  readonly form?: "10-K" | "10-Q" | "20-F" | "6-K";
  readonly fp?: string;
  readonly fy?: number;
  readonly filed?: string;
  readonly start?: string;
  readonly end?: string;
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

function latestYtd(overrides: FactOverrides = {}): Record<string, unknown> {
  return fact(130, {
    form: "10-Q",
    fp: "Q3",
    fy: 2025,
    filed: "2025-07-25",
    start: "2024-10-01",
    end: "2025-06-30",
    ...overrides,
  });
}

function priorYtd(overrides: FactOverrides = {}): Record<string, unknown> {
  return fact(105, {
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
  return deriveFundamentalHistory(companyFacts, {
    symbol: "TEST",
    generatedAt: analysisAsOf,
    analysisAsOf,
    sourceId: "extended-sec-edgar-test-fundamentals",
  });
}

function noteStartsWith(notes: readonly string[], prefix: string): boolean {
  return notes.some((note) => note.startsWith(prefix));
}

function comparableHistoryValues(history: ReturnType<typeof deriveFundamentalHistory>) {
  return Object.fromEntries(
    Object.entries(history.series).map(([key, series]) => [
      key,
      {
        annual: series.annual,
        ttm: series.ttm,
        cagr: series.cagr,
        marginChange: series.marginChange,
      },
    ]),
  );
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
    expect(noteStartsWith(history.series.revenue.notes, "annual:restatement-superseded:")).toBe(
      true,
    );
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
    expect(noteStartsWith(history.series.revenue.notes, "annual:transition-period:")).toBe(true);
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

  test("records the fixed diluted-EPS TTM approximation note", () => {
    const history = derive(
      payload({
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
      note: "ttm:missing-full-fy:",
    },
    {
      name: "missing latest YTD",
      facts: annualFacts(),
      note: "ttm:missing-latest-ytd:",
    },
    {
      name: "missing prior-year YTD",
      facts: [...annualFacts(), latestYtd()],
      note: "ttm:missing-prior-ytd:",
    },
    {
      name: "misaligned YTD periods",
      facts: [...annualFacts(), priorYtd(), latestYtd({ fp: "Q2" })],
      note: "ttm:ytd-period-misaligned:",
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
      note: "ttm:fy-ytd-period-misaligned:",
    },
  ])("omits TTM when the $name gate fails", ({ facts, note }) => {
    const history = derive(payload({ Revenues: { facts } }));

    expect(history.series.revenue.ttm).toBeUndefined();
    expect(noteStartsWith(history.series.revenue.notes, note)).toBe(true);
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
    expect(noteStartsWith(history.series.revenue.notes, "annual:excluded-as-of:")).toBe(true);
  });

  test("projects populated canonical statements with legacy value parity", () => {
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
    const legacy = derive(companyFacts);
    const canonical = deriveFinancialStatements(companyFacts, {
      symbol: "TEST",
      generatedAt: "2025-08-01T00:00:00.000Z",
      analysisAsOf: "2025-08-01T00:00:00.000Z",
      sourceId: "extended-sec-edgar-test-fundamentals",
    });
    const migrated = deriveFundamentalHistoryFromFinancialStatements(canonical);
    expect(comparableHistoryValues(migrated)).toEqual(comparableHistoryValues(legacy));
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
