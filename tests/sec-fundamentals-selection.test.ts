import { CAPEX_SCOPE_CAVEAT } from "../src/sources/extended-evidence/financial-statement-definitions";
import { describe, expect, test } from "bun:test";
import type { RunDetail } from "../app/types";
import type { RunSummary } from "../src/run-artifact-index-types";
import {
  financialTrendFromProjection,
  fundamentalHistoryView,
} from "../app/client/run-workspace-financials";
import { composeEquitySnapshot } from "../app/client/run-workspace-snapshot";
import { reverseDcfView, valuationWorkbenchView } from "../app/client/run-workspace-valuation";
import { financialTrendGaps, financialTrends } from "../src/report/equity-reader-trends";
import { renderProjectedFinancialTrends } from "../src/report/markdown-equity-sections";
import { renderReverseDcfMarkdown } from "../src/report/reverse-dcf-markdown";
import { renderValuationWorkbenchMarkdown } from "../src/report/valuation-workbench-markdown";
import {
  buildReverseDcf,
  readReverseDcfArtifact,
} from "../src/sources/extended-evidence/reverse-dcf";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";
import { readValuationWorkbenchArtifact } from "../src/sources/extended-evidence/valuation-workbench-contract";
import { researchReport, reverseDcfWorkbench } from "./support/fixtures";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { summaryLens } from "./support/financial-lens";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { collectEquityEnrichment } from "../src/sources/collector-equity-enrichment";
import type { SourceGap } from "../src/domain/sources";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import {
  metricReferenceEvidence,
  withoutRestatedMetricValues,
} from "../src/research/prompts/metric-references";
import { deltaPercent } from "../src/sources/extended-evidence/sec-fundamentals-format";
import { CAPEX_CALC_PREFIX } from "../src/sources/sec-calculation-linkbase";

const AS_OF = "2026-10-07T00:00:00.000Z";
const TOTAL_OCF = "NetCashProvidedByUsedInOperatingActivities";
const CONTINUING_OCF = "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
const CURRENT_ACCN = "0001171843-26-005329";

type Row = Record<string, unknown>;

function row(
  val: number,
  start: string | undefined,
  end: string,
  form: string,
  fy: number,
  fp: string,
  filed: string,
  accn?: string,
): Row {
  return {
    val,
    ...(start !== undefined ? { start } : {}),
    end,
    form,
    fy,
    fp,
    filed,
    ...(accn !== undefined ? { accn } : {}),
  };
}

const fy25k = (val: number, start = "2024-10-01", end = "2025-09-30"): Row =>
  row(val, start, end, "10-K", 2025, "FY", "2025-11-25", "0001171843-25-007594");
const q3PriorFiling = (val: number, start = "2024-10-01"): Row =>
  row(val, start, "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07", "0001171843-25-005167");
const q3Current = (val: number, start = "2025-10-01", end = "2026-06-30"): Row =>
  row(val, start, end, "10-Q", 2026, "Q3", "2026-08-06", CURRENT_ACCN);

function payload(concepts: Readonly<Record<string, readonly Row[]>>): unknown {
  return {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries(concepts).map(([concept, rows]) => [concept, { units: { USD: rows } }]),
      ),
    },
  };
}

// CLFD shape: total OCF stops a year earlier; the restated comparative lives in the current 10-Q.
function clfdConcepts(): Record<string, readonly Row[]> {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: [
      q3PriorFiling(132_547_000),
      q3Current(109_074_000, "2024-10-01", "2025-06-30"),
      q3Current(38_755_000, "2025-04-01", "2025-06-30"),
      fy25k(150_134_000),
      q3Current(112_596_000),
      q3Current(43_864_000, "2026-04-01"),
    ],
    [TOTAL_OCF]: [
      row(22_223_000, "2023-10-01", "2024-09-30", "10-K", 2024, "FY", "2024-11-15", "a-24"),
      q3PriorFiling(18_116_000),
    ],
    [CONTINUING_OCF]: [
      fy25k(17_770_000, "2023-10-01", "2024-09-30"),
      q3Current(22_423_000, "2024-10-01", "2025-06-30"),
      fy25k(26_553_000),
      q3Current(7_345_000),
    ],
    PaymentsToAcquirePropertyPlantAndEquipment: [q3PriorFiling(4_480_000)],
    PaymentsToAcquireProductiveAssets: [
      q3Current(3_529_000, "2024-10-01", "2025-06-30"),
      fy25k(4_743_000),
      q3Current(2_917_000),
    ],
  };
}

// CLFD's FY2025 10-K and Q3 FY2026 10-Q calculation linkbases subtract this capex inside continuing investing.
const CLFD_CAPEX_CALC: readonly ExtendedEvidenceItem[] = ["0001171843-25-007594", CURRENT_ACCN].map(
  (accessionNumber) => ({
    category: "sec-edgar",
    title: "CLFD SEC filing",
    summary: "",
    sourceIds: [accessionNumber],
    observedAt: AS_OF,
    metrics: {
      accessionNumber,
      [`${CAPEX_CALC_PREFIX}PaymentsToAcquireProductiveAssets`]: -1,
    },
  }),
);

function statementsFor(concepts: Readonly<Record<string, readonly Row[]>>, asOf = AS_OF) {
  return deriveFinancialStatements(payload(concepts), {
    secFilings: CLFD_CAPEX_CALC,
    symbol: "CLFD",
    generatedAt: asOf,
    analysisAsOf: asOf,
    sourceId: "sec-clfd",
  });
}

