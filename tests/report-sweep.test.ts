import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportInvariantViolations, reportLedgerRows, sweepReports } from "../scripts/report-sweep";

function metric(fields: Record<string, unknown>) {
  return { inputs: [], sourceIds: [], sourceIdsComplete: true, ...fields };
}

describe("report sweep", () => {
  test("flags a revenue multiple published beside a not-meaningful supportability verdict", () => {
    const sections = [
      {
        id: "financial-lens-value",
        metrics: [
          metric({ id: "valuationSupportability", status: "value", value: "not-meaningful" }),
          metric({ id: "marketCapToAnnualizedRevenue", status: "value", value: 68.76 }),
          metric({ id: "evToAnnualizedRevenue", status: "missing", reason: "no input" }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections).map((row) => [row.invariant, row.metric])).toEqual([
      ["revenue-multiple-published-when-not-meaningful", "marketCapToAnnualizedRevenue"],
    ]);
  });

  test("flags a currency instant published beside a sibling withheld as stale on the same date", () => {
    const sections = [
      {
        id: "financial-lens-financial-strength",
        metrics: [
          metric({
            id: "cash",
            status: "value",
            unit: "currency",
            value: 3.7e9,
            currency: "USD",
            periodEnd: "2025-12-31",
          }),
          metric({ id: "debt", status: "missing", reason: "stale debt as of 2025-12-31" }),
          metric({
            id: "revenue",
            status: "value",
            unit: "currency",
            value: 1,
            currency: "USD",
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections).map((row) => [row.invariant, row.metric])).toEqual([
      ["instant-published-beside-stale-sibling", "cash"],
    ]);
  });

  test("flags mixed currencies in a section and the same metric disagreeing across sections", () => {
    const sections = [
      {
        id: "a",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            currency: "USD",
            periodEnd: "2025-12-31",
          }),
          metric({
            id: "cash",
            status: "value",
            value: 2,
            currency: "RUB",
            periodEnd: "2025-12-31",
          }),
        ],
      },
      { id: "b", metrics: [metric({ id: "revenue", status: "missing", periodEnd: "2025-12-31" })] },
    ];
    expect(reportInvariantViolations(sections).map((row) => row.invariant)).toEqual([
      "section-mixes-currencies",
      "surfaces-disagree",
    ]);
  });

  test("a consistent report has no violations", () => {
    const sections = [
      {
        id: "a",
        metrics: [metric({ id: "revenue", status: "value", value: 1, periodEnd: "2025-12-31" })],
      },
      {
        id: "b",
        metrics: [metric({ id: "revenue", status: "value", value: 1, periodEnd: "2025-12-31" })],
      },
    ];
    expect(reportInvariantViolations(sections)).toEqual([]);
    expect(reportInvariantViolations([])).toEqual([]);
  });

  test("ledger rows map statuses and keep duplicate metric ids distinct", () => {
    const rows = reportLedgerRows("run-1", "AAA", [
      {
        id: "s",
        metrics: [
          metric({ id: "pe", status: "value", value: 10, periodEnd: "2025-12-31" }),
          metric({ id: "pe", status: "not-meaningful", reason: "negative" }),
          metric({ id: "ps", status: "missing" }),
        ],
      },
    ]);
    expect(rows.map((row) => [row.metric, row.period, row.status])).toEqual([
      ["s/pe", "2025-12-31", "published"],
      ["s/pe#1", "", "not-meaningful"],
      ["s/ps", "", "missing"],
    ]);
  });

  test("an empty runs directory sweeps to nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "report-sweep-"));
    try {
      expect(await sweepReports(dir)).toMatchObject({
        runs: 0,
        withSections: 0,
        failures: [],
        ledger: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
