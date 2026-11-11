import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportInvariantViolations, reportLedgerRows, sweepReports } from "../scripts/report-sweep";

function metric(fields: Record<string, unknown>) {
  return fields as { readonly id?: string };
}

describe("report sweep", () => {
  test("flags a revenue multiple published beside a sibling the shared verdict withheld", () => {
    const workbench = (priceToSales: Record<string, unknown>) => [
      {
        id: "valuation-workbench-ttm-2025-12-31-2026-04-30",
        metrics: [
          metric({ id: "priceToSales", ...priceToSales }),
          metric({
            id: "enterpriseValueToRevenue",
            status: "not-meaningful",
            reason: "EV/revenue above the 50x ceiling",
          }),
        ],
      },
    ];
    expect(
      reportInvariantViolations(workbench({ status: "value", value: 40 })).map((row) => [
        row.invariant,
        row.metric,
      ]),
    ).toEqual([["revenue-multiple-published-when-not-meaningful", "priceToSales"]]);
    expect(
      reportInvariantViolations(
        workbench({ status: "not-meaningful", reason: "EV/revenue above the 50x ceiling" }),
      ),
    ).toEqual([]);
  });

  test("applies the current valuation verdict to Lens and Framework rows, not historical Workbench rows", () => {
    const sections = [
      {
        id: "financial-lens-value",
        metrics: [
          metric({ id: "valuationSupportability", status: "value", value: "not-meaningful" }),
          metric({ id: "marketCapToAnnualizedRevenue", status: "value", value: 30 }),
        ],
      },
      {
        id: "valuation-workbench-annual-2023-12-31-2024-03-01",
        metrics: [metric({ id: "priceToSales", status: "value", value: 12 })],
      },
    ];
    expect(
      reportInvariantViolations(sections).map((row) => [row.invariant, row.section, row.metric]),
    ).toEqual([
      [
        "revenue-multiple-published-when-not-meaningful",
        "financial-lens-value",
        "marketCapToAnnualizedRevenue",
      ],
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

  test("flags a Lens and Framework pair that disagrees on the same period", () => {
    const sections = [
      {
        id: "financial-lens-value",
        metrics: [
          metric({
            id: "evToAnnualizedRevenue",
            status: "value",
            value: 68,
            periodEnd: "2025-12-31",
            periodMonths: 12,
            priceAsOf: "2026-04-30",
          }),
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "business-framework-valuation",
        metrics: [
          metric({
            id: "evToAnnualizedRevenue",
            status: "not-meaningful",
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections).map((row) => [row.invariant, row.metric])).toEqual([
      ["surfaces-disagree", "evToAnnualizedRevenue"],
    ]);
  });

  test("does not compare a metric across sections that are not an equivalent pair", () => {
    const sections = [
      {
        id: "financial-lens-growth",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "valuation-workbench-ttm-2025-12-31-2026-04-30",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 2,
            periodEnd: "2025-12-31",
            periodMonths: 12,
          }),
        ],
      },
      {
        id: "business-framework-growth",
        metrics: [
          metric({
            id: "revenue",
            status: "value",
            value: 1,
            periodEnd: "2025-12-31",
            periodMonths: 3,
          }),
        ],
      },
    ];
    expect(reportInvariantViolations(sections)).toEqual([]);
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
      expect(await sweepReports(dir, join(dir, "replays"))).toMatchObject({
        runs: 0,
        replayed: 0,
        noCapture: [],
        failures: [],
        ledger: [],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds the ledger from a replayed capture and lists runs without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "report-sweep-"));
    try {
      const runsDir = join(dir, "runs");
      await mkdir(join(runsDir, "captured"), { recursive: true });
      await mkdir(join(runsDir, "uncaptured"));
      // The saved report has no Metric Sections, so every ledger row must come from the replay.
      await writeFile(join(runsDir, "captured", "report.json"), "{}");
      await writeFile(join(runsDir, "uncaptured", "report.json"), "{}");
      await symlink(
        join(import.meta.dir, "fixtures/runs/equity-nbis-deep"),
        join(runsDir, "captured", "replay"),
      );
      const sweep = await sweepReports(runsDir, join(dir, "replays"));
      expect(sweep).toMatchObject({
        runs: 2,
        replayed: 1,
        withSections: 1,
        noCapture: ["uncaptured"],
        failures: [],
      });
      expect(sweep.ledger.length).toBeGreaterThan(0);
      expect(new Set(sweep.ledger.map((row) => `${row.cik} ${row.symbol}`))).toEqual(
        new Set(["captured NBIS"]),
      );
      expect(
        sweep.violationCounts["revenue-multiple-published-when-not-meaningful"],
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
