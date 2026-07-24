import { describe, expect, test } from "bun:test";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { collectUntaggedFinancialExhibit } from "../src/sources/extended-evidence/untagged-financial-exhibit";
import { runFinancialTableExtractionPhase } from "../src/research/financial-table-extraction-phase";
import type { FinancialTableSemanticField } from "../src/sources/extended-evidence/untagged-financial-tables-contract";
import type {
  CollectedSources,
  FetchTextResult,
  SourceRequestExecutor,
} from "../src/sources/types";

const SUBMISSIONS = {
  cik: "0000001234",
  filings: {
    recent: {
      form: ["6-K", "20-F"],
      filingDate: ["2026-05-01", "2026-03-01"],
      reportDate: ["2026-03-31", "2025-12-31"],
      accessionNumber: ["0000001234-26-000001", "0000001234-26-000000"],
      primaryDocument: ["issuer-20260331x6k.htm", "issuer-20251231x20f.htm"],
    },
  },
};

const FINANCIAL_HTML = `
<h2>CONSOLIDATED BALANCE SHEET</h2><p>(In millions of U.S. dollars ($))</p>
<table><tr><th>Item</th><th>As of March 31, 2026</th></tr>
<tr><td>Cash and cash equivalents</td><td>27</td></tr>
<tr><td>Total assets</td><td>100</td></tr>
<tr><td>Total liabilities</td><td>40</td></tr>
<tr><td>Total shareholders' equity</td><td>60</td></tr></table>
<h2>CONSOLIDATED STATEMENT OF OPERATIONS</h2><p>(In millions of U.S. dollars ($))</p>
<table><tr><th>Item</th><th>Three months ended March 31, 2026</th></tr>
<tr><td>Revenue</td><td>50</td></tr>
<tr><td>Operating income</td><td>12</td></tr>
<tr><td>Net income</td><td>8</td></tr></table>
<h2>CONSOLIDATED STATEMENT OF CASH FLOWS</h2><p>(In millions of U.S. dollars ($))</p>
<table><tr><th>Item</th><th>Three months ended March 31, 2026</th></tr>
<tr><td>Net cash provided by operating activities</td><td>10</td></tr>
<tr><td>Net cash used in investing activities</td><td>(4)</td></tr>
<tr><td>Net cash provided by financing activities</td><td>2</td></tr>
<tr><td>Effect of exchange rate changes on cash and cash equivalents</td><td>(1)</td></tr>
<tr><td>Net increase in cash and cash equivalents</td><td>7</td></tr>
<tr><td>Cash and cash equivalents at beginning of period</td><td>20</td></tr>
<tr><td>Cash and cash equivalents at end of period</td><td>27</td></tr></table>`;

const INDEX_HTML = `
<table>
<tr><td>1</td><td>PRESS RELEASE</td><td><a href="/Archives/edgar/data/1234/000000123426000001/ex99-1.htm">ex99-1.htm</a></td><td>EX-99.1</td><td>1000</td></tr>
<tr><td>2</td><td>FINANCIAL STATEMENTS</td><td><a href="/Archives/edgar/data/1234/000000123426000001/ex99-2.htm">ex99-2.htm</a></td><td>EX-99.2</td><td>2000</td></tr>
</table>`;

function textResult(adapter: string, url: string, payload: string): FetchTextResult {
  return {
    payload,
    rawSnapshot: {
      id: `${adapter}-${url}`,
      adapter,
      fetchedAt: "2026-05-02T00:00:00.000Z",
      payload,
    },
  };
}

function requestExecutor(): SourceRequestExecutor {
  return {
    json: async () => {
      throw new Error("unexpected JSON request");
    },
    text: async (request) => {
      if (request.adapter === "sec-filing-index") {
        return textResult(request.adapter, request.url, INDEX_HTML);
      }
      if (request.url.endsWith("ex99-2.htm")) {
        return textResult(request.adapter, request.url, FINANCIAL_HTML);
      }
      return textResult(
        request.adapter,
        request.url,
        "<h2>Quarterly highlights</h2><table><tr><td>Users</td><td>10</td></tr></table>",
      );
    },
  };
}

function statements() {
  return deriveFinancialStatements(
    {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [
                {
                  val: 200_000_000,
                  form: "20-F",
                  accn: "annual",
                  filed: "2026-03-01",
                  start: "2025-01-01",
                  end: "2025-12-31",
                  fy: 2025,
                  fp: "FY",
                },
              ],
            },
          },
        },
      },
    },
    {
      symbol: "TEST",
      generatedAt: "2026-05-02T00:00:00.000Z",
      analysisAsOf: "2026-05-02T00:00:00.000Z",
      sourceId: "sec-facts",
      submissionsPayload: SUBMISSIONS,
      submissionsSourceId: "sec-submissions",
    },
  );
}

