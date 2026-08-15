import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { renderReverseDcfMarkdown } from "../src/report/reverse-dcf-markdown";
import {
  buildReverseDcf,
  readReverseDcfArtifact,
  REVERSE_DCF_DISCOUNT_RATES_PCT,
  REVERSE_DCF_HORIZON_YEARS,
  REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT,
} from "../src/sources/extended-evidence/reverse-dcf";
import { reverseDcfArtifact, reverseDcfWorkbench, valuationWorkbench } from "./support/fixtures";

function discountedTotal(input: {
  readonly startingFcf: number;
  readonly annualGrowth: number;
  readonly discountRate: number;
  readonly terminalGrowthRate: number;
}): number {
  let total = 0;
  let fcf = input.startingFcf;
  for (let year = 1; year <= REVERSE_DCF_HORIZON_YEARS; year += 1) {
    fcf *= 1 + input.annualGrowth;
    total += fcf / (1 + input.discountRate) ** year;
  }
  return (
    total +
    (fcf * (1 + input.terminalGrowthRate)) /
      (input.discountRate - input.terminalGrowthRate) /
      (1 + input.discountRate) ** REVERSE_DCF_HORIZON_YEARS
  );
}

function buildFromWorkbench(workbench: ReturnType<typeof reverseDcfWorkbench>) {
  return buildReverseDcf({
    generatedAt: "2026-05-19T00:00:00.000Z",
    symbol: "AAPL",
    valuationWorkbench: workbench,
  });
}