function canonicalSecItem(
  concepts: Readonly<Record<string, readonly Row[]>>,
): ExtendedEvidenceItem {
  const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
  const evidence = withCanonicalFinancialLensInputs(
    {
      items: [
        {
          category: "sec-edgar",
          title: "CLFD SEC fundamentals",
          summary: legacy.summary,
          sourceIds: ["sec-clfd"],
          observedAt: AS_OF,
          metrics: legacy.metrics,
        },
      ],
      gaps: [],
    },
    statementsFor(concepts),
  );
  return evidence.items[0]!;
}

describe("continuing-operations cash-flow aliases", () => {
  test("selects the current continuing-operations OCF over a stale total tag and labels its scope", () => {
    const summary = summarizeSecFundamentals(payload(clfdConcepts()), AS_OF)!;

    expect(summary.summary).toContain(
      "operating cash flow (continuing operations) 7345000 (-67.2% YoY)",
    );
    expect(summary.metrics).toMatchObject({
      operatingCashFlow: 7_345_000,
      operatingCashFlowPeriodEnd: "2026-06-30",
      operatingCashFlowPrior: 22_423_000,
      operatingCashFlowScope: "continuing operations",
    });
    // Capex beside continuing OCF needs the filing's calculation linkbase, which only the canonical series reads.
    expect(summary.summary).not.toContain("capex");
    expect(summary.metrics.capex).toBeUndefined();
    expect(summary.gaps.map((gap) => gap.message).join("\n")).not.toContain("operatingCashFlow");
  });

  test("keeps one concept per canonical series, so TTM never splices total and continuing OCF", () => {
    const artifact = statementsFor(clfdConcepts());
    const ocf = artifact.statements.cashFlowStatement.operatingCashFlow;

    expect(new Set(financialStatementFacts(ocf).map((fact) => fact.concept))).toEqual(
      new Set([CONTINUING_OCF]),
    );
    expect(ocf.ttm?.value).toBe(26_553_000 + 7_345_000 - 22_423_000);
    expect(Object.values(ocf.ttm!.components).map((fact) => fact.concept)).toEqual([
      CONTINUING_OCF,
      CONTINUING_OCF,
      CONTINUING_OCF,
    ]);
    expect(
      artifact.validationNotes.filter(
        (note) =>
          note.code === "incomplete-statement" &&
          note.message.startsWith("cashFlowStatement interim period duration:9|2026-06-30"),
      ),
    ).toEqual([]);
  });

  test("carries the scope label through canonical history and the lenses", () => {
    const canonical = deriveFundamentalHistoryFromFinancialStatements(
      statementsFor(clfdConcepts()),
    );
    const item = canonicalSecItem(clfdConcepts());
    const labels = [
      ...summaryLens(item, "Quality", AS_OF, statementsFor(clfdConcepts())).metrics,
      ...summaryLens(item, "Growth", AS_OF, statementsFor(clfdConcepts())).metrics,
    ].map((metric) => metric.label);

    expect(canonical.series.operatingCashFlow.concept).toBe(CONTINUING_OCF);
    expect(canonical.series.operatingCashFlow.label).toBe(
      "Operating cash flow (continuing operations)",
    );
    expect(canonical.series.freeCashFlowProxy.label).toBe(
      "Free cash flow proxy (continuing operations)",
    );
    expect(item.metrics?.operatingCashFlowScope).toBe("continuing operations");
    expect(labels).toContain("Operating cash flow YoY (continuing operations)");
    expect(labels).toContain("FCF proxy (continuing operations)");
    expect(
      summaryLens(item, "Quality", AS_OF, statementsFor(clfdConcepts())).metrics.find(
        ({ key }) => key === "freeCashFlowProxy",
      )?.value,
    ).toBe(7_345_000 - 2_917_000);
  });

  test("the continuing tag wins an equal period, so OCF stays on the scope of revenue", () => {
    const concepts = {
      ...clfdConcepts(),
      [TOTAL_OCF]: [q3Current(50)],
      [CONTINUING_OCF]: [q3Current(20, "2024-10-01", "2025-06-30"), q3Current(30)],
    };
    const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const ocf = statementsFor(concepts).statements.cashFlowStatement.operatingCashFlow;

    expect(summary.metrics.operatingCashFlow).toBe(30);
    expect(summary.metrics.operatingCashFlowPrior).toBe(20);
    expect(summary.metrics.operatingCashFlowScope).toBe("continuing operations");
    expect(new Set(financialStatementFacts(ocf).map((fact) => fact.concept))).toEqual(
      new Set([CONTINUING_OCF]),
    );
  });

  test("the continuing tag wins an equal period when it was filed later", () => {
    const concepts = {
      ...clfdConcepts(),
      [TOTAL_OCF]: [
        row(22_000_000, "2024-10-01", "2025-06-30", "10-Q", 2026, "Q3", "2026-08-01", "a-1"),
        row(9_000_000, "2025-10-01", "2026-06-30", "10-Q", 2026, "Q3", "2026-08-01", "a-1"),
        fy25k(30_000_000),
      ],
    };
    const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const artifact = statementsFor(concepts);
    const history = deriveFundamentalHistoryFromFinancialStatements(artifact);

    expect(summary.metrics.operatingCashFlow).toBe(7_345_000);
    expect(summary.metrics.operatingCashFlowScope).toBe("continuing operations");
    expect(history.series.operatingCashFlow.concept).toBe(CONTINUING_OCF);
    expect(history.series.operatingCashFlow.label).toBe(
      "Operating cash flow (continuing operations)",
    );
  });

  test("falls back to the total tag when continuing facts post-date the cutoff", () => {
    const asOf = "2025-09-01T00:00:00.000Z";
    const concepts = {
      ...clfdConcepts(),
      [CONTINUING_OCF]: [q3Current(7_345_000)],
    };
    const summary = summarizeSecFundamentals(payload(concepts), asOf)!;
    const history = deriveFundamentalHistoryFromFinancialStatements(statementsFor(concepts, asOf));

    expect(summary.metrics.operatingCashFlow).toBe(18_116_000);
    expect(summary.metrics.operatingCashFlowScope).toBeUndefined();
    expect(history.series.operatingCashFlow.concept).toBe(TOTAL_OCF);
  });

  test("declares the missing fact when neither OCF alias is tagged", () => {
    const { [TOTAL_OCF]: _total, [CONTINUING_OCF]: _continuing, ...concepts } = clfdConcepts();
    const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const history = deriveFundamentalHistoryFromFinancialStatements(statementsFor(concepts));

    expect(summary.gaps.map((gap) => gap.message)).toContainEqual(
      expect.stringMatching(/^Missing SEC company facts: .*operatingCashFlow/u),
    );
    expect(history.series.operatingCashFlow.label).toBe("Operating cash flow");
    expect(history.series.operatingCashFlow.notes).toContain(
      "annual:missing-concept: no canonical annual facts found",
    );
    expect(history.series.freeCashFlowProxy.notes).toContain(
      "ttm:missing-component: both component TTM points are required",
    );
  });
});

