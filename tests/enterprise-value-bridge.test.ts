import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtendedEvidence } from "../src/domain/evidence";
import {
  type BridgeFact,
  resolveEnterpriseValueBridge,
} from "../src/sources/extended-evidence/enterprise-value-bridge";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { readFinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { derivePeerImpliedRange } from "../src/sources/extended-evidence/valuation-comps";
import { compsCashLabel } from "../src/sources/extended-evidence/valuation-comps-contract";
import { targetRow } from "../src/sources/extended-evidence/valuation-comps-rows";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { loadRunArtifact } from "../src/run-artifacts";
import { marketSnapshot, researchReport } from "./support/fixtures";

const ANALYSIS_AS_OF = "2026-10-24T00:00:00.000Z";
const M = 1_000_000;

type Facts = Readonly<Record<string, readonly Record<string, unknown>[]>>;

function fact(
  value: number,
  end: string,
  filed: string,
  accn: string,
  form = "10-Q",
): Record<string, unknown> {
  return { val: value, form, fy: Number(end.slice(0, 4)), fp: "Q2", filed, end, accn };
}

function companyFacts(gaap: Facts) {
  const revenue = {
    val: 30_000 * M,
    form: "10-K",
    fy: 2025,
    fp: "FY",
    filed: "2026-02-04",
    start: "2025-01-01",
    end: "2025-12-27",
    accn: "revenue",
  };
  return {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries({ Revenues: [revenue], ...gaap }).map(([concept, usd]) => [
          concept,
          { units: { USD: usd } },
        ]),
      ),
    },
  };
}

function secEvidence(metrics: Record<string, number | string>): ExtendedEvidence {
  return {
    instrument: { symbol: "TEST", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "TEST SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-test-fundamentals"],
        observedAt: ANALYSIS_AS_OF,
        metrics,
      },
    ],
    gaps: [],
  };
}

function valuationOf(result: ReturnType<typeof addValuationEvidence>) {
  return {
    metrics: result.extendedEvidence?.items.find((item) => item.category === "valuation")?.metrics,
    summary: result.extendedEvidence?.items.find((item) => item.category === "valuation")?.summary,
    gaps: result.sourceGaps,
  };
}

// Valuation item for the legacy summary and for the canonical replacement of the same facts.
function valuations(gaap: Facts, marketCap = 400_000 * M) {
  const payload = companyFacts(gaap);
  const legacy = summarizeSecFundamentals(payload, ANALYSIS_AS_OF);
  const artifact = deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: ANALYSIS_AS_OF,
    analysisAsOf: ANALYSIS_AS_OF,
    sourceId: "extended-sec-edgar-test-fundamentals",
  });
  const run = (evidence: ExtendedEvidence) =>
    addValuationEvidence(
      { jobType: "equity", assetClass: "equity", symbol: "TEST", depth: "deep" },
      [marketSnapshot({ symbol: "TEST", marketCap, observedAt: ANALYSIS_AS_OF })],
      evidence,
      ANALYSIS_AS_OF,
    );
  const legacyEvidence = secEvidence(legacy?.metrics ?? {});
  return {
    artifact,
    legacy: valuationOf(run(legacyEvidence)),
    canonical: valuationOf(run(withCanonicalFinancialLensInputs(legacyEvidence, artifact))),
  };
}

