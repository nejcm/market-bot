import { describe, expect, test } from "bun:test";
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
  });

  test("suppresses when reconciled trailing FCF is absent", () => {
    expect(
      buildReverseDcf({
        generatedAt: "2026-05-19T00:00:00.000Z",
        symbol: "AAPL",
        valuationWorkbench: valuationWorkbench(),
      }),
    ).toMatchObject({
      status: "suppressed",
      reason: "reconciled-ttm-fcf-unavailable",
    });
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
    expect(readReverseDcfArtifact(artifact)).toEqual(artifact);
    expect(
      readReverseDcfArtifact({
        ...artifact,
        unrelatedOutput: 1,
      }),
    ).toBeUndefined();
  });
});
