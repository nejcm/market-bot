import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { capitalReturnHistory } from "../src/report/equity-reader-statements";
import { renderCapitalReturnHistory } from "../src/report/markdown-equity-sections";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type { MetricContext } from "../src/sources/extended-evidence/metric-engine";
import { researchReport } from "./support/fixtures";

const AS_OF = "2026-11-21T00:00:00.000Z";
const SOURCE_ID = "extended-sec-edgar-tdg-fundamentals";
const M = 1_000_000;

// TDG cash-flow PaymentsOfDividends and NetIncomeLoss, FY ending Sep 30. FY2024–FY2026 as filed in the
// FY2026 10-K (accn 0001260221-26-000077); FY2025 9,629M matches the FY2025 10-K (0001260221-25-000081).
const FILINGS: Readonly<Record<number, { readonly accn: string; readonly filed: string }>> = {
  2022: { accn: "0001260221-24-000083", filed: "2024-11-07" },
  2023: { accn: "0001260221-25-000081", filed: "2025-11-12" },
  2024: { accn: "0001260221-26-000077", filed: "2026-11-10" },
  2025: { accn: "0001260221-26-000077", filed: "2026-11-10" },
  2026: { accn: "0001260221-26-000077", filed: "2026-11-10" },
};
const TDG_DIVIDENDS = { 2022: 1091, 2023: 38, 2024: 2038, 2025: 9629, 2026: 59 };
const TDG_NET_INCOME = { 2022: 866, 2023: 1298, 2024: 1714, 2025: 2074, 2026: 2107 };
const TDG_REPURCHASES = { 2022: 912, 2023: 0, 2024: 0, 2025: 500, 2026: 2750 };

type Values = Readonly<Record<number, number>>;

function flow(values: Values) {
  return {
    units: {
      USD: Object.entries(values).map(([year, value]) => {
        const fy = Number(year);
        const filing = FILINGS[fy]!;
        return {
          start: `${String(fy - 1)}-10-01`,
          end: `${String(fy)}-09-30`,
          val: value * M,
          accn: filing.accn,
          fy: Number(filing.filed.slice(0, 4)),
          fp: "FY",
          form: "10-K",
          filed: filing.filed,
        };
      }),
    },
  };
}

function statements(concepts: Readonly<Record<string, Values>>) {
  return deriveFinancialStatements(
    {
      facts: {
        "us-gaap": Object.fromEntries(
          Object.entries(concepts).map(([concept, values]) => [concept, flow(values)]),
        ),
      },
    },
    { symbol: "TDG", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: SOURCE_ID },
  );
}

function tdg(overrides: Readonly<Record<string, Values>> = {}) {
  return statements({
    PaymentsOfDividends: TDG_DIVIDENDS,
    NetIncomeLoss: TDG_NET_INCOME,
    PaymentsForRepurchaseOfCommonStock: TDG_REPURCHASES,
    NetCashProvidedByUsedInOperatingActivities: { 2024: 2400, 2025: 2700, 2026: 2900 },
    ...overrides,
  });
}

function strength(artifact: ReturnType<typeof statements>) {
  const ctx: MetricContext = { symbol: "TDG", asOf: AS_OF, statements: artifact };
  const lens = financialLensMetrics(ctx);
  return {
    payout: (id: string) => lens.lensMetrics["Financial Strength"].find((m) => m.id === id),
    posture: lens.postures["Financial Strength"],
  };
}

