import { describe, expect, test } from "bun:test";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import { renderMetricSections } from "../src/report/markdown-metric-sections";
import {
  CURRENT_EQUITY_NOTE,
  ENTERPRISE_VALUE_BASIS,
  isCurrentEquityConcept,
} from "../src/sources/extended-evidence/enterprise-value-bridge";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
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

const noteCount = (basis: string | undefined) =>
  (basis?.split(CURRENT_EQUITY_NOTE).length ?? 1) - 1;
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
    evidence: result.extendedEvidence,
  };
}

const bridgeGaps = (gaps: readonly { readonly message: string }[]) =>
  gaps.filter((gap) => gap.message.startsWith("SEC EV bridge incomplete"));

// Same facts with some concepts also, or only, filed in EUR (or another currency).
function withEur(gaap: Facts, eur: Facts, unit = "EUR") {
  const payload = companyFacts(gaap);
  const root: Record<string, { units: Record<string, unknown> }> = payload.facts["us-gaap"];
  for (const [concept, rows] of Object.entries(eur)) {
    root[concept] = { units: { ...root[concept]?.units, [unit]: rows } };
  }
  return payload;
}

function valuations(gaap: Facts, marketCap = 400_000 * M) {
  return payloadValuations(companyFacts(gaap), marketCap);
}