describe("trailing-twelve-month revenue", () => {
  const revenueConcept = "RevenueFromContractWithCustomerExcludingAssessedTax";

  test("legacy and canonical reconcile FY + latest YTD − restated prior YTD", () => {
    const summary = summarizeSecFundamentals(payload(clfdConcepts()), AS_OF)!;

    expect(summary.metrics.revenueTtm).toBe(150_134_000 + 112_596_000 - 109_074_000);
    expect(canonicalSecItem(clfdConcepts()).metrics?.revenueTtm).toBe(summary.metrics.revenueTtm);
  });

  test("a latest 12-month fact is its own TTM", () => {
    const concepts = { [revenueConcept]: [fy25k(150_134_000)] };

    expect(summarizeSecFundamentals(payload(concepts), AS_OF)!.metrics.revenueTtm).toBe(
      150_134_000,
    );
    expect(canonicalSecItem(concepts).metrics?.revenueTtm).toBe(150_134_000);
  });

  test("emits no TTM when the fiscal year that opens the YTD is missing", () => {
    const concepts = {
      ...clfdConcepts(),
      [revenueConcept]: clfdConcepts()[revenueConcept]!.filter((fact) => fact.form !== "10-K"),
    };

    expect(summarizeSecFundamentals(payload(concepts), AS_OF)!.metrics).not.toHaveProperty(
      "revenueTtm",
    );
    expect(canonicalSecItem(concepts).metrics).not.toHaveProperty("revenueTtm");
  });

  test.each(["2026-09-01", "2026-08-05"])(
    "never reconciles a superseded YTD when its amendment filed %s does not reconcile",
    (amendmentFiledAt) => {
      const concepts = {
        [revenueConcept]: [
          row(1000, "2025-01-01", "2025-12-31", "10-K", 2025, "FY", "2026-02-15", "fy25"),
          row(100, "2025-01-01", "2025-06-30", "10-Q", 2025, "Q2", "2025-08-05", "h1-25"),
          row(200, "2026-01-01", "2026-06-30", "10-Q", 2026, "Q2", "2026-08-05", "h1-26"),
          row(600, "2026-01-12", "2026-06-30", "10-Q/A", 2026, "Q2", amendmentFiledAt, "h1-26a"),
        ],
      };
      const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;

      expect(legacy.metrics.revenue).toBe(600);
      expect(legacy.metrics).not.toHaveProperty("revenueTtm");
      expect(canonicalSecItem(concepts).metrics).not.toHaveProperty("revenueTtm");
    },
  );

  test("a same-day 10-K/A that corrects the start supersedes the annual shortcut", () => {
    const concepts = {
      [revenueConcept]: [
        row(1000, "2025-01-01", "2025-12-31", "10-K", 2025, "FY", "2026-02-15", "fy25"),
        row(600, "2025-01-12", "2025-12-31", "10-K/A", 2025, "FY", "2026-02-15", "fy25a"),
      ],
    };
    const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const canonical = canonicalSecItem(concepts).metrics;

    expect(legacy.metrics.revenue).toBe(600);
    expect(legacy.metrics.revenueTtm).toBe(600);
    expect(canonical?.revenue).toBe(600);
    expect(canonical?.revenueTtm).toBe(600);
  });
});