describe("enterprise value bridge on both SEC producers", () => {
  // AMD 10-Q for the quarter ended 2026-06-27 (filed 2026-08-05, accn 0000002488-26-000123).
  const amdAccn = "0000002488-26-000123";
  const amd: Facts = {
    CashAndCashEquivalentsAtCarryingValue: [fact(5086 * M, "2026-06-27", "2026-08-05", amdAccn)],
    ShortTermInvestments: [fact(8025 * M, "2026-06-27", "2026-08-05", amdAccn)],
    DebtLongtermAndShorttermCombinedAmount: [fact(3226 * M, "2026-06-27", "2026-08-05", amdAccn)],
    MinorityInterest: [fact(Number(M), "2011-12-31", "2012-02-24", "amd-2011", "10-K")],
  };

  test.each(["legacy", "canonical"] as const)(
    "AMD %s net debt subtracts short-term investments: 3,226 − 5,086 − 8,025 = −9,885M",
    (path) => {
      const { metrics, gaps } = valuations(amd)[path];
      expect(metrics).toMatchObject({
        cash: 5086 * M,
        debt: 3226 * M,
        shortTermInvestments: 8025 * M,
        shortTermInvestmentsConcept: "ShortTermInvestments",
        noncontrollingInterest: 0,
        noncontrollingInterestConcept: "none tagged",
        preferredStock: 0,
        netDebt: -9885 * M,
        enterpriseValue: 400_000 * M - 9885 * M,
      });
      expect(gaps.some((gap) => gap.message.startsWith("SEC EV bridge incomplete"))).toBe(false);
    },
  );

  // QCOM 10-Q for the quarter ended 2026-06-28 (filed 2026-07-29, accn 0000804328-26-000086).
  test.each(["legacy", "canonical"] as const)(
    "QCOM %s net debt subtracts current marketable securities of 3,771M",
    (path) => {
      const accn = "0000804328-26-000086";
      const at = (value: number) => [fact(value * M, "2026-06-28", "2026-07-29", accn)];
      const { metrics } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(4533),
        MarketableSecuritiesCurrent: at(3771),
        DebtCurrent: at(2489),
        LongTermDebtNoncurrent: at(12_781),
        PreferredStockValue: at(0),
      })[path];
      expect(metrics).toMatchObject({
        shortTermInvestments: 3771 * M,
        preferredStock: 0,
        preferredStockConcept: "PreferredStockValue",
        netDebt: (2489 + 12_781 - 4533 - 3771) * M,
      });
    },
  );

  // Check Point 20-F FY2025 (filed 2026-03-31, accn 0001178913-26-001932): the combined line also holds
  // Deposits 525.7M and long-term securities 1,326.8M, so neither 689.2M nor combined − cash is short-term investments.
  test.each(["legacy", "canonical"] as const)(
    "Check Point %s withholds net debt when combined − cash exceeds the picked line",
    (path) => {
      const accn = "0001178913-26-001932";
      // Legacy reads 10-K/10-Q only, so it gets the same facts under a 10-K form.
      const form = path === "legacy" ? "10-K" : "20-F";
      const at = (value: number) => [fact(value * M, "2025-12-31", "2026-03-31", accn, form)];
      const { metrics, gaps } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(1800),
        AvailableForSaleSecuritiesDebtSecuritiesCurrent: [
          fact(689_200_000, "2025-12-31", "2026-03-31", accn, form),
        ],
        CashCashEquivalentsAndShortTermInvestments: [
          fact(4_341_700_000, "2025-12-31", "2026-03-31", accn, form),
        ],
        DebtLongtermAndShorttermCombinedAmount: [
          fact(1_972_100_000, "2025-12-31", "2026-03-31", accn, form),
        ],
      })[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "CashCashEquivalentsAndShortTermInvestments − cash (2541700000) does not equal AvailableForSaleSecuritiesDebtSecuritiesCurrent (689200000) at 2025-12-31; the difference is not classified",
      );
      expect(gaps.some((gap) => gap.message.startsWith("SEC EV bridge incomplete"))).toBe(true);
    },
  );

  // GPN 10-Q for the quarter ended 2026-06-30 (filed 2026-08-05, accn 0001123360-26-000084).
  const gpn = (redeemable: number): Facts => {
    const at = (value: number) => [
      fact(value * 1000, "2026-06-30", "2026-08-05", "0001123360-26-000084"),
    ];
    return {
      CashAndCashEquivalentsAtCarryingValue: at(5_408_962),
      DebtLongtermAndShorttermCombinedAmount: at(10_000_000),
      Assets: at(63_573_787),
      Liabilities: at(39_604_137),
      StockholdersEquity: at(23_110_707),
      StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(23_758_893),
      MinorityInterest: at(648_186),
      RedeemableNoncontrollingInterestEquityCarryingAmount: at(redeemable),
    };
  };

  test.each(["legacy", "canonical"] as const)(
    "GPN %s enterprise value adds redeemable noncontrolling interest of 210.757M beside MinorityInterest",
    (path) => {
      const { metrics } = valuations(gpn(210_757))[path];
      const netDebt = 10_000 * M - 5_408_962_000;
      expect(metrics).toMatchObject({
        noncontrollingInterest: 648_186_000,
        temporaryEquity: 210_757_000,
        temporaryEquityConcept: "RedeemableNoncontrollingInterestEquityCarryingAmount",
        netDebt,
        enterpriseValue: 400_000 * M + netDebt + 648_186_000 + 210_757_000,
      });
    },
  );

  // APLD 10-K FY2026 (accn 0001144879-26-000048) leaves 2,019.1M of mezzanine against 1,956.3M tagged.
  test.each(["legacy", "canonical"] as const)(
    "%s withholds EV but keeps net debt when temporary equity does not reconcile",
    (path) => {
      const { metrics, gaps } = valuations(gpn(100_000))[path];
      expect(metrics?.netDebt).toBe(10_000 * M - 5_408_962_000);
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.temporaryEquityIncompleteReason).toContain("does not reconcile");
      expect(gaps.some((gap) => gap.message.startsWith("SEC EV bridge incomplete"))).toBe(true);
    },
  );

  // UBER 10-Q for the quarter ended 2026-06-30 (filed 2026-08-05, accn 0001543151-26-000032) tags no MinorityInterest.
  const uber = (parentEquity: number): Facts => {
    const at = (value: number) => [
      fact(value * M, "2026-06-30", "2026-08-05", "0001543151-26-000032"),
    ];
    return {
      CashAndCashEquivalentsAtCarryingValue: at(4870),
      MarketableSecuritiesCurrent: at(521),
      DebtLongtermAndShorttermCombinedAmount: at(10_000),
      Assets: at(65_801),
      Liabilities: at(37_402),
      StockholdersEquity: at(parentEquity),
      StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(28_219),
      RedeemableNoncontrollingInterestEquityCarryingAmount: at(180),
    };
  };

  test.each(["legacy", "canonical"] as const)(
    "UBER %s derives noncontrolling interest 28,219 − 27,316 = 903M when MinorityInterest is untagged",
    (path) => {
      const { metrics } = valuations(uber(27_316))[path];
      const netDebt = (10_000 - 4870 - 521) * M;
      expect(metrics).toMatchObject({
        noncontrollingInterest: 903 * M,
        noncontrollingInterestConcept:
          "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest − StockholdersEquity",
        temporaryEquity: 180 * M,
        netDebt,
        enterpriseValue: 400_000 * M + netDebt + 903 * M + 180 * M,
      });
    },
  );

  // SPIR-shaped: parent equity above equity including NCI is a mis-tag, not a negative claim.
  test.each(["legacy", "canonical"] as const)(
    "%s withholds EV when the derived noncontrolling interest is negative",
    (path) => {
      const { metrics } = valuations(uber(28_315.5))[path];
      expect(metrics?.netDebt).toBe((10_000 - 4870 - 521) * M);
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.noncontrollingInterestIncompleteReason).toContain(
        "is negative or does not reconcile",
      );
    },
  );

  // INTC 10-Q for the quarter ended 2026-06-27 (filed 2026-07-24, accn 0000050863-26-000157).
  test.each(["legacy", "canonical"] as const)(
    "INTC %s enterprise value adds noncontrolling interest of 15,601M",
    (path) => {
      const accn = "0000050863-26-000157";
      const at = (value: number) => [fact(value * M, "2026-06-27", "2026-07-24", accn)];
      const { metrics } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(12_874),
        AvailableForSaleSecuritiesDebtSecuritiesCurrent: at(16_853),
        MinorityInterest: at(15_601),
        DebtCurrent: at(1988),
        LongTermDebtNoncurrent: at(48_549),
      })[path];
      const netDebt = (1988 + 48_549 - 12_874 - 16_853) * M;
      expect(metrics).toMatchObject({
        noncontrollingInterest: 15_601 * M,
        shortTermInvestments: 16_853 * M,
        netDebt,
        enterpriseValue: 400_000 * M + netDebt + 15_601 * M,
      });
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s withholds EV and net debt when short-term investments drop out of a newer instant",
    (path) => {
      const { metrics, gaps } = valuations({
        ...amd,
        ShortTermInvestments: [fact(7000 * M, "2026-03-28", "2026-05-06", "amd-q1")],
      })[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.evToAnnualizedRevenue).toBeUndefined();
      expect(gaps).toContainEqual(
        expect.objectContaining({
          message: expect.stringMatching(
            /^SEC EV bridge incomplete for TEST at cash period end 2026-06-27: short-term investments \(ShortTermInvestments\) reported nonzero at 2026-03-28/u,
          ),
        }),
      );
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s keeps net debt but withholds EV when noncontrolling interest drops out",
    (path) => {
      const { metrics } = valuations({
        ...amd,
        MinorityInterest: [fact(50 * M, "2026-03-28", "2026-05-06", "amd-q1")],
      })[path];
      expect(metrics?.netDebt).toBe(-9885 * M);
      expect(metrics?.enterpriseValue).toBeUndefined();
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s derives short-term investments from the combined cash line when only it is tagged",
    (path) => {
      const { ShortTermInvestments: _sti, ...rest } = amd;
      const { metrics } = valuations({
        ...rest,
        CashCashEquivalentsAndShortTermInvestments: [
          fact(13_111 * M, "2026-06-27", "2026-08-05", amdAccn),
        ],
      })[path];
      expect(metrics).toMatchObject({
        shortTermInvestments: 8025 * M,
        shortTermInvestmentsConcept: "CashCashEquivalentsAndShortTermInvestments − cash",
        netDebt: -9885 * M,
      });
    },
  );

  // NVDA 10-Q for the quarter ended 2026-07-26 (filed 2026-08-26, accn 0001045810-26-000075).
  const nvda = (equity: Facts): Facts => {
    const at = (value: number) => [
      fact(value * M, "2026-07-26", "2026-08-26", "0001045810-26-000075"),
    ];
    return {
      CashAndCashEquivalentsAtCarryingValue: at(22_443),
      DebtSecuritiesCurrent: at(34_143),
      AccountsReceivableNetCurrent: at(63_059),
      InventoryNet: at(31_575),
      PrepaidExpenseAndOtherAssetsCurrent: at(3409),
      AssetsCurrent: at(197_412),
      LongTermDebt: at(33_366),
      DebtCurrent: at(1000),
      LongTermDebtCurrent: at(1000),
      LongTermDebtNoncurrent: at(32_366),
      ...Object.fromEntries(
        Object.entries(equity).map(([concept, [value]]) => [
          concept,
          at(Number(value?.val ?? 0) / M),
        ]),
      ),
    };
  };

  test.each(["legacy", "canonical"] as const)(
    "NVDA %s adds current marketable equity securities: 33,366 − 22,443 − (34,143 + 42,783) = −66,003M",
    (path) => {
      const { metrics } = valuations(nvda({ EquitySecuritiesFvNi: [{ val: 42_783 * M }] }))[path];
      expect(metrics).toMatchObject({
        shortTermInvestments: 76_926 * M,
        shortTermInvestmentsConcept: "DebtSecuritiesCurrent + EquitySecuritiesFvNi",
        netDebt: -66_003 * M,
        enterpriseValue: 400_000 * M - 66_003 * M,
      });
    },
  );

  test("NVDA keeps both short-term investment contributors in lineage and discloses restrictions", () => {
    const quarter = nvda({ EquitySecuritiesFvNi: [{ val: 42_783 * M }] });
    const { legacy, canonical } = valuations(quarter);
    // The workbench reads annual revenue periods, so the same balance sheet moves to the revenue year-end.
    const annual = Object.fromEntries(
      Object.entries(quarter).map(([concept, rows]) => [
        concept,
        rows.map((row) => ({
          ...row,
          end: "2025-12-27",
          form: "10-K",
          fp: "FY",
          filed: "2026-02-04",
        })),
      ]),
    );
    const lineage = valuationPeriodInputs(valuations(annual).artifact)
      .periods.at(-1)
      ?.enterpriseValueBridge?.lineage?.filter((row) =>
        row.label.startsWith("shortTermInvestments"),
      );
    expect(lineage?.map(({ key, value }) => [key, value])).toEqual([
      ["DebtSecuritiesCurrent", 34_143 * M],
      ["EquitySecuritiesFvNi", 42_783 * M],
    ]);
    expect(lineage?.[1]?.label).toContain("sale restrictions");
    for (const { summary, metrics } of [legacy, canonical]) {
      expect(summary).toContain("short-term investments include current equity securities");
      const row = targetRow(
        "NVDA",
        { ...secEvidence(metrics ?? {}).items[0]!, category: "valuation" },
        undefined,
        ANALYSIS_AS_OF,
      );
      expect(compsCashLabel(row)).toBe(
        "cash 2026-07-26 (short-term investments include current equity securities that may be sale-restricted)",
      );
    }
  });

  // META-shaped: a generic equity-securities fact the current-asset total does not hold is a long-term holding.
  test.each(["legacy", "canonical"] as const)(
    "%s leaves out generic equity securities that current assets do not reconcile",
    (path) => {
      const { metrics } = valuations(nvda({ EquitySecuritiesFvNi: [{ val: 3543 * M }] }))[path];
      expect(metrics).toMatchObject({
        shortTermInvestments: 34_143 * M,
        shortTermInvestmentsConcept: "DebtSecuritiesCurrent",
      });
    },
  );

  test.each([
    ["legacy", "MarketableSecuritiesCurrent"],
    ["canonical", "MarketableSecuritiesCurrent"],
    ["legacy", "DebtSecuritiesCurrent"],
    ["canonical", "DebtSecuritiesCurrent"],
  ] as const)(
    "%s leaves out generic equity beside %s when the identity rests on an untagged line",
    (path, pick) => {
      // Inventory 20 sits in AssetsCurrent untagged, so the 20 of equity only appears to close it.
      const at = (value: number) => [fact(value * M, "2026-06-30", "2026-08-04", "synthetic")];
      const { metrics } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(10),
        [pick]: at(50),
        AccountsReceivableNetCurrent: at(20),
        AssetsCurrent: at(100),
        EquitySecuritiesFvNi: at(20),
        LongTermDebtNoncurrent: at(100),
      })[path];
      expect(metrics).toMatchObject({ shortTermInvestments: 50 * M, netDebt: 40 * M });
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "VRTX %s leaves out generic equity securities when current assets already sum without them",
    (path) => {
      // VRTX 10-Q 2026-06-30 (0000875320-26-000259): 6,143.5 + 1,708.9 + 2,134.3 + 1,765.1 + 791.9 = 12,543.7M; 11.9M sits within tolerance.
      const at = (value: number) => [
        fact(value * M, "2026-06-30", "2026-08-04", "0000875320-26-000259"),
      ];
      const { metrics } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(6143.5),
        MarketableSecuritiesCurrent: at(1708.9),
        AccountsReceivableNetCurrent: at(2134.3),
        InventoryNet: at(1765.1),
        PrepaidExpenseAndOtherAssetsCurrent: at(791.9),
        AssetsCurrent: at(12_543.7),
        EquitySecuritiesFvNi: at(11.9),
        LongTermDebtNoncurrent: at(0),
      })[path];
      expect(metrics).toMatchObject({
        shortTermInvestments: 1708.9 * M,
        shortTermInvestmentsConcept: "MarketableSecuritiesCurrent",
      });
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s adds explicit current equity securities beside debt securities without the identity",
    (path) => {
      const { AssetsCurrent: _assets, ...withoutTotal } = nvda({
        EquitySecuritiesFvNiCurrent: [{ val: 42_783 * M }],
      });
      expect(valuations(withoutTotal)[path].metrics?.shortTermInvestments).toBe(76_926 * M);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "%s withholds net debt when explicit current equity securities may sit inside a combined short-term line",
    (path) => {
      const {
        DebtSecuritiesCurrent: _debt,
        AssetsCurrent: _assets,
        ...withoutLines
      } = nvda({
        EquitySecuritiesFvNiCurrent: [{ val: 42_783 * M }],
      });
      const { metrics } = valuations({
        ...withoutLines,
        ShortTermInvestments: [fact(76_926 * M, "2026-07-26", "2026-08-26", "nvda")],
      })[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toContain(
        "may already sit inside ShortTermInvestments",
      );
    },
  );

  test("an artifact whose bridge predates the current-asset keys still reads, with re-projected EV withheld", () => {
    // Run 2026-10-25T09-35-03-509Z-47086901 wrote these nine bridge keys.
    const { artifact } = valuations(nvda({ EquitySecuritiesFvNi: [{ val: 42_783 * M }] }));
    const {
      currentEquitySecurities: _equity,
      assetsCurrent: _assets,
      receivablesCurrent: _receivables,
      inventory: _inventory,
      otherAssetsCurrent: _other,
      ...older
    } = artifact.enterpriseValueBridge!;
    expect(Object.keys(older).toSorted()).toEqual([
      "assets",
      "cashAndShortTermInvestments",
      "liabilities",
      "noncontrollingInterest",
      "preferredStock",
      "shortTermInvestments",
      "stockholdersEquity",
      "stockholdersEquityIncludingNoncontrollingInterest",
      "temporaryEquity",
    ]);
    const read = readFinancialStatementsArtifact(
      JSON.parse(JSON.stringify({ ...artifact, enterpriseValueBridge: older })),
    );
    expect(read?.statements.balanceSheet.debt).toEqual(artifact.statements.balanceSheet.debt);
    expect(read?.enterpriseValueBridge).toBeUndefined();
    expect(read?.readDiagnostics?.drops).toContainEqual(
      expect.objectContaining({
        reason: expect.stringContaining("predates currentEquitySecurities"),
      }),
    );
    const metrics = withCanonicalFinancialLensInputs(secEvidence({}), read!).items[0]?.metrics;
    expect(metrics?.shortTermInvestmentsIncompleteReason).toBeDefined();
  });

  test("run 47086901: the saved report keeps its published EV beside a stale bridge", async () => {
    const { artifact } = valuations(amd);
    const { enterpriseValueBridge: bridge } = artifact;
    const older = Object.fromEntries(
      Object.entries(bridge!).filter(
        ([key]) =>
          ![
            "currentEquitySecurities",
            "assetsCurrent",
            "receivablesCurrent",
            "inventory",
            "otherAssetsCurrent",
          ].includes(key),
      ),
    );
    const sourceId = "extended-sec-edgar-amd-fundamentals";
    const saved = {
      category: "valuation" as const,
      title: "AMD Valuation Evidence",
      summary:
        "Valuation Evidence: enterprise value $833.8B; EV bridge: market cap + debt + preferred stock + noncontrolling interest + temporary equity (redeemable noncontrolling interest and preferred) − cash and short-term investments; long-term investments excluded.",
      sourceIds: [sourceId],
      observedAt: "2026-10-25T09:35:03.509Z",
      metrics: {
        enterpriseValue: 833_761_697_472,
        evToAnnualizedRevenue: 20.185_490_799_467_377,
        shortTermInvestmentsConcept: "ShortTermInvestments",
        peerImpliedRangeStatus: "derived",
      },
    };
    const runDir = join(tmpdir(), `market-bot-ev-${Date.now()}`, "runs", "47086901");
    const write = async (path: string, value: unknown) => {
      await mkdir(dirname(join(runDir, path)), { recursive: true });
      await writeFile(join(runDir, path), JSON.stringify(value));
    };
    try {
      await write(
        "report.json",
        researchReport({
          runId: "47086901",
          jobType: "equity",
          symbol: "AMD",
          sources: [
            {
              id: sourceId,
              title: "AMD SEC fundamentals",
              fetchedAt: ANALYSIS_AS_OF,
              kind: "market-data",
            },
          ],
          extendedEvidence: {
            instrument: { symbol: "AMD", assetClass: "equity" },
            items: [saved],
            gaps: [],
          },
        }),
      );
      await write("normalized/financial-statements.json", {
        ...artifact,
        enterpriseValueBridge: older,
      });

      const { artifact: run } = await loadRunArtifact(runDir);

      expect(run?.financialStatements?.enterpriseValueBridge).toBeUndefined();
      expect(run?.financialStatements?.readDiagnostics?.drops).toContainEqual(
        expect.objectContaining({
          reason: expect.stringContaining("saved valuation keeps the basis it was published with"),
        }),
      );
      expect(run?.report.extendedEvidence?.items).toContainEqual(saved);
    } finally {
      await rm(dirname(dirname(runDir)), { recursive: true, force: true });
    }
  });

  test("the canonical artifact carries bridge facts only for us-gaap", () => {
    const { artifact } = valuations(amd);
    expect(artifact.enterpriseValueBridge?.shortTermInvestments.at(-1)).toMatchObject({
      value: 8025 * M,
      periodEnd: "2026-06-27",
      concept: "ShortTermInvestments",
    });
  });
});