describe("capital return history", () => {
  test("shows TDG's special-dividend years beside the quiet latest year", () => {
    const history = capitalReturnHistory(tdg(), AS_OF);

    expect(
      history?.rows.map((row) => [
        row.period,
        row.dividendsPaid?.value,
        row.shareRepurchases?.value,
        row.payout?.status === "value" ? Number(row.payout.value.toFixed(3)) : row.payout,
      ]),
    ).toEqual([
      ["FY ending 2022-09-30 (latest filed 2024-11-07)", 1091 * M, 912 * M, 1.26],
      ["FY ending 2023-09-30 (latest filed 2025-11-12)", 38 * M, 0, 0.029],
      ["FY ending 2024-09-30 (latest filed 2026-11-10)", 2038 * M, 0, 1.189],
      ["FY ending 2025-09-30 (latest filed 2026-11-10)", 9629 * M, 500 * M, 4.643],
      ["FY ending 2026-09-30 (latest filed 2026-11-10)", 59 * M, 2750 * M, 0.028],
    ]);
    expect(history?.notes).toEqual([]);
    expect(history?.sourceIds).toEqual([SOURCE_ID]);
  });

  test("renders the as-filed basis in research-only wording", () => {
    const report = { ...researchReport(), symbol: "TDG" };
    const markdown = renderCapitalReturnHistory(report, capitalReturnHistory(tdg(), AS_OF)!);

    expect(markdown).toContain(
      "as filed, including any special dividends and dividend equivalents; regular vs special not distinguished",
    );
    expect(markdown).toContain(
      "FY ending 2025-09-30 (latest filed 2026-11-10) | 9.6B | 500.0M | 464.3%",
    );
    expect(violatesResearchOnly(markdown)).toBeNull();
  });

  test("is omitted when neither dividends nor repurchases are filed", () => {
    expect(
      capitalReturnHistory(statements({ NetIncomeLoss: TDG_NET_INCOME }), AS_OF),
    ).toBeUndefined();
    expect(capitalReturnHistory(undefined, AS_OF)).toBeUndefined();
  });

  test("declares unfiled dividends, missing years, zero and loss years", () => {
    const repurchasesOnly = capitalReturnHistory(
      statements({ PaymentsForRepurchaseOfCommonStock: TDG_REPURCHASES }),
      AS_OF,
    );
    const gappy = capitalReturnHistory(
      statements({
        PaymentsOfDividends: { 2024: 0, 2026: 59 },
        NetIncomeLoss: { 2024: -10, 2025: 2074 },
        PaymentsForRepurchaseOfCommonStock: { 2024: 0, 2025: 500, 2026: 2750 },
      }),
      AS_OF,
    );

    expect(repurchasesOnly?.rows.every((row) => row.dividendsPaid === undefined)).toBe(true);
    expect(repurchasesOnly?.notes).toEqual([
      "No year-aligned annual dividends paid filed for these fiscal years.",
    ]);
    expect(gappy?.rows.map((row) => [row.dividendsPaid?.value, row.payout])).toEqual([
      [0, { status: "not-meaningful", reason: "net income is zero or negative" }],
      [undefined, undefined],
      [59 * M, undefined],
    ]);
    expect(gappy?.notes).toEqual([
      "No year-aligned annual dividends paid for the fiscal years ending 2025-09-30.",
      "No year-aligned annual net income for the fiscal years ending 2026-09-30.",
    ]);
  });
});

describe("3y cumulative payout ratio", () => {
  test("fails TDG's payout criterion on FY2024–FY2026 although the latest year alone passes", () => {
    const { payout, posture } = strength(tdg());

    expect(payout("payoutRatio")?.value).toBeCloseTo(59 / 2107, 6);
    expect(payout("payoutRatio3y")).toMatchObject({
      status: "value",
      periodEnd: "2026-09-30",
    });
    expect(payout("payoutRatio3y")?.value).toBeCloseTo(
      (2038 + 9629 + 59) / (1714 + 2074 + 2107),
      6,
    );
    expect(Number(payout("payoutRatio3y")?.value)).toBeCloseTo(1.989, 3);
    expect(payout("payoutRatio3y")?.inputs).toHaveLength(6);
    expect(posture).toBe("criteria-mixed");
  });

  test("a regular payer under 80% over three years passes", () => {
    const { payout, posture } = strength(
      tdg({ PaymentsOfDividends: { 2024: 500, 2025: 600, 2026: 700 } }),
    );

    expect(payout("payoutRatio3y")?.value).toBeCloseTo(1800 / 5895, 6);
    expect(posture).toBe("insufficient-data");
  });

  test("a missing middle year withholds the 3y ratio and falls back to the latest year", () => {
    const { payout, posture } = strength(tdg({ PaymentsOfDividends: { 2024: 2038, 2026: 5000 } }));

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends paid for the fiscal year before 2026-09-30",
    });
    expect(payout("payoutRatio")?.value).toBeCloseTo(5000 / 2107, 6);
    expect(posture).toBe("criteria-mixed");
  });

  test("a window whose next annual filing is overdue is stale", () => {
    const { payout } = strength(tdg({ PaymentsOfDividends: { 2022: 1091, 2023: 38 } }));

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "stale dividends paid as of 2023-09-30",
    });
  });

  test("fewer than three fiscal years withholds the 3y ratio", () => {
    const { payout } = strength(tdg({ PaymentsOfDividends: { 2025: 9629, 2026: 59 } }));

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends paid for the fiscal year before 2025-09-30",
    });
  });

  test("a zero or negative net income year is not meaningful and leaves the criterion unassessed", () => {
    const loss = strength(tdg({ NetIncomeLoss: { ...TDG_NET_INCOME, 2025: -5 } }));
    const zero = strength(tdg({ NetIncomeLoss: { ...TDG_NET_INCOME, 2024: 0 } }));

    expect(loss.payout("payoutRatio3y")).toMatchObject({
      status: "not-meaningful",
      reason: "net income is zero or negative for the fiscal year ending 2025-09-30",
    });
    expect(zero.payout("payoutRatio3y")).toMatchObject({
      status: "not-meaningful",
      reason: "net income is zero or negative for the fiscal year ending 2024-09-30",
    });
    expect(loss.posture).toBe("insufficient-data");
  });

  test("no filed dividends withholds the 3y ratio", () => {
    const { payout } = strength(tdg({ PaymentsOfDividends: {} }));

    expect(payout("payoutRatio3y")?.status).toBe("missing");
  });
});