describe("legacy YoY comparatives", () => {
  // NBIS FY2025 20-F and CECO FY2025 10-K endpoints, as (latest, prior).
  test.each([
    [82.5, -641.4, undefined],
    [-20.8, 89.3, undefined],
    [-611.7, -399.6, undefined],
    [121.4, -4.1, undefined],
    [1, 0, undefined],
    [0, 10, -100],
  ])("deltaPercent(%d, %d) is %p", (latest, prior, expected) => {
    expect(deltaPercent(latest, prior)).toBe(expected);
  });

  test("deltaPercent keeps a value between positive endpoints", () => {
    expect(deltaPercent(529.8, 91.5)).toBeCloseTo(479.016_393_442_623, 9);
  });

  test("uses the restated comparative so summary prose agrees with canonical metrics", () => {
    const summary = summarizeSecFundamentals(payload(clfdConcepts()), AS_OF)!;
    const item = canonicalSecItem(clfdConcepts());

    expect(summary.metrics.revenuePrior).toBe(109_074_000);
    expect(summary.summary).toContain("revenue 112596000 (3.2% YoY)");
    expect(item.metrics?.revenuePrior).toBe(summary.metrics.revenuePrior);
    expect(item.metrics?.revenuePriorPeriodEnd).toBe(summary.metrics.revenuePriorPeriodEnd);
    expect(summary.metrics.revenuePriorPeriodEnd).toBe("2025-06-30");
    expect(item.metrics?.revenueDeltaPercent).toBeCloseTo(
      summary.metrics.revenueDeltaPercent as number,
      10,
    );
    // The canonical series restores capex the linkbase proves on the continuing OCF's scope.
    expect(item.summary).toBe(`${summary.summary.slice(0, -1)}, capex 2917000 (-17.3% YoY).`);
  });

  test("renders fundamentals prose from canonical metrics when legacy picks a different prior", () => {
    const concepts = {
      ...clfdConcepts(),
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        q3PriorFiling(132_547_000),
        row(
          109_074_000,
          "2024-10-01",
          "2025-06-30",
          "10-Q",
          2026,
          "Q2",
          "2026-08-06",
          CURRENT_ACCN,
        ),
        fy25k(150_134_000),
        q3Current(112_596_000),
      ],
    };
    const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const item = canonicalSecItem(concepts);

    expect(legacy.summary).toContain("revenue 112596000 (-15.1% YoY)");
    expect(item.metrics?.revenuePrior).toBe(109_074_000);
    expect(item.summary).toContain("revenue 112596000 (3.2% YoY)");
    expect(item.summary).toContain("operating cash flow (continuing operations) 7345000");
  });

  test("never borrows a legacy comparative for a canonical key", () => {
    const concepts = {
      ...clfdConcepts(),
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        row(90, "2024-10-16", "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07", "q3-25"),
        fy25k(150_134_000),
        q3Current(100),
      ],
      [TOTAL_OCF]: [q3Current(50, "2025-10-31")],
      [CONTINUING_OCF]: [q3Current(20, "2024-10-01", "2025-06-30"), q3Current(50)],
    };
    const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const item = canonicalSecItem(concepts);

    expect(legacy.summary).toContain("revenue 100 (11.1% YoY)");
    expect(legacy.summary).toContain("operating cash flow (continuing operations) 50 (150.0% YoY)");
    expect(item.metrics?.revenuePrior).toBeUndefined();
    expect(item.summary).toContain("revenue 100,");
    expect(item.summary).toContain("operating cash flow (continuing operations) 50 (150.0% YoY)");
  });

  test("duration rows without a start never pair as instants", () => {
    const concepts = {
      ...clfdConcepts(),
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        row(50, undefined, "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07", "q3-25"),
        row(100, undefined, "2026-06-30", "10-Q", 2026, "Q3", "2026-08-06", CURRENT_ACCN),
      ],
      [TOTAL_OCF]: [
        row(20, undefined, "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07", "q3-25"),
        row(40, undefined, "2026-06-30", "10-Q", 2026, "Q3", "2026-08-06", CURRENT_ACCN),
      ],
      [CONTINUING_OCF]: [],
    };
    const item = canonicalSecItem(concepts);

    expect(item.metrics).toMatchObject({ revenue: 100, operatingCashFlow: 40 });
    expect(item.metrics?.revenuePrior).toBeUndefined();
    expect(item.metrics?.operatingCashFlowPrior).toBeUndefined();
    expect(item.summary).not.toContain("100.0% YoY");
  });

  test("canonical balance-sheet comparatives come from the year-ago instant of the same concept", () => {
    const concepts = {
      ...clfdConcepts(),
      CashAndCashEquivalentsAtCarryingValue: [
        row(25, undefined, "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07", "q3-25"),
        row(28, undefined, "2025-09-30", "10-K", 2025, "FY", "2025-11-25", "k-25"),
        row(30, undefined, "2026-06-30", "10-Q", 2026, "Q3", "2026-08-06", CURRENT_ACCN),
      ],
    };
    const item = canonicalSecItem(concepts);

    expect(item.metrics).toMatchObject({ cash: 30, cashPrior: 25, cashDeltaPercent: 20 });
    expect(item.summary).toContain("cash 30 (20.0% YoY)");
  });

  test("keeps the filings prefix and legacy-only metrics, and is idempotent", () => {
    const concepts = {
      ...clfdConcepts(),
      PaymentsForRepurchaseOfCommonStock: [q3Current(13_494_000)],
    };
    const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const filings = "Recent SEC filings: 10-Q 2026-08-06.";
    const artifact = statementsFor(concepts);
    const withLegacy = withCanonicalFinancialLensInputs(
      {
        items: [
          {
            category: "sec-edgar",
            title: "CLFD SEC fundamentals",
            summary: `${filings} ${legacy.summary}`,
            sourceIds: ["sec-clfd"],
            observedAt: AS_OF,
            metrics: legacy.metrics,
          },
        ],
        gaps: [],
      },
      artifact,
    ).items[0]!;
    const canonicalOnly = withCanonicalFinancialLensInputs(undefined, artifact).items[0]!;

    expect(withLegacy.summary).toStartWith(
      `${filings} SEC Fundamental Evidence: revenue 112596000`,
    );
    expect(withLegacy.summary).toContain("share repurchases 13494000");
    expect(canonicalOnly.summary).toBe("Canonical SEC financial statement inputs.");
    expect(
      withCanonicalFinancialLensInputs({ items: [withLegacy], gaps: [] }, artifact).items[0]
        ?.summary,
    ).toBe(withLegacy.summary);
  });

  test("prefers a later amendment in another accession and tolerates missing accessions", () => {
    const concepts = {
      ...clfdConcepts(),
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        row(132_547_000, "2024-10-01", "2025-06-30", "10-Q", 2025, "Q3", "2025-08-07"),
        row(120_000_000, "2024-10-01", "2025-06-30", "10-Q/A", 2025, "Q3", "2025-12-01"),
        row(112_596_000, "2025-10-01", "2026-06-30", "10-Q", 2026, "Q3", "2026-08-06"),
      ],
    };

    expect(summarizeSecFundamentals(payload(concepts), AS_OF)!.metrics.revenuePrior).toBe(
      120_000_000,
    );
  });

  test("ignores a later restatement filed after the analysis cutoff", () => {
    const concepts = {
      ...clfdConcepts(),
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        q3PriorFiling(132_547_000),
        q3Current(109_074_000, "2024-10-01", "2025-06-30"),
        q3Current(112_596_000),
        row(120_000_000, "2024-10-01", "2025-06-30", "10-Q/A", 2025, "Q3", "2026-09-01", "amend"),
      ],
    };
    const summary = summarizeSecFundamentals(payload(concepts), "2026-08-15T00:00:00.000Z")!;

    expect(summary.metrics.revenuePrior).toBe(109_074_000);
  });

  test("debt priors take the latest-filed comparative balance", () => {
    const concepts = {
      ...clfdConcepts(),
      LongTermDebt: [
        row(100, undefined, "2025-09-30", "10-K", 2025, "FY", "2025-11-25", "k-25"),
        row(110, undefined, "2025-09-30", "10-K", 2026, "FY", "2026-11-20", "k-26"),
        row(90, undefined, "2026-09-30", "10-K", 2026, "FY", "2026-11-20", "k-26"),
      ],
    };
    const summary = summarizeSecFundamentals(payload(concepts), "2026-12-01T00:00:00.000Z")!;

    expect(summary.metrics.debt).toBe(90);
    expect(summary.metrics.debtPrior).toBe(110);
  });
});

