import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { capitalReturnHistory } from "../src/report/equity-reader-statements";
import { renderCapitalReturnHistory } from "../src/report/markdown-equity-sections";
import {
  financialLensMetrics,
  payoutCriterion,
} from "../src/sources/extended-evidence/financial-lens-sections";
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
interface Entry {
  readonly start: string;
  readonly end: string;
  readonly val: number;
  readonly accn: string;
  readonly fy: number;
  readonly fp: string;
  readonly form: string;
  readonly filed: string;
}

function fiscalYearEntry(
  year: number,
  value: number,
  form = "10-K",
  filing = FILINGS[year] ?? {
    accn: `0001260221-${String(year + 1).slice(2)}-000077`,
    filed: `${String(year)}-11-10`,
  },
): Entry {
  return {
    start: `${String(year - 1)}-10-01`,
    end: `${String(year)}-09-30`,
    val: value * M,
    accn: filing.accn,
    fy: Number(filing.filed.slice(0, 4)),
    fp: "FY",
    form,
    filed: filing.filed,
  };
}

// A Q1 10-Q for the fiscal year ending in `year`.
function q1(year: number, value: number, filed: string): Entry {
  return {
    start: `${String(year - 1)}-10-01`,
    end: `${String(year - 1)}-12-31`,
    val: value * M,
    accn: `0001260221-${filed.slice(2, 4)}-000005`,
    fy: year,
    fp: "Q1",
    form: "10-Q",
    filed,
  };
}

function statements(
  concepts: Readonly<Record<string, Values | readonly Entry[]>>,
  { asOf = AS_OF, taxonomy = "us-gaap", unit = "USD" } = {},
) {
  const annualForm = taxonomy === "us-gaap" ? "10-K" : "40-F";
  return deriveFinancialStatements(
    {
      facts: {
        [taxonomy]: Object.fromEntries(
          Object.entries(concepts).map(([concept, values]) => [
            concept,
            {
              units: {
                [unit]: Array.isArray(values)
                  ? values
                  : Object.entries(values).map(([year, value]) =>
                      fiscalYearEntry(Number(year), value, annualForm),
                    ),
              },
            },
          ]),
        ),
      },
    },
    { symbol: "TDG", generatedAt: asOf, analysisAsOf: asOf, sourceId: SOURCE_ID },
  );
}

function tdg(overrides: Readonly<Record<string, Values | readonly Entry[]>> = {}, asOf = AS_OF) {
  return statements(
    {
      PaymentsOfDividends: TDG_DIVIDENDS,
      NetIncomeLoss: TDG_NET_INCOME,
      PaymentsForRepurchaseOfCommonStock: TDG_REPURCHASES,
      NetCashProvidedByUsedInOperatingActivities: { 2024: 2400, 2025: 2700, 2026: 2900 },
      ...overrides,
    },
    { asOf },
  );
}

