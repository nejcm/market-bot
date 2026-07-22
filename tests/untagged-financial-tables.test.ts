import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildFinancialTablePacket,
  financialTablePacketCells,
} from "../src/sources/extended-evidence/untagged-financial-table-packet";
import {
  parseFinancialTableMappingOutput,
  validateFinancialTableMapping,
} from "../src/sources/extended-evidence/untagged-financial-table-validation";
import type {
  FinancialTableCellMapping,
  FinancialTableMappingOutput,
  FinancialTableSemanticField,
} from "../src/sources/extended-evidence/untagged-financial-tables-contract";

const SOURCE = {
  url: "https://www.sec.gov/Archives/example/exhibit.htm",
  accessionNumber: "0000000000-26-000001",
  documentName: "exhibit.htm",
  filedAt: "2026-05-01",
  form: "6-K" as const,
};

const SUPPORTED_HTML = `
<html><body>
<h2>UNAUDITED CONDENSED CONSOLIDATED BALANCE SHEET</h2>
<p>(In millions of U.S. dollars ($), except share and per share data)</p>
<table>
  <tr><th>Item</th><th>As of March 31, 2026</th></tr>
  <tr><td>Cash and cash equivalents</td><td>27</td></tr>
  <tr><td>Total assets</td><td>100</td></tr>
  <tr><td>Total liabilities</td><td>40</td></tr>
  <tr><td>Total shareholders' equity</td><td>60</td></tr>
</table>
<h2>UNAUDITED CONDENSED CONSOLIDATED STATEMENT OF OPERATIONS</h2>
<p>(In millions of U.S. dollars ($), except share and per share data)</p>
<table>
  <tr><th>Item</th><th>Three months ended March 31, 2026</th></tr>
  <tr><td>Revenues</td><td>50</td></tr>
  <tr><td>Income from operations</td><td>12</td></tr>
  <tr><td>Net income</td><td>8</td></tr>
</table>
<h2>UNAUDITED CONDENSED CONSOLIDATED STATEMENT OF CASH FLOWS</h2>
<p>(In millions of U.S. dollars ($))</p>
<table>
  <tr><th>Item</th><th>Three months ended March 31, 2026</th></tr>
  <tr><td>Net cash provided by operating activities</td><td>10</td></tr>
  <tr><td>Net cash used in investing activities</td><td>(4)</td></tr>
  <tr><td>Net cash provided by financing activities</td><td>2</td></tr>
  <tr><td>Effect of exchange rate changes on cash and cash equivalents</td><td>(1)</td></tr>
  <tr><td>Net increase in cash and cash equivalents</td><td>7</td></tr>
  <tr><td>Cash and cash equivalents at beginning of period</td><td>20</td></tr>
  <tr><td>Cash and cash equivalents at end of period</td><td>27</td></tr>
</table>
</body></html>`;

function mapping(
  field: FinancialTableSemanticField,
  table: number,
  row: number,
): FinancialTableCellMapping {
  const tableId = `t${String(table).padStart(3, "0")}`;
  return {
    field,
    labelCellRef: `${tableId}:r${String(row).padStart(3, "0")}:c001`,
    valueCellRef: `${tableId}:r${String(row).padStart(3, "0")}:c002`,
    periodHeaderCellRefs: [`${tableId}:r001:c002`],
  };
}

function completeMapping(): FinancialTableMappingOutput {
  return {
    version: 1,
    mappings: [
      mapping("cash", 1, 2),
      mapping("totalAssets", 1, 3),
      mapping("totalLiabilities", 1, 4),
      mapping("stockholdersEquity", 1, 5),
      mapping("revenue", 2, 2),
      mapping("operatingIncome", 2, 3),
      mapping("netIncome", 2, 4),
      mapping("operatingCashFlow", 3, 2),
      mapping("investingCashFlow", 3, 3),
      mapping("financingCashFlow", 3, 4),
      mapping("foreignExchangeEffect", 3, 5),
      mapping("netCashChange", 3, 6),
      mapping("cashBeginning", 3, 7),
      mapping("cashEnding", 3, 8),
    ],
  };
}