function detail(fields: Partial<RunDetail>): RunDetail {
  return { summary: {} as RunSummary, ...fields };
}

describe("continuing-operations scope in reader views", () => {
  const artifact = statementsFor(clfdConcepts());
  const history = deriveFundamentalHistoryFromFinancialStatements(artifact);

  test("financial trends, history cards, and snapshot carry the scope", () => {
    const trends = financialTrends(history, undefined)!;
    const cards = fundamentalHistoryView(detail({ fundamentalHistory: history }))!;
    const snapshot = composeEquitySnapshot({
      fundamentalHistory: cards,
      financialLensGroups: [],
      cases: [],
    });

    expect(trends.freeCashFlowScope).toBe("continuing operations");
    expect(renderProjectedFinancialTrends(researchReport(), trends)).toContain(
      `reported operating-cash-flow (continuing operations) less capex proxy; ${CAPEX_SCOPE_CAVEAT}.`,
    );
    expect(cards.cards.find((card) => card.key === "freeCashFlowProxy")?.disclosure).toContain(
      `FCF scope: ${CAPEX_SCOPE_CAVEAT}.`,
    );
    expect(financialTrendFromProjection(trends)?.freeCashFlowLabel).toBe(
      "FCF proxy (continuing operations)",
    );
    expect(snapshot.keyDatedMetrics.metrics.map((metric) => metric.label)).toContain(
      "TTM FCF proxy (continuing operations)",
    );
    expect(snapshot.miniCharts.charts.map((chart) => chart.label)).toContain(
      "FCF proxy (continuing operations)",
    );
  });

  test("valuation workbench and reverse DCF disclose the scoped FCF input", () => {
    const workbench = buildValuationWorkbench({
      generatedAt: AS_OF,
      symbol: "CLFD",
      financialStatements: artifact,
      priceHistory: [],
      quoteCurrency: "USD",
    });
    const ttm = workbench.historicalMultiples.observations.find(
      (observation) => observation.basis === "ttm",
    )!;
    const base = reverseDcfWorkbench();
    const [fixtureObservation] = base.historicalMultiples.observations;
    const reverseDcf = buildReverseDcf({
      generatedAt: AS_OF,
      symbol: "CLFD",
      valuationWorkbench: {
        ...base,
        historicalMultiples: {
          ...base.historicalMultiples,
          observations: [
            {
              ...fixtureObservation!,
              inputs: { ...fixtureObservation!.inputs, freeCashFlow: ttm.inputs.freeCashFlow! },
            },
          ],
        },
      },
    });
    const reverseView = reverseDcfView(detail({ reverseDcf }));

    expect(ttm.inputs.freeCashFlow).toMatchObject({
      label: "Free cash flow proxy (continuing operations)",
      scope: "continuing operations",
    });
    expect(readValuationWorkbenchArtifact(workbench)).toBeDefined();
    expect(renderValuationWorkbenchMarkdown(workbench, researchReport())).toContain(
      `- P/FCF uses free cash flow proxy (continuing operations) for annual 2025-09-30, ttm ${ttm.periodEnd}; ${CAPEX_SCOPE_CAVEAT}.`,
    );
    expect(
      valuationWorkbenchView(detail({ valuationWorkbench: workbench }))?.scopeDisclosure,
    ).toContain("P/FCF uses free cash flow proxy (continuing operations)");
    expect(reverseDcf.status).toBe("computed");
    expect(readReverseDcfArtifact(reverseDcf)).toBeDefined();
    expect(renderReverseDcfMarkdown(reverseDcf)).toContain(
      "- Starting FCF (continuing operations):",
    );
    expect(reverseView?.status === "computed" ? reverseView.startingFcfLabel : undefined).toBe(
      "Starting FCF (continuing operations)",
    );
  });
});