describe("reverse DCF input sensitivity", () => {
  test("solves the full disclosed assumption matrix", () => {
    const artifact = reverseDcfArtifact();
    expect(artifact.status).toBe("computed");
    if (artifact.status !== "computed") {
      return;
    }

    expect(artifact.assumptions).toMatchObject({
      horizonYears: 5,
      discountRatesPct: [...REVERSE_DCF_DISCOUNT_RATES_PCT],
      terminalGrowthRatesPct: [...REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT],
    });
    expect(artifact.grid.rows).toHaveLength(9);
    expect(artifact.grid.rows.map((row) => row.discountRatePct)).toEqual([
      ...REVERSE_DCF_DISCOUNT_RATES_PCT,
    ]);
    expect(artifact.grid.rows.every((row) => row.cells.length === 5)).toBe(true);

    for (const row of artifact.grid.rows) {
      for (const [cellIndex, cell] of row.cells.entries()) {
        expect(cell.terminalGrowthRatePct).toBe(
          REVERSE_DCF_TERMINAL_GROWTH_RATES_PCT[cellIndex] ?? -1,
        );
        expect(cell.status).toBe("solved");
        if (cell.status !== "solved") {
          continue;
        }
        const reconstructed = discountedTotal({
          startingFcf: artifact.assumptions.startingFcf.value,
          annualGrowth: cell.solvedFiveYearFcfGrowthPct / 100,
          discountRate: row.discountRatePct / 100,
          terminalGrowthRate: cell.terminalGrowthRatePct / 100,
        });
        expect(reconstructed).toBeCloseTo(artifact.assumptions.enterpriseValue.value, 2);
      }
    }
  });

  test("renders assumptions and a structurally bounded solved-input grid", () => {
    const artifact = reverseDcfArtifact();
    expect(artifact.status).toBe("computed");
    if (artifact.status !== "computed") {
      return;
    }

    expect(Object.keys(artifact).toSorted()).toEqual([
      "assumptions",
      "generatedAt",
      "grid",
      "sourceIds",
      "status",
      "symbol",
      "version",
    ]);
    expect(Object.keys(artifact.assumptions).toSorted()).toEqual([
      "discountRatesPct",
      "enterpriseValue",
      "horizonYears",
      "startingFcf",
      "terminalGrowthRatesPct",
    ]);
    expect(Object.keys(artifact.grid).toSorted()).toEqual(["rows", "unit", "value"]);
    expect(
      artifact.grid.rows.every(
        (row) =>
          Object.keys(row).toSorted().join(",") === "cells,discountRatePct" &&
          row.cells.every(
            (cell) =>
              Object.keys(cell).toSorted().join(",") ===
              "solvedFiveYearFcfGrowthPct,status,terminalGrowthRatePct",
          ),
      ),
    ).toBe(true);

    const markdown = renderReverseDcfMarkdown(artifact);
    expect(markdown).toContain("## Reverse DCF Input Sensitivity");
    expect(markdown).toContain("### Assumptions");
    expect(markdown).toContain("Starting FCF:");
    expect(markdown).toContain("Enterprise value:");
    expect(markdown).toContain("Horizon: 5 years.");
    expect(markdown).toContain("### Solved Five-Year FCF Growth Grid");
    expect(markdown.match(/^\| (?:8|9|10|11|12|13|14|15|16)% \|/gmu)).toHaveLength(9);
    expect(markdown.match(/^\| Discount rate \\ Terminal growth \|/gmu)).toHaveLength(1);
    expect(violatesResearchOnly(markdown)).toBeNull();
  });

  test("suppresses when reconciled trailing FCF is absent", () => {
    const artifact = buildReverseDcf({
      generatedAt: "2026-05-19T00:00:00.000Z",
      symbol: "AAPL",
      valuationWorkbench: valuationWorkbench(),
    });

    expect(artifact).toMatchObject({
      status: "suppressed",
      reason: "reconciled-ttm-fcf-unavailable",
    });
    expect(renderReverseDcfMarkdown(artifact)).toBe("");
  });

  test("suppresses non-positive or incompatible inputs with explicit reasons", () => {
    const base = reverseDcfWorkbench();
    const [observation] = base.historicalMultiples.observations;
    if (
      observation === undefined ||
      observation.inputs.freeCashFlow === undefined ||
      base.peerComparison.status !== "available"
    ) {
      throw new Error("reverse DCF workbench fixture is incomplete");
    }
    expect(
      buildFromWorkbench({
        ...base,
        historicalMultiples: {
          ...base.historicalMultiples,
          observations: [
            {
              ...observation,
              inputs: {
                ...observation.inputs,
                freeCashFlow: { ...observation.inputs.freeCashFlow, value: -1 },
              },
            },
          ],
        },
      }),
    ).toMatchObject({ status: "suppressed", reason: "starting-fcf-not-positive" });
    expect(
      buildFromWorkbench({
        ...base,
        peerComparison: {
          status: "available",
          valuationComps: {
            ...base.peerComparison.valuationComps,
            target: {
              ...base.peerComparison.valuationComps.target,
              enterpriseValue: -1,
            },
          },
        },
      }),
    ).toMatchObject({ status: "suppressed", reason: "enterprise-value-not-positive" });
    expect(
      buildFromWorkbench({
        ...base,
        peerComparison: {
          status: "available",
          valuationComps: {
            ...base.peerComparison.valuationComps,
            target: {
              ...base.peerComparison.valuationComps.target,
              quoteCurrency: "EUR",
            },
          },
        },
      }),
    ).toMatchObject({ status: "suppressed", reason: "input-currency-mismatch" });
  });

  test("reads current artifacts and rejects unrelated computed fields", () => {
    const artifact = reverseDcfArtifact();
    expect(readReverseDcfArtifact(artifact)).toEqual({
      ...artifact,
      readDiagnostics: { droppedObservationCount: 0, drops: [] },
    });
    expect(
      readReverseDcfArtifact({
        ...artifact,
        unrelatedOutput: 1,
      }),
    ).toBeUndefined();
  });

  test("drops only an unreadable grid cell and records it", () => {
    const artifact = reverseDcfArtifact();
    if (artifact.status !== "computed") {
      throw new Error("expected computed reverse DCF fixture");
    }
    const firstRow = artifact.grid.rows[0]!;
    const malformed = {
      ...artifact,
      grid: {
        ...artifact.grid,
        rows: [
          {
            ...firstRow,
            cells: [{ ...firstRow.cells[0], status: "retired" }, ...firstRow.cells.slice(1)],
          },
          ...artifact.grid.rows.slice(1),
        ],
      },
    };

    const read = readReverseDcfArtifact(malformed);

    expect(read).toMatchObject({
      status: "computed",
      readDiagnostics: {
        droppedObservationCount: 1,
        drops: [{ reason: "reverseDcf.grid.cells.invalid", count: 1 }],
      },
    });
    expect(read?.status === "computed" && read.grid.rows[0]?.cells).toHaveLength(4);
  });

  test("keeps a dropped middle cell aligned with its declared terminal-growth column", () => {
    const artifact = reverseDcfArtifact();
    if (artifact.status !== "computed") {
      throw new Error("expected computed reverse DCF fixture");
    }
    const row = artifact.grid.rows[0]!;
    const read = readReverseDcfArtifact({
      ...artifact,
      grid: {
        ...artifact.grid,
        rows: [
          {
            ...row,
            cells: row.cells.map((cell) =>
              cell.terminalGrowthRatePct === 2 ? { ...cell, status: "retired" } : cell,
            ),
          },
          ...artifact.grid.rows.slice(1),
        ],
      },
    });
    if (read?.status !== "computed") {
      throw new Error("expected readable reverse DCF artifact");
    }

    const renderedRow = renderReverseDcfMarkdown(read)
      .split("\n")
      .find((line) => line.startsWith(`| ${String(row.discountRatePct)}% |`));
    const display = (rate: number): string => {
      const cell = row.cells.find((candidate) => candidate.terminalGrowthRatePct === rate)!;
      return cell.status === "solved"
        ? `${cell.solvedFiveYearFcfGrowthPct.toFixed(2)}%`
        : "not solved";
    };
    expect(renderedRow).toBe(
      `| ${String(row.discountRatePct)}% | ${display(0)} | ${display(1)} | — (unavailable) | ${display(3)} | ${display(4)} |`,
    );
  });

  test("bounds carried diagnostics to missing declared grid slots", () => {
    const artifact = reverseDcfArtifact();
    if (artifact.status !== "computed") {
      throw new Error("expected computed reverse DCF fixture");
    }
    const readRows = (claim: number) =>
      readReverseDcfArtifact({
        ...artifact,
        grid: { ...artifact.grid, rows: artifact.grid.rows.slice(0, 3) },
        readDiagnostics: {
          droppedObservationCount: claim,
          drops: claim === 0 ? [] : [{ reason: "reverseDcf.grid.rows.invalid", count: claim }],
        },
      });
    const retainedRowDrops = {
      droppedObservationCount: 6,
      drops: [{ reason: "reverseDcf.grid.rows.invalid", count: 6 }],
    };

    expect(
      [0, 5, 6, 7, 20].map((claim) => {
        const read = readRows(claim);
        return [claim, read === undefined ? "rejected" : "accepted", read?.readDiagnostics];
      }),
    ).toEqual([
      [0, "rejected", undefined],
      [5, "rejected", undefined],
      [6, "accepted", retainedRowDrops],
      [7, "accepted", retainedRowDrops],
      [20, "accepted", retainedRowDrops],
    ]);

    const readCells = readReverseDcfArtifact({
      ...artifact,
      grid: {
        ...artifact.grid,
        rows: artifact.grid.rows.map((row) => ({ ...row, cells: row.cells.slice(0, 4) })),
      },
      readDiagnostics: {
        droppedObservationCount: 450,
        drops: [{ reason: "reverseDcf.grid.cells.invalid", count: 450 }],
      },
    });
    expect(readCells?.readDiagnostics).toEqual({
      droppedObservationCount: 9,
      drops: [{ reason: "reverseDcf.grid.cells.invalid", count: 9 }],
    });
  });
});