const CASH_INSTANT = "2026-06-30";

function bridgeFact(
  value: number,
  concept: string,
  periodEnd = CASH_INSTANT,
  filedAt = "2026-08-01",
): BridgeFact {
  return { value, concept, periodEnd, filedAt, firstPublicAt: filedAt };
}

function facts(overrides: Partial<Record<string, readonly BridgeFact[]>> = {}) {
  return {
    shortTermInvestments: [],
    cashAndShortTermInvestments: [],
    noncontrollingInterest: [],
    preferredStock: [],
    temporaryEquity: [],
    assets: [],
    liabilities: [],
    stockholdersEquity: [],
    stockholdersEquityIncludingNoncontrollingInterest: [],
    currentEquitySecurities: [],
    assetsCurrent: [],
    receivablesCurrent: [],
    inventory: [],
    otherAssetsCurrent: [],
    ...overrides,
  };
}

describe("resolveEnterpriseValueBridge", () => {
  const cash = { value: 100, periodEnd: CASH_INSTANT };

  test("temporary equity without liabilities cannot be checked and is incomplete", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        temporaryEquity: [bridgeFact(82, "RedeemableNoncontrollingInterestEquityCarryingAmount")],
        assets: [bridgeFact(4348, "Assets")],
        stockholdersEquityIncludingNoncontrollingInterest: [
          bridgeFact(
            1677,
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
          ),
        ],
      }),
      cash,
    );
    expect(resolved.temporaryEquity.status).toBe("incomplete");
  });

  test("temporary equity reconciles against parent equity + MinorityInterest", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        temporaryEquity: [bridgeFact(9, "RedeemableNoncontrollingInterestEquityCarryingAmount")],
        noncontrollingInterest: [bridgeFact(121, "MinorityInterest")],
        assets: [bridgeFact(44_806, "Assets")],
        liabilities: [bridgeFact(29_184, "Liabilities")],
        stockholdersEquity: [bridgeFact(15_492, "StockholdersEquity")],
      }),
      cash,
    );
    expect(resolved.temporaryEquity).toMatchObject({ status: "tagged", value: 9 });
  });

  test("a derived noncontrolling interest that breaks the balance-sheet identity is incomplete", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        assets: [bridgeFact(65_801, "Assets")],
        liabilities: [bridgeFact(37_402, "Liabilities")],
        stockholdersEquity: [bridgeFact(27_316, "StockholdersEquity")],
        stockholdersEquityIncludingNoncontrollingInterest: [
          bridgeFact(
            28_219,
            "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
          ),
        ],
      }),
      cash,
    );
    expect(resolved.noncontrollingInterest.status).toBe("incomplete");
  });

  test("a picked line above combined − cash is incomplete", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        shortTermInvestments: [bridgeFact(500, "ShortTermInvestments")],
        cashAndShortTermInvestments: [
          bridgeFact(300, "CashCashEquivalentsAndShortTermInvestments"),
        ],
      }),
      cash,
    );
    expect(resolved.shortTermInvestments.status).toBe("incomplete");
  });

  test("a combined line equal to cash + the picked line keeps the pick", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        shortTermInvestments: [bridgeFact(186_563, "MarketableSecuritiesCurrent")],
        cashAndShortTermInvestments: [
          bridgeFact(186_663, "CashCashEquivalentsAndShortTermInvestments"),
        ],
      }),
      cash,
    );
    expect(resolved.shortTermInvestments).toMatchObject({ status: "tagged", value: 186_563 });
  });

  test("a tagged zero counts as tagged, and an absent line is untagged", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({ preferredStock: [bridgeFact(0, "PreferredStockValue")] }),
      cash,
    );
    expect(resolved.preferredStock).toMatchObject({ status: "tagged", value: 0 });
    expect(resolved.noncontrollingInterest).toEqual({ status: "untagged" });
  });

  test("a nonzero line older than 400 days no longer blocks an untagged instant", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({ noncontrollingInterest: [bridgeFact(5, "MinorityInterest", "2025-05-01")] }),
      cash,
    );
    expect(resolved.noncontrollingInterest).toEqual({ status: "untagged" });
  });

  test("a combined line below cash is incomplete rather than negative", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        cashAndShortTermInvestments: [bridgeFact(90, "CashCashEquivalentsAndShortTermInvestments")],
      }),
      cash,
    );
    expect(resolved.shortTermInvestments.status).toBe("incomplete");
  });

  test("point-in-time readers ignore facts filed after publicAt", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({ shortTermInvestments: [bridgeFact(40, "ShortTermInvestments")] }),
      cash,
      "2026-07-15",
    );
    expect(resolved.shortTermInvestments).toEqual({ status: "untagged" });
  });

  test("no bridge facts (non-us-gaap taxonomy) leaves every component incomplete", () => {
    const resolved = resolveEnterpriseValueBridge(undefined, cash);
    expect(
      [resolved.shortTermInvestments, resolved.noncontrollingInterest, resolved.preferredStock].map(
        ({ status }) => status,
      ),
    ).toEqual(["incomplete", "incomplete", "incomplete"]);
  });
});