const gapText = (gaps: readonly SourceGap[] = []) => gaps.map(({ message }) => message).join("\n");
const failedRequest = async () => ({
  source: "sec-edgar",
  message: "SEC request failed: status 503",
});

const eqix10k = (val: number, year: number): Row =>
  row(
    val,
    `${year}-01-01`,
    `${year}-12-31`,
    "10-K",
    2025,
    "FY",
    "2026-02-11",
    "0001101239-26-000032",
  );
const eqixYears = (values: readonly number[]) =>
  values.map((val, index) => eqix10k(val, 2023 + index));

// EQIX FY2023-FY2025 10-K companyfacts (cached 2026-11-14): PP&E capex beside real estate purchases.
function eqixConcepts(): Record<string, readonly Row[]> {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: eqixYears([
      8_188_000_000, 8_748_000_000, 9_217_000_000,
    ]),
    NetIncomeLoss: eqixYears([969_000_000, 815_000_000, 1_350_000_000]),
    [TOTAL_OCF]: eqixYears([3_217_000_000, 3_249_000_000, 3_911_000_000]),
    PaymentsToAcquireProductiveAssets: eqixYears([2_781_000_000, 3_066_000_000, 4_311_000_000]),
    PaymentsToAcquireRealEstate: eqixYears([384_000_000, 337_000_000, 994_000_000]),
  };
}

function withoutRealEstate(): Record<string, readonly Row[]> {
  const { PaymentsToAcquireRealEstate: _realEstate, ...concepts } = eqixConcepts();
  return concepts;
}

function eqixStatements(concepts: Readonly<Record<string, readonly Row[]>>) {
  return deriveFinancialStatements(payload(concepts), {
    secFilings: [],
    symbol: "EQIX",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: "sec-eqix",
  });
}

const capexKeys = (item: ExtendedEvidenceItem) =>
  Object.keys(item.metrics ?? {}).filter((key) => key.startsWith("capex"));

