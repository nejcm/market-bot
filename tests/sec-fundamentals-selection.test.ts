import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../app/types";
import {
  financialTrendFromProjection,
  fundamentalHistoryView,
} from "../app/client/run-workspace-financials";
import { composeEquitySnapshot } from "../app/client/run-workspace-snapshot";
import { reverseDcfView, valuationWorkbenchView } from "../app/client/run-workspace-valuation";
import { financialTrends } from "../src/report/equity-reader-trends";
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
import type { ExtendedEvidenceItem } from "../src/domain/types";
import { growthLens, qualityLens } from "../src/sources/extended-evidence/financial-lens-builders";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";

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

function statementsFor(concepts: Readonly<Record<string, readonly Row[]>>, asOf = AS_OF) {
  return deriveFinancialStatements(payload(concepts), {
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
    expect(summary.summary).toContain("capex 2917000 (-17.3% YoY)");
    expect(summary.metrics).toMatchObject({
      operatingCashFlow: 7_345_000,
      operatingCashFlowPeriodEnd: "2026-06-30",
      operatingCashFlowPrior: 22_423_000,
      operatingCashFlowScope: "continuing operations",
      capex: 2_917_000,
    });
    expect(summary.metrics.capexScope).toBeUndefined();
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

  test("carries the scope label through canonical and legacy history and the lenses", () => {
    const canonical = deriveFundamentalHistoryFromFinancialStatements(
      statementsFor(clfdConcepts()),
    );
    const legacy = deriveFundamentalHistory(payload(clfdConcepts()), {
      symbol: "CLFD",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec-clfd",
    });
    const item = canonicalSecItem(clfdConcepts());
    const labels = [...qualityLens(item).metrics, ...growthLens(item).metrics].map(
      (metric) => metric.label,
    );

    for (const history of [canonical, legacy]) {
      expect(history.series.operatingCashFlow.concept).toBe(CONTINUING_OCF);
      expect(history.series.operatingCashFlow.label).toBe(
        "Operating cash flow (continuing operations)",
      );
      expect(history.series.freeCashFlowProxy.label).toBe(
        "Free cash flow proxy (continuing operations)",
      );
    }
    expect(item.metrics?.operatingCashFlowScope).toBe("continuing operations");
    expect(labels).toContain("Operating cash flow YoY (continuing operations)");
    expect(labels).toContain("FCF proxy (continuing operations)");
  });

  test("the total tag wins an equal period even when only the continuing tag has a prior", () => {
    const concepts = {
      ...clfdConcepts(),
      [TOTAL_OCF]: [q3Current(50)],
      [CONTINUING_OCF]: [q3Current(20, "2024-10-01", "2025-06-30"), q3Current(30)],
    };
    const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const ocf = statementsFor(concepts).statements.cashFlowStatement.operatingCashFlow;

    expect(summary.metrics.operatingCashFlow).toBe(50);
    expect(summary.metrics.operatingCashFlowPrior).toBeUndefined();
    expect(summary.gaps.map((gap) => gap.message)).toContainEqual(
      expect.stringMatching(
        /^Missing comparable SEC company facts for YoY deltas: .*operatingCashFlow/u,
      ),
    );
    expect(new Set(financialStatementFacts(ocf).map((fact) => fact.concept))).toEqual(
      new Set([TOTAL_OCF]),
    );
  });

  test("the total tag wins an equal period even when the continuing tag was filed later", () => {
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

    expect(summary.metrics.operatingCashFlow).toBe(9_000_000);
    expect(summary.metrics.operatingCashFlowScope).toBeUndefined();
    expect(summary.summary).toContain("operating cash flow 9000000");
    expect(history.series.operatingCashFlow.concept).toBe(TOTAL_OCF);
    expect(history.series.operatingCashFlow.label).toBe("Operating cash flow");
  });

  test("falls back to the total tag when continuing facts post-date the cutoff", () => {
    const asOf = "2025-09-01T00:00:00.000Z";
    const concepts = {
      ...clfdConcepts(),
      [CONTINUING_OCF]: [q3Current(7_345_000)],
    };
    const summary = summarizeSecFundamentals(payload(concepts), asOf)!;
    const legacy = deriveFundamentalHistory(payload(concepts), {
      symbol: "CLFD",
      generatedAt: asOf,
      analysisAsOf: asOf,
      sourceId: "sec-clfd",
    });

    expect(summary.metrics.operatingCashFlow).toBe(18_116_000);
    expect(summary.metrics.operatingCashFlowScope).toBeUndefined();
    expect(legacy.series.operatingCashFlow.concept).toBe(TOTAL_OCF);
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

describe("legacy YoY comparatives", () => {
  test("uses the restated comparative so summary prose agrees with canonical metrics", () => {
    const summary = summarizeSecFundamentals(payload(clfdConcepts()), AS_OF)!;
    const item = canonicalSecItem(clfdConcepts());

    expect(summary.metrics.revenuePrior).toBe(109_074_000);
    expect(summary.summary).toContain("revenue 112596000 (3.2% YoY)");
    expect(item.metrics?.revenuePrior).toBe(summary.metrics.revenuePrior);
    expect(item.metrics?.revenueDeltaPercent).toBeCloseTo(
      summary.metrics.revenueDeltaPercent as number,
      10,
    );
    expect(item.summary).toBe(summary.summary);
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
    expect(item.metrics?.operatingCashFlowScope).toBeUndefined();
    expect(item.summary).toContain("revenue 100,");
    expect(item.summary).toContain("operating cash flow 50,");
    expect(item.summary).not.toContain("continuing operations");
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
    const trends = financialTrends(history, false)!;
    const cards = fundamentalHistoryView(detail({ fundamentalHistory: history }))!;
    const snapshot = composeEquitySnapshot({
      fundamentalHistory: cards,
      financialLensGroups: [],
      cases: [],
    });

    expect(trends.freeCashFlowScope).toBe("continuing operations");
    expect(renderProjectedFinancialTrends(researchReport(), trends)).toContain(
      "reported operating-cash-flow (continuing operations) less capex proxy",
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
      `- P/FCF uses free cash flow proxy (continuing operations) for annual 2025-09-30, ttm ${ttm.periodEnd}.`,
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