// Valuation item for the legacy summary and for the canonical replacement of the same facts.
function payloadValuations(payload: ReturnType<typeof companyFacts>, marketCap = 400_000 * M) {
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

  const { ShortTermInvestments: _amdShortTermInvestments, ...amdWithoutSti } = amd;
  const amdAt = (value: number, filed = "2026-08-05", accn = amdAccn) => [
    fact(value * M, "2026-06-27", filed, accn),
  ];

  test.each([
    ["legacy", "ShortTermInvestments", 8025],
    ["canonical", "ShortTermInvestments", 8025],
    ["legacy", "CashCashEquivalentsAndShortTermInvestments", 13_111],
    ["canonical", "CashCashEquivalentsAndShortTermInvestments", 13_111],
  ] as const)(
    "AMD %s withholds net debt and EV when %s is filed only in EUR, never reading it as 0",
    (path, concept, value) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amdWithoutSti, { [concept]: amdAt(value) }),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        `${concept} at 2026-06-27 is filed in EUR, not reporting currency USD`,
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
      expect(bridgeGaps(gaps)[0]?.message).toContain("EUR");
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s withholds EV but keeps net debt −1,860M when MinorityInterest is filed only in EUR",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amdWithoutSti, { MinorityInterest: amdAt(25) }),
      )[path];
      expect(metrics?.netDebt).toBe(-1860 * M);
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.noncontrollingInterestIncompleteReason).toContain("filed in EUR");
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each([
    ["legacy", "PreferredStockValue", "preferredStock"],
    ["canonical", "PreferredStockValue", "preferredStock"],
    ["legacy", "TemporaryEquityCarryingAmountAttributableToParent", "temporaryEquity"],
    ["canonical", "TemporaryEquityCarryingAmountAttributableToParent", "temporaryEquity"],
  ] as const)(
    "AMD %s withholds EV but keeps net debt −1,860M when %s is filed only in EUR",
    (path, concept, key) => {
      const { metrics, gaps } = payloadValuations(withEur(amdWithoutSti, { [concept]: amdAt(25) }))[
        path
      ];
      expect(metrics?.netDebt).toBe(-1860 * M);
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.[`${key}IncompleteReason`]).toBe(
        `${concept} at 2026-06-27 is filed in EUR, not reporting currency USD`,
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: a later EUR-only EquitySecuritiesFvNiCurrent withholds beside an earlier EUR generic line",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amdWithoutSti, {
          EquitySecuritiesFvNi: amdAt(1200),
          EquitySecuritiesFvNiCurrent: amdAt(1200, "2026-09-15", "amd-10q-a"),
        }),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "EquitySecuritiesFvNiCurrent at 2026-06-27 is filed in EUR, not reporting currency USD",
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  // Q1 instant 2026-03-28: the 10-Q (2026-05-04) and a later filing (2026-06-15) disagree on short-term investments.
  const q1 = (value: number, filed: string) => [
    fact(value, "2026-03-28", filed, `amd-q1-${filed}`),
  ];

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: EUR-only short-term investments amended from 0 to 50M at the prior quarter keep continuity",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amdWithoutSti, {
          ShortTermInvestments: [...q1(0, "2026-05-04"), ...q1(50 * M, "2026-06-15")],
        }),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "short-term investments (ShortTermInvestments) reported nonzero at 2026-03-28 but not tagged at 2026-06-27",
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: a USD zero superseding EUR 50M at the prior quarter breaks continuity",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(
          { ...amdWithoutSti, ShortTermInvestments: q1(0, "2026-06-15") },
          { ShortTermInvestments: q1(50 * M, "2026-05-04") },
        ),
      )[path];
      expect(metrics).toMatchObject({ netDebt: -1860 * M, shortTermInvestments: 0 });
      expect(bridgeGaps(gaps)).toHaveLength(0);
    },
  );

  test("a same-filing EUR translation never reads as foreign-only at a cutoff before a USD restatement", () => {
    const { artifact } = payloadValuations(
      withEur(
        {
          ...amdWithoutSti,
          ShortTermInvestments: [...amdAt(8025), ...amdAt(8055, "2026-09-15", "amd-10q-a")],
        },
        { ShortTermInvestments: amdAt(7300) },
      ),
    );
    const part = resolveEnterpriseValueBridge(
      artifact.enterpriseValueBridge,
      { value: 5086 * M, periodEnd: "2026-06-27" },
      "2026-09-01",
    ).shortTermInvestments;
    expect(part).not.toMatchObject({ reason: expect.stringContaining("filed in EUR") });
  });

  test.each(["legacy", "canonical"] as const)(
    "AMD %s withholds net debt when EquitySecuritiesFvNiCurrent is filed only in EUR",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amd, { EquitySecuritiesFvNiCurrent: amdAt(1200) }),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "EquitySecuritiesFvNiCurrent at 2026-06-27 is filed in EUR, not reporting currency USD",
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s keeps USD short-term investments filed beside a EUR translation in the same 10-Q",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(amd, { ShortTermInvestments: amdAt(8025) }),
      )[path];
      expect(metrics).toMatchObject({
        netDebt: -9885 * M,
        shortTermInvestmentsConcept: "ShortTermInvestments",
      });
      expect(bridgeGaps(gaps)).toHaveLength(0);
    },
  );

  // A later USD filing (2026-09-15) retags the instant the 10-Q filed only in EUR.
  test.each([
    ["2026-09-01", "incomplete"],
    ["2026-10-01", "tagged"],
    ["none", "tagged"],
  ] as const)(
    "publicAt %s: EUR short-term investments filed before the USD retag read %s",
    (publicAt, status) => {
      const { artifact } = payloadValuations(
        withEur(
          { ...amdWithoutSti, ShortTermInvestments: amdAt(8025, "2026-09-15", "amd-10q-a") },
          { ShortTermInvestments: amdAt(8025) },
        ),
      );
      const part = resolveEnterpriseValueBridge(
        artifact.enterpriseValueBridge,
        { value: 5086 * M, periodEnd: "2026-06-27" },
        publicAt === "none" ? undefined : publicAt,
      ).shortTermInvestments;
      expect(part).toMatchObject(
        status === "tagged"
          ? { status, value: 8025 * M, fact: { currency: "USD" } }
          : {
              status,
              reason:
                "ShortTermInvestments at 2026-06-27 is filed in EUR, not reporting currency USD",
            },
      );
    },
  );

  const bridgeAt = (payload: ReturnType<typeof companyFacts>, publicAt: string) =>
    resolveEnterpriseValueBridge(
      payloadValuations(payload).artifact.enterpriseValueBridge,
      { value: 5086 * M, periodEnd: "2026-06-27" },
      publicAt === "none" ? undefined : publicAt,
    );
  const IN_EUR = "ShortTermInvestments at 2026-06-27 is filed in EUR, not reporting currency USD";
  const RESTATED =
    "ShortTermInvestments at 2026-06-27 was restated on 2026-09-15; the value first filed is withheld";
  const usd8025 = { after: amdAt(8025, "2026-08-20", "amd-8k"), with: amdAt(8025) };

  // EUR 7,300M in the 10-Q (2026-08-05); USD 8,025M filed later or in the same 10-Q; USD restated to 8,055M on 2026-09-15.
  test.each([
    ["after", "restated", "2026-08-10", { status: "incomplete", reason: IN_EUR }],
    ["after", "restated", "2026-09-01", { status: "incomplete", reason: RESTATED }],
    ["after", "restated", "2026-09-20", { status: "tagged", value: 8055 * M }],
    ["after", "restated", "none", { status: "tagged", value: 8055 * M }],
    ["with", "restated", "2026-09-01", { status: "incomplete", reason: RESTATED }],
    ["with", "restated", "none", { status: "tagged", value: 8055 * M }],
    ["with", "as filed", "2026-09-01", { status: "tagged", value: 8025 * M }],
    ["with", "as filed", "none", { status: "tagged", value: 8025 * M }],
  ] as const)(
    "USD filed %s EUR, %s: publicAt %s reads the row in effect",
    (filed, restated, publicAt, expected) => {
      const part = bridgeAt(
        withEur(
          {
            ...amdWithoutSti,
            ShortTermInvestments: [
              ...usd8025[filed],
              ...(restated === "restated" ? amdAt(8055, "2026-09-15", "amd-10q-a") : []),
            ],
          },
          { ShortTermInvestments: amdAt(7300) },
        ),
        publicAt,
      ).shortTermInvestments;
      expect(part).toEqual(
        expected.status === "tagged" ? expect.objectContaining(expected) : expected,
      );
    },
  );

  // Identity operands in the 10-Q (2026-08-05); MinorityInterest is filed later and only in EUR.
  test.each([
    [[10_000, 3900, 6000, 6100], "2026-08-20", "2026-08-10", "100"],
    [[10_000, 3900, 6000, 6100], "2026-08-20", "2026-09-01", "withheld"],
    [[10_000, 3900, 6000, 6100], "2026-08-20", "none", "withheld"],
    [[1000, 400, 550, 600], "2026-09-15", "2026-09-01", "50"],
  ] as const)(
    "identity %j with EUR MinorityInterest filed %s: publicAt %s reads NCI %s",
    ([assets, liabilities, parent, including], filed, publicAt, derived) => {
      const part = bridgeAt(
        withEur(
          {
            ...amdWithoutSti,
            Assets: amdAt(assets),
            Liabilities: amdAt(liabilities),
            StockholdersEquity: amdAt(parent),
            StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest:
              amdAt(including),
          },
          { MinorityInterest: amdAt(45, filed, "amd-10q-a") },
        ),
        publicAt,
      ).noncontrollingInterest;
      expect(part).toEqual(
        derived === "withheld"
          ? {
              status: "incomplete",
              reason: "MinorityInterest at 2026-06-27 is filed in EUR, not reporting currency USD",
            }
          : expect.objectContaining({ status: "tagged", value: Number(derived) * M }),
      );
    },
  );

  // Prior-quarter (2026-03-28) EUR short-term investments revised 50M → 0 on 2026-08-15, then back to 50M on 2026-09-15.
  test.each([
    [[50, 0], "2026-08-10", "incomplete"],
    [[50, 0], "2026-08-20", "untagged"],
    [[50, 0, 50], "2026-08-20", "untagged"],
    [[50, 0, 50], "2026-09-20", "incomplete"],
  ] as const)(
    "prior-quarter EUR revisions %j: publicAt %s reads %s",
    (values, publicAt, status) => {
      const filed = ["2026-05-04", "2026-08-15", "2026-09-15"];
      const part = bridgeAt(
        withEur(amdWithoutSti, {
          ShortTermInvestments: values.flatMap((value, index) => q1(value * M, filed[index]!)),
        }),
        publicAt,
      ).shortTermInvestments;
      expect(part).toEqual(
        status === "untagged"
          ? { status }
          : {
              status,
              reason:
                "short-term investments (ShortTermInvestments) reported nonzero at 2026-03-28 but not tagged at 2026-06-27",
            },
      );
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: a USD zero EquitySecuritiesFvNi cannot mask EquitySecuritiesFvNiCurrent filed later only in EUR",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(
          { ...amdWithoutSti, EquitySecuritiesFvNi: amdAt(0) },
          { EquitySecuritiesFvNiCurrent: amdAt(1200, "2026-09-15", "amd-10q-a") },
        ),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "EquitySecuritiesFvNiCurrent at 2026-06-27 is filed in EUR, not reporting currency USD",
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: ShortTermInvestments filed only in EUR withholds beside a USD DebtSecuritiesCurrent",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(
          { ...amdWithoutSti, DebtSecuritiesCurrent: amdAt(8025) },
          { ShortTermInvestments: amdAt(7300) },
        ),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(IN_EUR);
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  test.each(["legacy", "canonical"] as const)(
    "AMD %s: a USD DebtSecuritiesCurrent cannot skip the check against a combined line filed only in EUR",
    (path) => {
      const { metrics, gaps } = payloadValuations(
        withEur(
          { ...amdWithoutSti, DebtSecuritiesCurrent: amdAt(8025) },
          { CashCashEquivalentsAndShortTermInvestments: amdAt(14_000) },
        ),
      )[path];
      expect(metrics?.netDebt).toBeUndefined();
      expect(metrics?.shortTermInvestmentsIncompleteReason).toBe(
        "CashCashEquivalentsAndShortTermInvestments at 2026-06-27 is filed in EUR, not reporting currency USD",
      );
      expect(bridgeGaps(gaps)).toHaveLength(1);
    },
  );

  // Prior-quarter short-term investments filed in two other currencies; the later filing is in effect.
  test.each([
    ["GBP", 0, "EUR", 50, "2026-08-10", "untagged"],
    ["GBP", 0, "EUR", 50, "2026-10-01", "incomplete"],
    ["GBP", 0, "EUR", 50, "none", "incomplete"],
    ["EUR", 50, "GBP", 0, "2026-10-01", "untagged"],
  ] as const)(
    "prior-quarter %s %j on 2026-08-05 then %s %j on 2026-09-15: publicAt %s reads %s",
    (firstUnit, firstValue, laterUnit, laterValue, publicAt, status) => {
      const payload = withEur(
        amdWithoutSti,
        { ShortTermInvestments: q1(firstValue * M, "2026-08-05") },
        firstUnit,
      );
      const root = payload.facts["us-gaap"] as Record<string, { units: Record<string, unknown> }>;
      root.ShortTermInvestments!.units[laterUnit] = q1(laterValue * M, "2026-09-15");
      expect(bridgeAt(payload, publicAt).shortTermInvestments).toEqual(
        status === "untagged"
          ? { status }
          : {
              status,
              reason:
                "short-term investments (ShortTermInvestments) reported nonzero at 2026-03-28 but not tagged at 2026-06-27",
            },
      );
    },
  );

  // Prior-quarter short-term investments as a sequence of filings in other currencies; the latest one public is in effect.
  test.each([
    ["EUR 50, GBP 0, EUR 50", "2026-08-10", "incomplete"],
    ["EUR 50, GBP 0, EUR 50", "2026-09-20", "untagged"],
    ["EUR 50, GBP 0, EUR 50", "2026-10-01", "incomplete"],
    ["EUR 50, GBP 0, EUR 50", "none", "incomplete"],
    ["GBP 0, EUR 50, GBP 0", "2026-09-20", "incomplete"],
    ["GBP 0, EUR 50, GBP 0", "2026-10-01", "untagged"],
    ["GBP 0, then a same-day EUR 50 amendment", "none", "incomplete"],
  ] as const)("prior-quarter filings %s: publicAt %s reads %s", (sequence, publicAt, status) => {
    const filings: readonly (readonly [string, number, string, string])[] = sequence.startsWith(
      "EUR",
    )
      ? [
          ["EUR", 50, "2026-08-05", "10-Q"],
          ["GBP", 0, "2026-09-15", "10-Q/A"],
          ["EUR", 50, "2026-09-25", "10-Q/A"],
        ]
      : sequence.includes("same-day")
        ? [
            ["GBP", 0, "2026-08-05", "10-Q"],
            ["EUR", 50, "2026-08-05", "10-Q/A"],
          ]
        : [
            ["GBP", 0, "2026-08-05", "10-Q"],
            ["EUR", 50, "2026-09-15", "10-Q/A"],
            ["GBP", 0, "2026-09-25", "10-Q/A"],
          ];
    const payload = companyFacts(amdWithoutSti);
    const root = payload.facts["us-gaap"] as Record<string, { units: Record<string, unknown[]> }>;
    root.ShortTermInvestments = { units: {} };
    for (const [unit, value, filed, form] of filings) {
      (root.ShortTermInvestments.units[unit] ??= []).push(
        fact(value * M, "2026-03-28", filed, `amd-${unit}-${filed}-${form}`, form),
      );
    }
    expect(bridgeAt(payload, publicAt).shortTermInvestments).toEqual(
      status === "untagged"
        ? { status }
        : {
            status,
            reason:
              "short-term investments (ShortTermInvestments) reported nonzero at 2026-03-28 but not tagged at 2026-06-27",
          },
    );
    if (publicAt === "none") {
      for (const path of ["legacy", "canonical"] as const) {
        const { metrics, gaps } = payloadValuations(payload)[path];
        expect(metrics?.netDebt).toBeUndefined();
        expect(bridgeGaps(gaps)).toHaveLength(1);
      }
    }
  });

  // Explicit current equity 1,200M at 2026-03-28; at 2026-06-27 current assets 25,111M close without the generic line.
  test.each([30_000, 0])(
    "a restated generic EquitySecuritiesFvNi %j the identity does not add keeps explicit-equity continuity",
    (value) => {
      const part = bridgeAt(
        companyFacts({
          ...amdWithoutSti,
          DebtSecuritiesCurrent: amdAt(8025),
          AccountsReceivableNetCurrent: amdAt(6000),
          InventoryNet: amdAt(4000),
          OtherAssetsCurrent: amdAt(2000),
          AssetsCurrent: amdAt(25_111),
          EquitySecuritiesFvNiCurrent: q1(1200 * M, "2026-05-04"),
          EquitySecuritiesFvNi: [...amdAt(value), ...amdAt(value + 1, "2026-09-15", "amd-10q-a")],
        }),
        "2026-08-10",
      ).shortTermInvestments;
      expect(part).toEqual({
        status: "incomplete",
        reason:
          "short-term investments (EquitySecuritiesFvNiCurrent) reported nonzero at 2026-03-28 but not tagged at 2026-06-27",
      });
    },
  );

  // Current assets 26,311M = cash 5,086 + debt securities 8,025 + receivables 6,000 + inventory 4,000 + other 2,000
  // + generic equity securities; the generic line is restated by 1M on 2026-09-15.
  const restatedEquity = (unit: string, value: number, publicAt: string) => {
    const operands = {
      ...amdWithoutSti,
      DebtSecuritiesCurrent: amdAt(8025),
      AccountsReceivableNetCurrent: amdAt(6000),
      InventoryNet: amdAt(4000),
      OtherAssetsCurrent: amdAt(2000),
      AssetsCurrent: amdAt(26_311),
    };
    const equity = [...amdAt(value), ...amdAt(value + 1, "2026-09-15", "amd-10q-a")];
    return bridgeAt(
      unit === "USD"
        ? companyFacts({ ...operands, EquitySecuritiesFvNi: equity })
        : withEur(operands, { EquitySecuritiesFvNi: equity }),
      publicAt,
    ).shortTermInvestments;
  };
  test.each([
    ["USD", 1200, "2026-08-10", "withheld"],
    ["USD", 1200, "none", "DebtSecuritiesCurrent + EquitySecuritiesFvNi"],
    ["USD", 30_000, "2026-08-10", "DebtSecuritiesCurrent"],
    ["EUR", 1200, "2026-08-10", "DebtSecuritiesCurrent"],
  ] as const)(
    "%s generic EquitySecuritiesFvNi %j restated later: publicAt %s reads %s",
    (unit, value, publicAt, expected) => {
      const part = restatedEquity(unit, value, publicAt);
      expect(part).toEqual(
        expected === "withheld"
          ? {
              status: "incomplete",
              reason:
                "EquitySecuritiesFvNi at 2026-06-27 was restated on 2026-09-15; the value first filed is withheld",
            }
          : expect.objectContaining({ status: "tagged", concept: expected }),
      );
    },
  );

  test("the artifact reader keeps each bridge list in the order the resolver reads", () => {
    const { artifact } = payloadValuations(
      withEur(
        {
          ...amdWithoutSti,
          ShortTermInvestments: [...usd8025.after, ...amdAt(8055, "2026-09-15", "amd-10q-a")],
        },
        { ShortTermInvestments: amdAt(7300) },
      ),
    );
    const read = readFinancialStatementsArtifact(JSON.parse(JSON.stringify(artifact)));
    expect(read?.enterpriseValueBridge?.shortTermInvestments).toHaveLength(3);
    expect(read?.enterpriseValueBridge).toEqual(artifact.enterpriseValueBridge);
  });

  test("a reporting-currency-only issuer keeps one dated, unmarked bridge row per instant", () => {
    const { shortTermInvestments } = valuations(amd).artifact.enterpriseValueBridge!;
    expect(shortTermInvestments).toEqual([
      expect.objectContaining({
        periodEnd: "2026-06-27",
        concept: "ShortTermInvestments",
        value: 8025 * M,
        unit: "USD",
        firstPublicAt: "2026-08-05",
      }),
    ]);
    expect(shortTermInvestments[0]).not.toHaveProperty("shortTermInvestmentsWithheld");
  });

  // NBIS (CIK 1513845) 20-Fs: FY2022 0001558370-23-006319 and FY2023 0001558370-24-005891 file these lines only in RUB;
  // The FY2024 20-F 0001558370-25-005991 retags 2023-12-31 in USD. Same-filing USD translations readers drop are omitted.
  test.each([
    ["2022-12-31", "2023-04-21", undefined],
    ["2022-12-31", "2025-04-30", undefined],
    ["2022-12-31", "none", undefined],
    ["2023-12-31", "2024-05-01", undefined],
    ["2023-12-31", "2025-04-29", undefined],
    ["2023-12-31", "2025-04-30", [5.1, 0.2]],
    ["2023-12-31", "none", [5.1, 0.2]],
  ] as const)(
    "NBIS %s at publicAt %s: RUB-only lines withhold until USD tags them",
    (instant, publicAt, usd) => {
      const fy22 = ["2023-04-20", "0001558370-23-006319"] as const;
      const fy23 = ["2024-04-26", "0001558370-24-005891"] as const;
      const at = (value: number, end: string, [filed, accn]: readonly [string, string]) =>
        fact(value * M, end, filed, accn, "20-F");
      const resolved = resolveEnterpriseValueBridge(
        payloadValuations(
          withEur(
            {
              DebtSecuritiesCurrent: [
                at(5.1, "2023-12-31", ["2025-04-30", "0001558370-25-005991"]),
              ],
              MinorityInterest: [at(0.2, "2023-12-31", ["2025-04-30", "0001558370-25-005991"])],
            },
            {
              DebtSecuritiesCurrent: [
                at(305, "2022-12-31", fy22),
                at(305, "2022-12-31", fy23),
                at(958, "2023-12-31", fy23),
              ],
              MinorityInterest: [
                at(21_870, "2022-12-31", fy22),
                at(21_870, "2022-12-31", fy23),
                at(16, "2023-12-31", fy23),
              ],
            },
            "RUB",
          ),
        ).artifact.enterpriseValueBridge,
        { value: 1, periodEnd: instant },
        publicAt === "none" ? undefined : publicAt,
      );
      expect([resolved.shortTermInvestments, resolved.noncontrollingInterest]).toEqual(
        usd === undefined
          ? ["DebtSecuritiesCurrent", "MinorityInterest"].map((concept) => ({
              status: "incomplete",
              reason: `${concept} at ${instant} is filed in RUB, not reporting currency USD`,
            }))
          : usd.map((value) => expect.objectContaining({ status: "tagged", value: value * M })),
      );
    },
  );

  // Allot 6-K 0001178913-25-002876 (2025-08-14) tags only AvailableForSaleSecuritiesDebtSecuritiesCurrent 11.518M
  // At 2025-06-30; 6-K 0001178913-25-003436 (2025-09-30) adds MarketableSecuritiesCurrent 33.19M there.
  test("Allot 2025-06-30 at publicAt 2025-08-14 reads the 11.518M AvailableForSaleSecuritiesDebtSecuritiesCurrent", () => {
    const at = (amount: number, filed: string, accn: string) =>
      fact(amount * M, "2025-06-30", filed, accn, "6-K");
    const part = resolveEnterpriseValueBridge(
      payloadValuations(
        companyFacts({
          AvailableForSaleSecuritiesDebtSecuritiesCurrent: [
            at(11.518, "2025-08-14", "0001178913-25-002876"),
            at(11.518, "2025-09-30", "0001178913-25-003436"),
          ],
          MarketableSecuritiesCurrent: [at(33.19, "2025-09-30", "0001178913-25-003436")],
        }),
      ).artifact.enterpriseValueBridge,
      { value: 26.943 * M, periodEnd: "2025-06-30" },
      "2025-08-14",
    ).shortTermInvestments;
    expect(part).toMatchObject({
      status: "tagged",
      value: 11.518 * M,
      concept: "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
    });
  });

  // DoorDash FY2020 10-K 0001628280-21-004032 (2021-03-05): redeemable convertible preferred 2,264M at 2019-12-31
  // = assets 1,732M − liabilities 550M − equity (−1,082M); the FY2022 10-K tags the higher-priority concept 0 there.
  test("DoorDash 2019-12-31 temporary equity at publicAt 2021-03-05 is the 2,264M its FY2020 10-K filed", () => {
    const fy20 = (value: number) => [
      fact(value * M, "2019-12-31", "2021-03-05", "0001628280-21-004032", "10-K"),
    ];
    const resolved = resolveEnterpriseValueBridge(
      payloadValuations(
        companyFacts({
          Assets: fy20(1732),
          Liabilities: fy20(550),
          StockholdersEquity: fy20(-1082),
          TemporaryEquityCarryingAmountAttributableToParent: fy20(2264),
          TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests: [
            fact(0, "2019-12-31", "2023-02-27", "0001628280-23-005131", "10-K"),
          ],
        }),
      ).artifact.enterpriseValueBridge,
      { value: 257 * M, periodEnd: "2019-12-31" },
      "2021-03-05",
    );
    expect(resolved.temporaryEquity).toMatchObject({
      status: "tagged",
      value: 2264 * M,
      concept: "TemporaryEquityCarryingAmountAttributableToParent",
    });
  });

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

  test.each(["legacy", "canonical"] as const)(
    "%s withholds temporary equity 1K off the GPN identity, inside the old 0.1%-of-assets tolerance",
    (path) => {
      const { metrics } = valuations(gpn(210_756))[path];
      expect(metrics?.netDebt).toBe(10_000 * M - 5_408_962_000);
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.temporaryEquityIncompleteReason).toContain("does not reconcile");
    },
  );

  // SPIR 10-Q for the quarter ended 2026-03-31 (filed 2026-05-14, accn 0001193125-26-222710) tags equity incl. NCI at −5,299K.
  test.each(["legacy", "canonical"] as const)(
    "SPIR %s withholds EV when equity including NCI sits below parent equity",
    (path) => {
      const at = (value: number) => [
        fact(value * 1000, "2026-03-31", "2026-05-14", "0001193125-26-222710"),
      ];
      const { metrics } = valuations({
        CashAndCashEquivalentsAtCarryingValue: at(50_000),
        LongTermDebtNoncurrent: at(10_000),
        Assets: at(182_856),
        Liabilities: at(91_650),
        StockholdersEquity: at(91_206),
        StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: at(-5299),
      })[path];
      expect(metrics?.enterpriseValue).toBeUndefined();
      expect(metrics?.temporaryEquity).toBe(0);
      expect(metrics?.noncontrollingInterestIncompleteReason).toContain("is negative");
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
    expect(lineage?.[1]?.label).toContain("sale-restricted");
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

  const DISCLOSED = ["netDebt", "netDebtToMarketCap", "enterpriseValue", "evToAnnualizedRevenue"];
  const snapshot = marketSnapshot({
    symbol: "TEST",
    marketCap: 400_000 * M,
    observedAt: ANALYSIS_AS_OF,
  });
  const lensSurface = (ctx: Parameters<typeof financialLensMetrics>[0]) => {
    const lens = financialLensMetrics({ ...ctx, snapshot });
    const rows = Object.values(lens.lensMetrics)
      .flat()
      .filter((row) => DISCLOSED.includes(row.id));
    const report = researchReport({ extras: { metricSections: lens.sections } });
    const tiles = (metricSectionsView(report as unknown as Record<string, unknown>) ?? [])
      .flatMap((section) => section.metrics)
      .filter((tile) => tile.label === "Net debt");
    return { rows, markdown: renderMetricSections(report), tiles };
  };
  // A fiscal year ending at the balance-sheet instant keeps current EV/revenue within 180 days.
  const freshRevenue = {
    ...fact(120_000 * M, "2026-07-26", "2026-08-26", "0001045810-26-000075", "10-K"),
    fp: "FY",
    start: "2025-07-28",
  };
  const lensSurfaces = (gaap: Facts) => {
    const { artifact, legacy, canonical } = valuations({ ...gaap, Revenues: [freshRevenue] });
    return [
      { symbol: "TEST", statements: artifact, asOf: ANALYSIS_AS_OF, evidence: canonical.evidence! },
      { symbol: "TEST", asOf: ANALYSIS_AS_OF, evidence: legacy.evidence! },
    ].map(lensSurface);
  };

  test("NVDA net debt and EV rows carry the restriction disclosure on statement and evidence paths", () => {
    for (const { rows, markdown, tiles } of lensSurfaces(
      nvda({ EquitySecuritiesFvNi: [{ val: 42_783 * M }] }),
    )) {
      expect(rows.map((row) => row.id).toSorted()).toEqual(DISCLOSED.toSorted());
      for (const row of rows) {
        expect(row.status, row.id).toBe("value");
        expect(noteCount(row.basis), row.id).toBe(1);
      }
      expect(markdown).toMatch(
        /- Net debt: [^\n]*; short-term investments include current equity securities that may be sale-restricted, not cash on hand\)$/mu,
      );
      expect(noteCount(tiles[0]?.basis)).toBe(1);
    }
  });

  test("net debt and EV rows carry no restriction disclosure without current equity securities", () => {
    for (const { rows, markdown, tiles } of lensSurfaces(nvda({}))) {
      expect(rows.length).toBe(DISCLOSED.length);
      for (const row of rows) {
        expect(row.status, row.id).toBe("value");
        expect(row.basis, row.id).not.toContain("sale-restricted");
      }
      expect(markdown).not.toContain("sale-restricted");
      expect(tiles[0]?.basis).not.toContain("sale-restricted");
    }
  });

  test("statement-derived net debt ignores an equity concept on evidence it did not read", () => {
    const { rows } = lensSurface({
      symbol: "TEST",
      statements: valuations(nvda({})).artifact,
      asOf: ANALYSIS_AS_OF,
      evidence: valuations(nvda({ EquitySecuritiesFvNi: [{ val: 42_783 * M }] })).canonical
        .evidence!,
    });
    const basis = Object.fromEntries(rows.map((row) => [row.id, noteCount(row.basis)]));
    expect(basis).toEqual({
      netDebt: 0,
      netDebtToMarketCap: 0,
      enterpriseValue: 1,
      evToAnnualizedRevenue: 1,
    });
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

  test("withholds summary money and the EV bridge when the reporting currency is not USD", () => {
    const accn = "0000002488-26-000123";
    const summary = summarizeSecFundamentals(
      {
        facts: {
          "us-gaap": {
            Revenues: {
              units: {
                EUR: [
                  {
                    ...fact(30_000 * M, "2025-12-27", "2026-02-04", "rev", "10-K"),
                    fp: "FY",
                    start: "2025-01-01",
                  },
                ],
              },
            },
            CashAndCashEquivalentsAtCarryingValue: {
              units: { USD: [fact(5086 * M, "2026-06-27", "2026-08-05", accn)] },
            },
            DebtLongtermAndShorttermCombinedAmount: {
              units: { USD: [fact(3226 * M, "2026-06-27", "2026-08-05", accn)] },
            },
          },
        },
      },
      ANALYSIS_AS_OF,
    );
    expect(summary?.metrics).toEqual({});
    expect(summary?.gaps.map(({ message }) => message)).toContain(
      "SEC summary withheld monetary metrics: us-gaap facts are reported in EUR, so USD-unit facts are convenience translations at an undeclared rate",
    );
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

  test("a withheld generic equity line cannot hide explicit current equity tagged a quarter earlier", () => {
    const resolved = resolveEnterpriseValueBridge(
      facts({
        currentEquitySecurities: [
          bridgeFact(500, "EquitySecuritiesFvNiCurrent", "2026-03-31"),
          {
            ...bridgeFact(700, "EquitySecuritiesFvNi"),
            shortTermInvestmentsWithheld: "EquitySecuritiesFvNi is filed in EUR",
          },
        ],
      }),
      cash,
    );
    expect(resolved.shortTermInvestments).toEqual({
      status: "incomplete",
      reason:
        "short-term investments (EquitySecuritiesFvNiCurrent) reported nonzero at 2026-03-31 but not tagged at 2026-06-30",
    });
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

test("EV basis declares carrying-amount preferred, NCI and temporary equity", () => {
  expect(ENTERPRISE_VALUE_BASIS).toContain(
    "preferred stock, noncontrolling interest and temporary equity at balance-sheet carrying amount, not market, liquidation or redemption value",
  );
});

describe("extension short-term investments proven from the filing's XBRL instance", () => {
  // EBAY 10-Q for the quarter ended 2026-09-30 (filed 2026-10-29, accn 0001065088-26-000212).
  const accn = "0001065088-26-000212";
  const asOf = "2026-11-04T00:00:00.000Z";
  const sep = (value: number) => fact(value * M, "2026-09-30", "2026-10-29", accn);
  const line = "ebay:ShortTermInvestmentsExcludingEquitySecuritiesAccountedForUnderFairValueOption";
  const proofItem = (metrics: Record<string, number | string> = {}, total = "4786000000") => ({
    category: "sec-edgar" as const,
    title: "EBAY 10-Q",
    summary: "EBAY 10-Q.",
    sourceIds: ["extended-sec-edgar-ebay-10q", "extended-sec-edgar-ebay-10q-investments-instance"],
    observedAt: asOf,
    metrics: {
      accessionNumber: accn,
      [`extensionShortTermInvestments|2026-09-30|USD|${line}|${total}`]: 809 * M,
      "extensionShortTermInvestmentsProof|2026-09-30": `${line} = 809000000 USD at 2026-09-30`,
      ...metrics,
    },
  });
  const ebay: Facts = {
    CashAndCashEquivalentsAtCarryingValue: [sep(1166)],
    AssetsCurrent: [sep(4786)],
    LongTermDebt: [sep(6500)],
    ShortTermInvestments: [fact(2500 * M, "2024-12-31", "2025-02-20", "ebay-fy24", "10-K")],
  };
  const bridgeAt = (gaap: Facts, secFilings: readonly ReturnType<typeof proofItem>[]) => {
    const payload = companyFacts(gaap);
    const artifact = deriveFinancialStatements(payload, {
      symbol: "EBAY",
      generatedAt: asOf,
      analysisAsOf: asOf,
      sourceId: "extended-sec-edgar-ebay-fundamentals",
      secFilings,
    });
    const sti = artifact.enterpriseValueBridge!.shortTermInvestments.find(
      ({ periodEnd }) => periodEnd === "2026-09-30",
    );
    return { artifact, sti };
  };

  const valuationAt = (artifact: ReturnType<typeof bridgeAt>["artifact"]) =>
    valuationOf(
      addValuationEvidence(
        { jobType: "equity", assetClass: "equity", symbol: "EBAY", depth: "deep" },
        [marketSnapshot({ symbol: "EBAY", marketCap: 40_000 * M, observedAt: asOf })],
        withCanonicalFinancialLensInputs(secEvidence({}), artifact),
        asOf,
      ),
    );

  test("eBay's extension line enters the bridge as 809M, cited to the 10-Q and its instance", () => {
    const { sti, artifact } = bridgeAt(ebay, [proofItem()]);
    const { metrics, summary } = valuationAt(artifact);
    expect(metrics).toMatchObject({
      shortTermInvestments: 809 * M,
      netDebt: (6500 - 1166 - 809) * M,
    });
    expect(summary).not.toContain("sale-restricted");
    expect(sti).toMatchObject({
      value: 809 * M,
      concept: line,
      accessionNumber: accn,
      filedAt: "2026-10-29",
      shortTermInvestmentsProof: expect.stringContaining("809000000 USD at 2026-09-30"),
    });
    expect(sti?.sourceIds).toEqual(
      expect.arrayContaining(["extended-sec-edgar-ebay-10q-investments-instance"]),
    );
  });

  test.each([
    ["without the proof item", []],
    ["without its proof text", [proofItem({ "extensionShortTermInvestmentsProof|2026-09-30": 0 })]],
  ] as const)("nothing enters %s", (_label, items) => {
    expect(bridgeAt(ebay, items).sti?.value).not.toBe(809 * M);
  });

  test.each([
    ["with an AssetsCurrent total the companyfacts do not carry", [proofItem({}, "4800000000")]],
    ["from another accession", [proofItem({ accessionNumber: "0001065088-26-000999" })]],
    [
      "in another currency",
      [
        {
          ...proofItem(),
          metrics: {
            accessionNumber: accn,
            [`extensionShortTermInvestments|2026-09-30|EUR|${line}|4786000000`]: 809 * M,
            "extensionShortTermInvestmentsProof|2026-09-30": `${line} = 809000000 EUR at 2026-09-30`,
          },
        },
      ],
    ],
  ] as const)("a proven line %s withholds the bridge instead of reading 0", (_label, items) => {
    const { sti, artifact } = bridgeAt(ebay, items);
    expect(sti?.shortTermInvestmentsWithheld).toContain("withheld");
    const { metrics, gaps } = valuationAt(artifact);
    expect(metrics?.shortTermInvestments).toBeUndefined();
    expect(metrics?.netDebt).toBeUndefined();
    expect(gaps.map(({ message }) => message)).toEqual(
      expect.arrayContaining([expect.stringContaining("SEC EV bridge incomplete for EBAY")]),
    );
  });

  test("a proof whose 10-Q companyfacts does not carry yet still withholds its instant", () => {
    const { sti } = bridgeAt({ ShortTermInvestments: ebay.ShortTermInvestments! }, [
      proofItem({ form: "10-Q", filingDate: "2026-10-29" }),
    ]);
    expect(sti).toMatchObject({
      accessionNumber: accn,
      filedAt: "2026-10-29",
      firstPublicAt: "2026-10-29",
      shortTermInvestmentsWithheld: expect.stringContaining("companyfacts carry no AssetsCurrent"),
    });
  });

  test("a later filing's value for the instant wins, dated from when that value first held", () => {
    const filing = (accessionNumber: string, filingDate: string, value: number) => ({
      ...proofItem(),
      metrics: {
        accessionNumber,
        filingDate,
        [`extensionShortTermInvestments|2026-09-30|USD|${line}|4786000000`]: value * M,
        "extensionShortTermInvestmentsProof|2026-09-30": `${line} = ${value * M} USD at 2026-09-30`,
      },
    });
    const restated = {
      ...ebay,
      AssetsCurrent: [
        sep(4786),
        fact(4786 * M, "2026-09-30", "2026-10-31", "amend-1", "10-Q/A"),
        fact(4786 * M, "2026-09-30", "2026-11-02", "amend-2", "10-Q/A"),
      ],
    };
    const { sti } = bridgeAt(restated, [
      filing(accn, "2026-10-29", 809),
      filing("amend-1", "2026-10-31", 815),
      filing("amend-2", "2026-11-02", 815),
    ]);
    expect(sti).toMatchObject({ value: 815 * M, firstPublicAt: "2026-10-31" });
  });

  test("only us-gaap equity-security concepts carry the sale-restricted caveat", () => {
    expect(isCurrentEquityConcept(line)).toBe(false);
    expect(isCurrentEquityConcept("ShortTermInvestments + EquitySecuritiesFvNiCurrent")).toBe(true);
    expect(isCurrentEquityConcept("EquitySecuritiesFvNi")).toBe(true);
    expect(isCurrentEquityConcept(undefined)).toBe(false);
  });

  // A standard ShortTermInvestments line filed only in EUR on 2026-11-01 overrides the extension fallback.
  test.each([
    ["2026-10-30", "the extension", { status: "tagged", value: 809 * M, concept: line }],
    [
      "2026-11-02",
      "the EUR tag",
      {
        status: "incomplete",
        reason: "ShortTermInvestments at 2026-09-30 is filed in EUR, not reporting currency USD",
      },
    ],
  ] as const)(
    "a foreign standard tag after the extension: publicAt %s reads %s",
    (publicAt, _label, expected) => {
      const artifact = deriveFinancialStatements(
        withEur(ebay, {
          ShortTermInvestments: [fact(800 * M, "2026-09-30", "2026-11-01", "ebay-10qa", "10-Q/A")],
        }),
        {
          symbol: "EBAY",
          generatedAt: asOf,
          analysisAsOf: asOf,
          sourceId: "extended-sec-edgar-ebay-fundamentals",
          secFilings: [proofItem()],
        },
      );
      expect(
        resolveEnterpriseValueBridge(
          artifact.enterpriseValueBridge,
          { value: 1166 * M, periodEnd: "2026-09-30" },
          publicAt,
        ).shortTermInvestments,
      ).toMatchObject(expected);
      expect(valuationAt(artifact).metrics?.netDebt).toBeUndefined();
    },
  );

  test("a standard ShortTermInvestments tag at the instant stays the bridge value", () => {
    const { sti } = bridgeAt({ ...ebay, ShortTermInvestments: [sep(700)] }, [proofItem()]);
    expect(sti).toMatchObject({ value: 700 * M, concept: "ShortTermInvestments" });
  });
});
