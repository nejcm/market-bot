import { expect, test } from "bun:test";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import { renderMetricSections } from "../src/report/markdown-metric-sections";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import {
  evaluateMetricSection,
  statementInput,
} from "../src/sources/extended-evidence/metric-engine";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { config, contextWithHistory } from "./support/research-context-helpers";
import { collectedSources, researchReport } from "./support/fixtures";

const AS_OF = "2026-06-22T00:00:00.000Z";
const command = { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" } as const;
const statements = deriveFinancialStatements(
  {
    facts: {
      "us-gaap": {
        CashAndCashEquivalentsAtCarryingValue: {
          units: {
            USD: [
              { val: 60, end: "2026-03-31", filed: "2026-05-01", form: "10-Q", fy: 2026, fp: "Q1" },
            ],
          },
        },
        Revenues: {
          units: {
            USD: [
              {
                val: 100,
                start: "2025-01-01",
                end: "2025-12-31",
                filed: "2026-02-15",
                form: "10-K",
                fy: 2025,
                fp: "FY",
              },
            ],
          },
        },
        GrossProfit: {
          units: {
            USD: [
              {
                val: 40,
                start: "2025-01-01",
                end: "2025-12-31",
                filed: "2026-02-15",
                form: "10-K",
                fy: 2025,
                fp: "FY",
              },
            ],
          },
        },
      },
    },
  },
  { symbol: "AAPL", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: "sec-aapl" },
);

function instantReport() {
  const fact = statements.statements.balanceSheet.cash.interim[0]!;
  const { section } = evaluateMetricSection(
    "test",
    "Balances",
    [
      {
        id: "cash",
        label: "Cash",
        unit: "currency",
        basis: "reported instant",
        compute: () => ({
          status: "value",
          value: fact.value,
          periodEnd: fact.periodEnd,
          inputs: [statementInput(fact, "cash", "cash")],
        }),
      },
    ],
    { symbol: "AAPL" },
  );
  return researchReport({ extras: { metricSections: [section] } });
}

test("markdown labels a balance-sheet instant as of its date", () => {
  expect(renderMetricSections(instantReport())).toContain("As of 2026-03-31");
  expect(renderMetricSections(instantReport())).not.toContain("FY ending");
});

test("console labels a balance-sheet instant as of its date", () => {
  expect(
    metricSectionsView(instantReport() as unknown as Record<string, unknown>)?.[0]?.metrics[0]
      ?.period,
  ).toBe("As of 2026-03-31");
});

test("canonical SEC evidence reaches model payloads without selected metric flattening", () => {
  const evidence = withCanonicalFinancialLensInputs(undefined, statements);
  const payload = buildEvidencePayload(
    { includePriorCalibration: false, sourceGapView: "all", webSourceText: "metadata" },
    command,
    collectedSources({ extendedEvidence: evidence }),
    config,
    { ...contextWithHistory(command), analysisAsOf: AS_OF },
  );
  expect(evidence.items[0]?.metrics?.grossProfit).toBe(40);
  expect(JSON.stringify(payload)).not.toContain("Selected");
  expect(
    Object.keys(evidence.items[0]?.metrics ?? {}).some((key) =>
      /Selected|payoutRatioNonPositive/u.test(key),
    ),
  ).toBe(false);
});