describe("untagged financial table packet", () => {
  test("builds deterministic bounded cell and source locators", async () => {
    const first = await buildFinancialTablePacket(SUPPORTED_HTML, SOURCE);
    const second = await buildFinancialTablePacket(SUPPORTED_HTML, SOURCE);

    expect(first).toEqual(second);
    expect(first.unsupportedReason).toBeUndefined();
    expect(first.tables).toHaveLength(3);
    expect(first.tables[0]).toMatchObject({
      id: "t001",
      sourceTableIndex: 0,
      unitText: "(In millions of U.S. dollars ($), except share and per share data)",
    });
    expect(
      financialTablePacketCells(first).find((cell) => cell.ref === "t001:r002:c001"),
    ).toMatchObject({
      ref: "t001:r002:c001",
      rowIndex: 1,
      columnIndex: 0,
      text: "Cash and cash equivalents",
      source: expect.objectContaining({ sha256: first.source.sha256 }),
    });
  });

  test("classifies explicit unsupported source layouts", async () => {
    const imageOnly = await buildFinancialTablePacket(
      "<html><body><img src='financials.jpg'></body></html>",
      SOURCE,
    );
    const htmlOfImage = await buildFinancialTablePacket(
      "<html><body><table><tr><td><img src='financials.jpg'></td></tr></table></body></html>",
      SOURCE,
    );
    const pdf = await buildFinancialTablePacket("%PDF-1.7", SOURCE);

    expect(imageOnly.unsupportedReason).toBe("image-only");
    expect(htmlOfImage.unsupportedReason).toBe("html-of-image");
    expect(pdf.unsupportedReason).toBe("inaccessible-pdf");
  });

  test("keeps NBIS primary statements inside the packet bounds", async () => {
    const html = await readFile(
      join(
        import.meta.dir,
        "fixtures/runs/equity-nbis-deep/unsupported-inputs/nbis-20260331xex99d2.txt",
      ),
      "utf8",
    );
    const packet = await buildFinancialTablePacket(html, {
      ...SOURCE,
      url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331xex99d2.htm",
      accessionNumber: "0001104659-26-064092",
      documentName: "nbis-20260331xex99d2.htm",
      filedAt: "2026-05-20",
    });

    expect(packet.tables.length).toBeLessThanOrEqual(packet.limits.maxTables);
    expect(packet.tables.map((table) => table.context).join(" ")).toContain(
      "UNAUDITED CONDENSED CONSOLIDATED STATEMENTS OF CASH FLOW",
    );
    expect(financialTablePacketCells(packet).some((cell) => cell.text === "TOTAL ASSETS")).toBe(
      true,
    );
  });
});