describe("REIT capex scope outside the lens", () => {
  const secItem = (sic: string, concepts = eqixConcepts()): ExtendedEvidenceItem => {
    const legacy = summarizeSecFundamentals(payload(concepts), AS_OF, sic)!;
    return {
      category: "sec-edgar",
      title: "EQIX SEC fundamentals",
      summary: legacy.summary,
      sourceIds: ["sec-eqix"],
      observedAt: AS_OF,
      metrics: { ...legacy.metrics, sic },
    };
  };

  test("the SEC summary omits a REIT's capex on the legacy and canonical paths", () => {
    const canonical = (sic: string, concepts: Readonly<Record<string, readonly Row[]>>) =>
      withCanonicalFinancialLensInputs(
        { items: [secItem(sic, concepts)], gaps: [] },
        eqixStatements(concepts),
      ).items[0]!.summary;

    expect(secItem("6798").summary).not.toContain("capex");
    expect(secItem("3661").summary).toContain("capex 4311000000 (40.6% YoY)");
    expect(canonical("6798", eqixConcepts())).not.toContain("capex");
    expect(canonical("6798", withoutRealEstate())).toContain("capex 4311000000 (40.6% YoY)");
    expect(canonical("3661", eqixConcepts())).toContain("capex 4311000000 (40.6% YoY)");
  });

  // SPG FY2025 10-K (cached 2026-11-14) carried capex 694964000 (2.28% YoY) into the model's metrics.
  test("the SEC item's metrics drop a REIT's capex wherever its summary does", () => {
    const canonical = (sic: string, concepts: Readonly<Record<string, readonly Row[]>>) =>
      withCanonicalFinancialLensInputs(
        { items: [secItem(sic, concepts)], gaps: [] },
        eqixStatements(concepts),
      ).items[0]!;

    expect(capexKeys(secItem("6798"))).toEqual([]);
    expect(secItem("3661").metrics).toMatchObject({ capex: 4_311_000_000 });
    expect(capexKeys(canonical("6798", eqixConcepts()))).toEqual([]);
    expect(canonical("6798", withoutRealEstate()).metrics).toMatchObject({
      capex: 4_311_000_000,
    });
    expect(canonical("3661", eqixConcepts()).metrics).toMatchObject({ capex: 4_311_000_000 });
  });

  // The scope line needs a continuing-operations FCF input, so CLFD's shape carries the real estate tag.
  test("the P/FCF scope line is dropped beside a not-applicable P/FCF", () => {
    const withRealEstate = { ...clfdConcepts(), PaymentsToAcquireRealEstate: [fy25k(1_000_000)] };
    const disclosed = (sic: string, concepts: Readonly<Record<string, readonly Row[]>>) => {
      const artifact = buildValuationWorkbench({
        generatedAt: AS_OF,
        symbol: "CLFD",
        financialStatements: statementsFor(concepts),
        priceHistory: [],
        quoteCurrency: "USD",
        extendedEvidence: { items: [secItem(sic, concepts)], gaps: [] },
      });
      return [
        renderValuationWorkbenchMarkdown(artifact, researchReport()),
        valuationWorkbenchView(detail({ valuationWorkbench: artifact }))?.scopeDisclosure ?? "",
      ].map((text) => text.includes("P/FCF uses free cash flow proxy"));
    };

    expect(disclosed("6798", withRealEstate)).toEqual([false, false]);
    expect(disclosed("6798", clfdConcepts())).toEqual([true, true]);
    expect(disclosed("3661", withRealEstate)).toEqual([true, true]);
  });

  test("without statements a REIT's capex rows are withheld, whether or not capex was filed", () => {
    const lens = (item: ExtendedEvidenceItem) => {
      const result = addFinancialLensEvidence(
        { jobType: "equity", assetClass: "equity", symbol: "EQIX", depth: "brief" },
        [],
        { items: [item], gaps: [] },
        undefined,
        AS_OF,
      );
      const keys = result.artifact!.lenses.flatMap(({ metrics }) => metrics.map(({ key }) => key));
      return { keys, gaps: gapText(result.metricSectionGaps) };
    };
    const { PaymentsToAcquireProductiveAssets: _capex, ...noCapex } = eqixConcepts();
    const undecided = "REIT capex scope undecided without SEC statements";

    for (const item of [secItem("6798"), secItem("6798", noCapex)]) {
      const { keys, gaps } = lens(item);
      expect(keys).not.toContain("freeCashFlowProxy");
      expect(keys).not.toContain("capexDeltaPercent");
      expect(gaps).toContain(`FCF proxy missing (${undecided})`);
      expect(gaps).toContain(`Capex YoY (outflow amount) missing (${undecided})`);
    }
    const control = lens(secItem("3661"));
    expect(control.keys).toEqual(
      expect.arrayContaining(["freeCashFlowProxy", "capexDeltaPercent"]),
    );
    expect(control.gaps).not.toContain(undecided);
  });

  // Realty Income shape: no PP&E capex, no OCF or net income, so no Quality row has a filed input.
  test("without statements a REIT's withheld FCF proxy still anchors the Quality section", () => {
    const {
      RevenueFromContractWithCustomerExcludingAssessedTax: revenue,
      PaymentsToAcquireRealEstate,
    } = eqixConcepts();
    const result = addFinancialLensEvidence(
      { jobType: "equity", assetClass: "equity", symbol: "O", depth: "brief" },
      [],
      {
        items: [
          secItem("6798", {
            RevenueFromContractWithCustomerExcludingAssessedTax: revenue!,
            PaymentsToAcquireRealEstate: PaymentsToAcquireRealEstate!,
          }),
        ],
        gaps: [],
      },
      undefined,
      AS_OF,
    );

    expect(result.metricSections?.map(({ id }) => id)).toContain("financial-lens-quality");
    expect(gapText(result.metricSectionGaps)).toContain(
      "FCF proxy missing (REIT capex scope undecided without SEC statements)",
    );
  });

  test("without the SEC SIC, capex rows beside real estate investment are withheld", () => {
    const unclassified = (concepts: Readonly<Record<string, readonly Row[]>>) => {
      const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
      return {
        category: "sec-edgar",
        title: "EQIX SEC fundamentals",
        summary: legacy.summary,
        sourceIds: ["sec-eqix"],
        observedAt: AS_OF,
        metrics: legacy.metrics,
      } satisfies ExtendedEvidenceItem;
    };
    const lens = (concepts: Readonly<Record<string, readonly Row[]>>) => {
      const statements = eqixStatements(concepts);
      const result = addFinancialLensEvidence(
        { jobType: "equity", assetClass: "equity", symbol: "EQIX", depth: "brief" },
        [],
        withCanonicalFinancialLensInputs({ items: [unclassified(concepts)], gaps: [] }, statements),
        undefined,
        AS_OF,
        undefined,
        undefined,
        statements,
      );
      const keys = result.artifact!.lenses.flatMap(({ metrics }) => metrics.map(({ key }) => key));
      return { keys, gaps: gapText(result.metricSectionGaps) };
    };
    const undecided = "capex scope undecided without the SEC SIC classification";

    const { keys, gaps } = lens(eqixConcepts());
    expect(keys).not.toContain("freeCashFlowProxy");
    expect(keys).not.toContain("capexDeltaPercent");
    expect(gaps).toContain(`FCF proxy missing (${undecided})`);
    expect(gaps).toContain(`Capex YoY (outflow amount) missing (${undecided})`);
    const control = lens(withoutRealEstate());
    expect(control.keys).toEqual(
      expect.arrayContaining(["freeCashFlowProxy", "capexDeltaPercent"]),
    );
    expect(control.gaps).not.toContain(undecided);
  });

  test("without the SEC SIC, every FCF surface and the model input withhold the undecided capex", () => {
    const shares = eqixYears([94_000_000, 95_000_000, 97_000_000]);
    const statementsWithShares = (concepts: Readonly<Record<string, readonly Row[]>>) => {
      const facts = payload(concepts) as { facts: { "us-gaap": Record<string, unknown> } };
      facts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding = {
        units: { shares },
      };
      return deriveFinancialStatements(facts, {
        secFilings: [],
        symbol: "EQIX",
        generatedAt: AS_OF,
        analysisAsOf: AS_OF,
        sourceId: "sec-eqix",
      });
    };
    const surfaces = (concepts: Readonly<Record<string, readonly Row[]>>) => {
      const statements = statementsWithShares(concepts);
      const legacy = summarizeSecFundamentals(payload(concepts), AS_OF)!;
      const evidence = withCanonicalFinancialLensInputs(
        {
          items: [
            {
              category: "sec-edgar",
              title: "EQIX SEC fundamentals",
              summary: legacy.summary,
              sourceIds: ["sec-eqix"],
              observedAt: AS_OF,
              metrics: legacy.metrics,
            },
          ],
          gaps: [],
        },
        statements,
      );
      const lens = addFinancialLensEvidence(
        { jobType: "equity", assetClass: "equity", symbol: "EQIX", depth: "brief" },
        [],
        evidence,
        undefined,
        AS_OF,
        undefined,
        undefined,
        statements,
      );
      const workbench = buildValuationWorkbench({
        generatedAt: AS_OF,
        symbol: "EQIX",
        financialStatements: statements,
        priceHistory: [{ date: "2026-02-11", close: 100 }],
        priceSourceId: "price-eqix",
        quoteCurrency: "USD",
        extendedEvidence: evidence,
      });
      const fy2024 = workbench.historicalMultiples.observations.find(
        ({ basis, periodEnd }) => basis === "annual" && periodEnd === "2024-12-31",
      )!;
      const modelEvidence = withoutRestatedMetricValues(
        lens.extendedEvidence!,
        lens.metricSections ?? [],
      );
      return {
        legacyCapexKeys: Object.keys(legacy.metrics ?? {}).filter((key) => key.startsWith("capex")),
        modelCapexKeys: modelEvidence.items.flatMap(capexKeys),
        modelSummaries: modelEvidence.items.map(({ summary }) => summary).join("\n"),
        modelText: JSON.stringify([
          modelEvidence.items,
          metricReferenceEvidence(lens.metricSections ?? []),
        ]),
        priceToFreeCashFlow: fy2024.metrics.priceToFreeCashFlow,
        workbenchFreeCashFlow: fy2024.inputs.freeCashFlow,
        history: deriveFundamentalHistoryFromFinancialStatements(statements),
      };
    };
    const undecided = "capex scope undecided without the SEC SIC classification";

    const withheld = surfaces(eqixConcepts());
    expect(withheld.legacyCapexKeys).toEqual([]);
    expect(withheld.modelCapexKeys).toEqual([]);
    expect(withheld.modelText).not.toMatch(/4311000000|4,311|4\.31|994000000|40\.6%/u);
    expect(withheld.modelSummaries).not.toMatch(/capex/iu);
    expect(withheld.priceToFreeCashFlow).toMatchObject({ status: "missing", reason: undecided });
    expect(withheld.workbenchFreeCashFlow).toBeUndefined();
    expect(withheld.history.series.freeCashFlowProxy).toMatchObject({
      annual: [],
      notes: [`withheld: ${undecided}`],
    });
    expect(
      financialTrends(withheld.history, undefined)!.rows.map(({ freeCashFlow }) => freeCashFlow),
    ).toEqual([`withheld (${undecided})`, `withheld (${undecided})`, `withheld (${undecided})`]);
    expect(financialTrendGaps(withheld.history)).toContain(
      `fundamental-history-free-cash-flow: free cash flow proxy withheld for every period; ${undecided} [sec-eqix]`,
    );
    const cards = fundamentalHistoryView(detail({ fundamentalHistory: withheld.history }))!;
    expect(cards.notApplicable).toEqual([
      {
        key: "freeCashFlowProxy",
        label: "Free cash flow proxy",
        reason: undecided,
        withheld: true,
      },
    ]);
    const snapshot = composeEquitySnapshot({
      fundamentalHistory: cards,
      financialLensGroups: [],
      cases: [],
    });
    expect(
      snapshot.keyDatedMetrics.metrics.find(({ key }) => key === "ttmFreeCashFlowProxy"),
    ).toMatchObject({ state: "unavailable", reason: undecided });

    const control = surfaces(withoutRealEstate());
    expect(control.legacyCapexKeys).not.toEqual([]);
    expect(control.modelCapexKeys).not.toEqual([]);
    expect(control.priceToFreeCashFlow?.status).toBe("value");
    expect(control.workbenchFreeCashFlow?.value).toBe(183_000_000);
    expect(control.history.series.freeCashFlowProxy.annual.length).toBeGreaterThan(0);
    expect(financialTrendGaps(control.history).join("\n")).not.toContain(undecided);
  });

  test("a brief run whose statements fetch fails withholds the capex rows with a gap", async () => {
    const context = {
      fetchedAt: AS_OF,
      request: { json: failedRequest, text: failedRequest },
    } as never;
    const result = await collectEquityEnrichment({
      command: { jobType: "equity", assetClass: "equity", symbol: "EQIX", depth: "brief" },
      marketSnapshots: [],
      extendedEvidence: { items: [secItem("6798")], gaps: [] },
      extendedRawSnapshots: [],
      verifiedMarketSnapshot: undefined,
      priceHistory: [],
      fetchedAt: AS_OF,
      context,
      identityContext: context,
      preliminaryIdentityResult: undefined,
      now: new Date(AS_OF),
      peerUniverse: undefined,
      secTargetPacket: undefined,
      tradierPacket: undefined,
      fetchImpl: (() => Promise.reject(new Error("offline"))) as never,
    });

    expect(result.financialStatements).toBeUndefined();
    expect(gapText(result.metricSectionGaps)).toContain(
      "REIT capex scope undecided without SEC statements",
    );
  });
});