describe("peer-implied range with non-common claims", () => {
  test("subtracts noncontrolling interest and preferred stock before dividing by shares", () => {
    const range = derivePeerImpliedRange({
      supportability: "supported",
      usablePeerCount: 3,
      peerP25EvToAnnualizedRevenue: 1,
      peerMedianEvToAnnualizedRevenue: 2,
      peerP75EvToAnnualizedRevenue: 3,
      annualizedRevenue: 400,
      netDebt: 10,
      nonCommonClaims: 30,
      sharesOutstanding: 10,
      currentPrice: 75,
      quoteCurrency: "USD",
      quoteObservedAt: ANALYSIS_AS_OF,
    });
    expect(range).toMatchObject({ status: "derived", low: 36, mid: 76, high: 116 });
  });

  test("suppresses when the target's non-common claims are unknown", () => {
    const range = derivePeerImpliedRange({
      supportability: "supported",
      usablePeerCount: 3,
      peerP25EvToAnnualizedRevenue: 1,
      peerMedianEvToAnnualizedRevenue: 2,
      peerP75EvToAnnualizedRevenue: 3,
      annualizedRevenue: 400,
      netDebt: 10,
      sharesOutstanding: 10,
      currentPrice: 75,
      quoteCurrency: "USD",
      quoteObservedAt: ANALYSIS_AS_OF,
    });
    expect(range).toMatchObject({
      status: "suppressed",
      suppressedReason:
        "noncontrolling interest, preferred stock or temporary equity is unavailable",
    });
  });
});