describe("untagged financial table mapping validation", () => {
  test("re-reads mapped cells and accepts reconciled statements", async () => {
    const packet = await buildFinancialTablePacket(SUPPORTED_HTML, SOURCE);

    const result = validateFinancialTableMapping({
      packet,
      mapping: completeMapping(),
      filingReportDate: "2026-03-31",
      expectedCurrency: "USD",
    });

    expect(result.status).toBe("accepted");
    expect(result.issues).toEqual([]);
    expect(result.acceptedStatements).toEqual([
      "incomeStatement",
      "balanceSheet",
      "cashFlowStatement",
    ]);
    expect(result.values.find((value) => value.field === "totalAssets")).toMatchObject({
      value: 100_000_000,
      displayedValue: 100,
      periodEnd: "2026-03-31",
      unitScale: 1_000_000,
      extractionMethod: "model-validated-table",
      trace: {
        labelCellRef: "t001:r003:c001",
        valueCellRef: "t001:r003:c002",
        periodHeaderCellRefs: ["t001:r001:c002"],
      },
    });
  });

  test("rejects authoritative numeric values in model output", () => {
    const parsed = parseFinancialTableMappingOutput(
      JSON.stringify({
        version: 1,
        mappings: [
          {
            ...mapping("revenue", 2, 2),
            value: 50,
          },
        ],
      }),
    );

    expect(parsed).toEqual({
      issue: {
        code: "invalid-model-output",
        message: "mapping entries must contain only field and existing-cell reference properties",
      },
    });
  });

  test("rejects missing refs, duplicate mappings, wrong periods, and mixed currency", async () => {
    const packet = await buildFinancialTablePacket(SUPPORTED_HTML, SOURCE);
    const wrongPeriodHtml = SUPPORTED_HTML.replaceAll("2026", "2023");
    const wrongPeriodPacket = await buildFinancialTablePacket(wrongPeriodHtml, SOURCE);
    const euroPacket = await buildFinancialTablePacket(
      SUPPORTED_HTML.replaceAll("U.S. dollars ($)", "euros (€)"),
      SOURCE,
    );
    const ambiguousScalePacket = await buildFinancialTablePacket(
      SUPPORTED_HTML.replaceAll(
        "millions of U.S. dollars",
        "millions and thousands of U.S. dollars",
      ),
      SOURCE,
    );

    const missing = validateFinancialTableMapping({
      packet,
      mapping: {
        version: 1,
        mappings: [{ ...mapping("revenue", 2, 2), valueCellRef: "t002:r999:c999" }],
      },
      filingReportDate: "2026-03-31",
    });
    const duplicate = validateFinancialTableMapping({
      packet,
      mapping: { version: 1, mappings: [mapping("revenue", 2, 2), mapping("revenue", 2, 2)] },
      filingReportDate: "2026-03-31",
    });
    const wrongPeriod = validateFinancialTableMapping({
      packet: wrongPeriodPacket,
      mapping: { version: 1, mappings: [mapping("revenue", 2, 2)] },
      filingReportDate: "2026-03-31",
    });
    const mixedCurrency = validateFinancialTableMapping({
      packet: euroPacket,
      mapping: { version: 1, mappings: [mapping("revenue", 2, 2)] },
      filingReportDate: "2026-03-31",
      expectedCurrency: "USD",
    });
    const ambiguousScale = validateFinancialTableMapping({
      packet: ambiguousScalePacket,
      mapping: { version: 1, mappings: [mapping("revenue", 2, 2)] },
      filingReportDate: "2026-03-31",
    });

    expect(missing.issues.map((item) => item.code)).toContain("missing-cell-reference");
    expect(duplicate.issues.map((item) => item.code)).toContain("duplicate-field-period");
    expect(wrongPeriod.issues.map((item) => item.code)).toContain("unexpected-period");
    expect(mixedCurrency.issues.map((item) => item.code)).toContain("mixed-currency");
    expect(ambiguousScale.issues.map((item) => item.code)).toContain("unsupported-unit-scale");
  });

  test("drops statement values when accounting identities fail", async () => {
    const badBalance = SUPPORTED_HTML.replace(
      "<tr><td>Total assets</td><td>100</td></tr>",
      "<tr><td>Total assets</td><td>105</td></tr>",
    );
    const badCash = badBalance.replace(
      "<tr><td>Cash and cash equivalents at end of period</td><td>27</td></tr>",
      "<tr><td>Cash and cash equivalents at end of period</td><td>29</td></tr>",
    );
    const packet = await buildFinancialTablePacket(badCash, SOURCE);

    const result = validateFinancialTableMapping({
      packet,
      mapping: completeMapping(),
      filingReportDate: "2026-03-31",
      expectedCurrency: "USD",
    });

    expect(result.status).toBe("partial");
    expect(result.issues.map((item) => item.code)).toEqual(
      expect.arrayContaining(["balance-sheet-identity-failed", "cash-flow-identity-failed"]),
    );
    expect(
      result.values.some(
        (value) =>
          value.periodEnd === "2026-03-31" &&
          (value.statement === "balanceSheet" || value.statement === "cashFlowStatement"),
      ),
    ).toBe(false);
  });
});