function collectedSources(): CollectedSources {
  return {
    rawSnapshots: [
      {
        id: "sec-submissions",
        adapter: "sec-submissions",
        fetchedAt: "2026-05-02T00:00:00.000Z",
        payload: SUBMISSIONS,
      },
    ],
    marketSnapshots: [],
    supplementalMarketSnapshots: [],
    newsSources: [],
    extendedSources: [],
    marketContextSources: [],
    sourceGaps: [],
    financialStatements: statements(),
  };
}

function cellMapping(
  field: FinancialTableSemanticField,
  table: number,
  row: number,
): Record<string, unknown> {
  const tableId = `t${String(table).padStart(3, "0")}`;
  return {
    field,
    labelCellRef: `${tableId}:r${String(row).padStart(3, "0")}:c001`,
    valueCellRef: `${tableId}:r${String(row).padStart(3, "0")}:c002`,
    periodHeaderCellRefs: [`${tableId}:r001:c002`],
  };
}

function modelMapping(): string {
  return JSON.stringify({
    version: 1,
    mappings: [
      cellMapping("cash", 1, 2),
      cellMapping("totalAssets", 1, 3),
      cellMapping("totalLiabilities", 1, 4),
      cellMapping("stockholdersEquity", 1, 5),
      cellMapping("revenue", 2, 2),
      cellMapping("operatingIncome", 2, 3),
      cellMapping("netIncome", 2, 4),
      cellMapping("operatingCashFlow", 3, 2),
      cellMapping("investingCashFlow", 3, 3),
      cellMapping("financingCashFlow", 3, 4),
      cellMapping("foreignExchangeEffect", 3, 5),
      cellMapping("netCashChange", 3, 6),
      cellMapping("cashBeginning", 3, 7),
      cellMapping("cashEnding", 3, 8),
    ],
  });
}

describe("untagged financial exhibit discovery", () => {
  test("selects the bounded full-statement HTML exhibit", async () => {
    const result = await collectUntaggedFinancialExhibit({
      symbol: "TEST",
      fetchedAt: "2026-05-02T00:00:00.000Z",
      request: requestExecutor(),
      secUserAgent: "market-bot test@example.test",
      rawSnapshots: collectedSources().rawSnapshots,
      financialStatements: statements(),
    });

    expect(result.gaps).toEqual([]);
    expect(result.exhibit).toMatchObject({
      filing: { accessionNumber: "0000001234-26-000001", reportDate: "2026-03-31" },
      packet: { source: { documentName: "ex99-2.htm" } },
      source: { provider: "sec-edgar", kind: "extended-evidence" },
    });
    expect(result.rawSnapshots.map((snapshot) => snapshot.adapter)).toEqual([
      "sec-filing-index",
      "sec-untagged-financial-exhibit",
      "sec-untagged-financial-exhibit",
    ]);
  });
});

describe("financial table extraction phase", () => {
  test("persists validated facts but keeps completeness gated off", async () => {
    const initial = collectedSources();
    const result = await runFinancialTableExtractionPhase({
      symbol: "TEST",
      generatedAt: "2026-05-02T00:00:00.000Z",
      collectedSources: initial,
      collect: { request: requestExecutor(), secUserAgent: "market-bot test@example.test" },
      generateMapping: async () => ({
        stage: "financial-table-mapping",
        content: modelMapping(),
        tokenEstimate: 100,
        durationMs: 1,
      }),
    });

    expect(result.stageOutputs).toEqual([
      expect.objectContaining({ stage: "financial-table-mapping" }),
    ]);
    expect(result.collectedSources.untaggedFinancialStatements).toMatchObject({
      version: 1,
      symbol: "TEST",
      validation: {
        status: "accepted",
        acceptedStatements: ["incomeStatement", "balanceSheet", "cashFlowStatement"],
      },
      completenessGate: { passed: false },
    });
    expect(
      result.collectedSources.untaggedFinancialStatements?.validation.values.every(
        (value) => value.extractionMethod === "model-validated-table",
      ),
    ).toBe(true);
    expect(result.collectedSources.financialStatements).toBe(initial.financialStatements);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        cause: "validation-failed",
        message: expect.stringContaining("remain gated from financial-core completeness"),
      }),
    );
  });
});