function strength(artifact: ReturnType<typeof statements>, sic?: string, asOf = AS_OF) {
  const ctx: MetricContext = {
    symbol: "TDG",
    asOf,
    statements: artifact,
    ...(sic === undefined ? {} : { secIssuer: { sic, sourceIds: [SOURCE_ID] } }),
  };
  const lens = financialLensMetrics(ctx);
  const section = lens.lensMetrics["Financial Strength"];
  return {
    payout: (id: string) => section.find((m) => m.id === id),
    criterion: payoutCriterion(ctx, section),
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
      "dividends paid includes any special dividends and dividend equivalents as filed; regular vs special not distinguished",
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

  test("takes the latest five filed fiscal years before looking up the flows (ZS-shaped)", () => {
    const losses = {
      2020: -115,
      2021: -262,
      2022: -390,
      2023: -202,
      2024: -58,
      2025: -41,
      2026: -63,
    };
    const zs = statements({
      NetIncomeLoss: losses,
      PaymentsForRepurchaseOfCommonStock: { 2020: 0, 2021: 0 },
    });
    const recent = capitalReturnHistory(
      statements({
        NetIncomeLoss: losses,
        PaymentsForRepurchaseOfCommonStock: { 2020: 4, 2022: 0 },
      }),
      AS_OF,
    );

    expect(capitalReturnHistory(zs, AS_OF)).toBeUndefined();
    expect(
      recent?.rows.map((row) => [row.period.slice(0, 20), row.shareRepurchases?.value]),
    ).toEqual([
      ["FY ending 2022-09-30", 0],
      ["FY ending 2023-09-30", undefined],
      ["FY ending 2024-09-30", undefined],
      ["FY ending 2025-09-30", undefined],
      ["FY ending 2026-09-30", undefined],
    ]);
    expect(recent?.notes).toEqual([
      "No year-aligned annual dividends paid filed for these fiscal years.",
      "No year-aligned annual share repurchases for the fiscal years ending 2023-09-30, 2024-09-30, 2025-09-30, 2026-09-30.",
    ]);
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
    const { payout, criterion, posture } = strength(tdg());

    expect(payout("payoutRatio")?.value).toBeCloseTo(59 / 2107, 6);
    expect(payout("payoutRatio3y")).toMatchObject({ status: "value", periodEnd: "2026-09-30" });
    expect(Number(payout("payoutRatio3y")?.value)).toBeCloseTo(1.989, 3);
    expect(payout("payoutRatio3y")?.inputs).toHaveLength(6);
    expect(criterion).toBe(false);
    expect(posture).toBe("criteria-mixed");
  });

  test("a regular payer under 80% over three years passes", () => {
    const { payout, criterion } = strength(
      tdg({ PaymentsOfDividends: { 2024: 500, 2025: 600, 2026: 700 } }),
    );

    expect(payout("payoutRatio3y")?.value).toBeCloseTo(1800 / 5895, 6);
    expect(criterion).toBe(true);
  });

  test("a zero latest fiscal year or interim does not hide earlier specials", () => {
    const zeroYear = strength(tdg({ PaymentsOfDividends: { 2024: 2038, 2025: 9629, 2026: 0 } }));
    const asOf = "2027-02-10T00:00:00.000Z";
    const zeroInterim = strength(
      tdg(
        {
          PaymentsOfDividends: [
            ...Object.entries(TDG_DIVIDENDS).map(([year, value]) =>
              fiscalYearEntry(Number(year), value),
            ),
            q1(2027, 0, "2027-02-05"),
          ],
          NetIncomeLoss: [
            ...Object.entries(TDG_NET_INCOME).map(([year, value]) =>
              fiscalYearEntry(Number(year), value),
            ),
            q1(2027, 500, "2027-02-05"),
          ],
        },
        asOf,
      ),
      undefined,
      asOf,
    );

    expect(zeroYear.payout("payoutRatio")?.value).toBe(0);
    expect(zeroYear.payout("payoutRatio3y")?.value).toBeCloseTo(11_667 / 5895, 6);
    expect(zeroYear.criterion).toBe(false);
    expect(zeroInterim.payout("payoutRatio")).toMatchObject({ value: 0, periodMonths: 3 });
    expect(Number(zeroInterim.payout("payoutRatio3y")?.value)).toBeCloseTo(1.989, 3);
    expect(zeroInterim.criterion).toBe(false);
  });

  test("a non-payer is not applicable, whether it tags zeros or nothing", () => {
    const zeros = strength(tdg({ PaymentsOfDividends: { 2024: 0, 2025: 0, 2026: 0 } }));
    const none = strength(tdg({ PaymentsOfDividends: {} }));

    expect(zeros.payout("payoutRatio3y")).toMatchObject({ status: "value", value: 0 });
    expect(zeros.criterion).toBe("not-applicable");
    expect(none.payout("payoutRatio3y")?.status).toBe("missing");
    expect(none.criterion).toBe("not-applicable");
  });

  test("the window ends at the latest filed fiscal year, never an older one", () => {
    const { payout, criterion } = strength(
      tdg({ PaymentsOfDividends: { 2023: 38, 2024: 2038, 2025: 9629 } }),
    );

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends paid for the fiscal year ending 2026-09-30",
      periodEnd: "2026-09-30",
    });
    expect(criterion).toBeUndefined();
  });

  test("a gap year in a special payer's window leaves the check unassessed", () => {
    const { payout, criterion } = strength(tdg({ PaymentsOfDividends: { 2025: 9629, 2026: 59 } }));

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends paid for the fiscal year ending 2024-09-30",
    });
    expect(payout("payoutRatio")?.value).toBeCloseTo(59 / 2107, 6);
    expect(criterion).toBeUndefined();
  });

  test("under three filed fiscal years falls back to the latest annual year, never an interim", () => {
    const asOf = "2026-01-31T00:00:00.000Z";
    const FY2025_10K = { accn: "0001260221-25-000081", filed: "2025-11-12" };
    const short = (extra: readonly Entry[] = [], incomeExtra: readonly Entry[] = []) =>
      strength(
        statements(
          {
            PaymentsOfDividends: [fiscalYearEntry(2025, 150, "10-K", FY2025_10K), ...extra],
            NetIncomeLoss: [fiscalYearEntry(2025, 100, "10-K", FY2025_10K), ...incomeExtra],
          },
          { asOf },
        ),
        undefined,
        asOf,
      );
    const annualOnly = short();
    const withQ1 = short([q1(2026, 2, "2026-01-30")], [q1(2026, 100, "2026-01-30")]);

    expect(annualOnly.payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      cause: "insufficient-history",
      reason:
        "fewer than 3 filed fiscal years; the payout check reads the fiscal year ending 2025-09-30 alone",
    });
    expect(annualOnly.criterion).toBe(false);
    expect(withQ1.payout("payoutRatio")).toMatchObject({ value: 0.02, periodMonths: 3 });
    expect(withQ1.criterion).toBeUndefined();
  });

  test("a window whose next annual filing is overdue is stale", () => {
    const { payout } = strength(
      tdg({
        PaymentsOfDividends: { 2021: 50, 2022: 1091, 2023: 38 },
        NetIncomeLoss: { 2021: 700, 2022: 866, 2023: 1298 },
        PaymentsForRepurchaseOfCommonStock: {},
        NetCashProvidedByUsedInOperatingActivities: {},
      }),
    );

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: "stale fiscal year as of 2023-09-30",
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
    expect(loss.criterion).toBeUndefined();
  });

  test("TDG's 1M of NCI income leaves both scope bounds above 80%, so the check is assessed", () => {
    // Saved run 62e6bd98: ProfitLoss exceeds NetIncomeLoss by the 1M NCI share in FY2024 and FY2026.
    const artifact = tdg({ ProfitLoss: { 2024: 1715, 2025: 2074, 2026: 2108 } });
    const { payout, criterion } = strength(artifact);
    const cumulative = payout("payoutRatio3y");

    expect(cumulative?.status).toBe("value");
    expect(cumulative?.value).toBeCloseTo(11_726 / 5895, 6);
    expect(cumulative?.basis).toContain(
      "dividends as filed under PaymentsOfDividends, which may include distributions to noncontrolling interests; 198.8% against consolidated net income",
    );
    expect(criterion).toBe(false);
    const history = capitalReturnHistory(artifact, AS_OF);
    expect(history?.rows.slice(-3).map((row) => row.payout)).toEqual([
      { status: "withheld" },
      { status: "value", value: 9629 / 2074 },
      { status: "value", value: 59 / 2107 },
    ]);
    expect(history?.notes).toContain(
      "Payout withheld for the fiscal years ending 2024-09-30: noncontrolling interests earned income and PaymentsOfDividends can include distributions to them; dividends and parent net income are not proven to share one scope.",
    );
  });

  test("scope bounds that straddle 80% withhold the check, in the window and in the fallback", () => {
    // 85 paid; parent earns 100, consolidated 110: 85% vs 77.3%.
    const straddle = {
      PaymentsOfDividends: { 2024: 85, 2025: 85, 2026: 85 },
      NetIncomeLoss: { 2024: 100, 2025: 100, 2026: 100 },
      ProfitLoss: { 2024: 110, 2025: 110, 2026: 110 },
    };
    const reason =
      "fiscal year ending 2026-09-30: noncontrolling interests earned income and PaymentsOfDividends can include distributions to them; dividends and parent net income are not proven to share one scope";

    expect(strength(tdg(straddle)).payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason,
    });
    expect(strength(tdg(straddle)).criterion).toBeUndefined();

    const young = (consolidated: number) =>
      strength(
        statements({
          PaymentsOfDividends: { 2025: 85, 2026: 85 },
          NetIncomeLoss: { 2025: 100, 2026: 100 },
          ProfitLoss: { 2026: consolidated },
        }),
      );
    expect(young(110).payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason: `fewer than 3 filed fiscal years; ${reason}`,
    });
    expect(young(110).criterion).toBeUndefined();
    expect(young(101).payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      cause: "insufficient-history",
      reason:
        "fewer than 3 filed fiscal years; the payout check reads the fiscal year ending 2026-09-30 alone; dividends as filed under PaymentsOfDividends, which may include distributions to noncontrolling interests; 84.2% against consolidated net income",
    });
    expect(young(101).criterion).toBe(false);
  });

  test("a generic dividend total beside noncontrolling income is withheld; a common-stock tag is not", () => {
    // Sol's case: 95 paid in total, 35 of it to NCI; parent earns 100 and NCI 50 each year (95% vs 63.3%).
    const nci = {
      NetIncomeLoss: { 2024: 100, 2025: 100, 2026: 100 },
      ProfitLoss: { 2024: 150, 2025: 150, 2026: 150 },
    };
    const total = strength(tdg({ ...nci, PaymentsOfDividends: { 2024: 95, 2025: 95, 2026: 95 } }));
    const common = strength(
      statements({ ...nci, PaymentsOfDividendsCommonStock: { 2024: 60, 2025: 60, 2026: 60 } }),
    );
    const reason =
      "fiscal year ending 2026-09-30: noncontrolling interests earned income and PaymentsOfDividends can include distributions to them; dividends and parent net income are not proven to share one scope";

    expect(total.payout("payoutRatio3y")).toMatchObject({ status: "missing", reason });
    expect(total.criterion).toBeUndefined();
    expect(common.payout("payoutRatio3y")?.value).toBeCloseTo(0.6, 6);
    expect(
      capitalReturnHistory(tdg({ ...nci, PaymentsOfDividends: { 2026: 95 } }), AS_OF)?.notes,
    ).toContain(
      "Payout withheld for the fiscal years ending 2026-09-30: noncontrolling interests earned income and PaymentsOfDividends can include distributions to them; dividends and parent net income are not proven to share one scope.",
    );
  });

  test("IFRS profit includes noncontrolling interests, so BNS-shaped payout is withheld", () => {
    const bns = statements(
      {
        DividendsPaidClassifiedAsFinancingActivities: { 2024: 5670, 2025: 5875, 2026: 6000 },
        ProfitLoss: { 2024: 7892, 2025: 7758, 2026: 8000 },
      },
      { taxonomy: "ifrs-full", unit: "CAD" },
    );
    const { payout, criterion } = strength(bns);

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "missing",
      reason:
        "fiscal year ending 2026-09-30: net income is IFRS ProfitLoss, which includes noncontrolling interests; profit attributable to the parent is not in the statements",
    });
    expect(criterion).toBeUndefined();
    expect(
      capitalReturnHistory(bns, AS_OF)?.rows.every((row) => row.payout?.status === "withheld"),
    ).toBe(true);
  });

  test("a REIT's payout is not assessed on net income; the history table stays and says so", () => {
    // O-shaped: distributions run above net income every year (O fda86bad 3y read 276.7%).
    const reit = tdg({
      PaymentsOfDividends: { 2024: 2600, 2025: 2800, 2026: 2900 },
      NetIncomeLoss: { 2024: 870, 2025: 1000, 2026: 1100 },
    });
    const { payout, criterion } = strength(reit, "6798");

    expect(payout("payoutRatio3y")).toMatchObject({
      status: "not-applicable",
      reason:
        "REIT issuer (SIC 6798): payout is measured against FFO/AFFO, not net income; not assessed",
    });
    expect(payout("payoutRatio")?.status).toBe("value");
    expect(criterion).toBe("not-applicable");
    expect(strength(reit, "6022").criterion).toBe(false);
    expect(strength(reit).criterion).toBe(false);
    const history = capitalReturnHistory(reit, AS_OF, "6798");
    expect(history?.rows.at(-1)?.dividendsPaid?.value).toBe(2900 * M);
    expect(history?.notes).toContain(
      "Payout is against net income, not the FFO/AFFO basis REIT distributions are usually measured on.",
    );
    expect(capitalReturnHistory(reit, AS_OF)?.notes).not.toContain(
      "Payout is against net income, not the FFO/AFFO basis REIT distributions are usually measured on.",
    );
  });
});
