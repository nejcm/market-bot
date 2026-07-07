// Pure lcov aggregation helpers, extracted from the coverage gate so the parsing
// Logic can be unit-tested without spawning a test run. Bun's lcov reporter emits
// Line records (LF/LH) and function records (FNF/FNH) but no branch records, so the
// Gate pairs line coverage with function coverage to catch whole functions that are
// Never exercised — a gap that line coverage alone can mask.

export interface CoverageTotals {
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
}

export interface CoverageThresholds {
  readonly minLinePercent: number;
  readonly minFunctionPercent: number;
}

export interface CoverageEvaluation {
  readonly linePercent: number;
  readonly functionPercent: number;
  readonly failures: readonly string[];
}

const EMPTY_TOTALS: CoverageTotals = {
  linesFound: 0,
  linesHit: 0,
  functionsFound: 0,
  functionsHit: 0,
};

function accumulate(acc: CoverageTotals, line: string): CoverageTotals {
  if (line.startsWith("LF:")) {
    return { ...acc, linesFound: acc.linesFound + Number.parseInt(line.slice(3), 10) };
  }
  if (line.startsWith("LH:")) {
    return { ...acc, linesHit: acc.linesHit + Number.parseInt(line.slice(3), 10) };
  }
  if (line.startsWith("FNF:")) {
    return { ...acc, functionsFound: acc.functionsFound + Number.parseInt(line.slice(4), 10) };
  }
  if (line.startsWith("FNH:")) {
    return { ...acc, functionsHit: acc.functionsHit + Number.parseInt(line.slice(4), 10) };
  }
  return acc;
}

// Sum LF/LH and FNF/FNH records across every file section of an lcov report.
export function aggregateLcov(lcov: string): CoverageTotals {
  return lcov.split("\n").reduce((acc, line) => accumulate(acc, line), EMPTY_TOTALS);
}

// Coverage percent, treating a zero denominator as 0% so empty reports fail the gate.
export function coveragePercent(hit: number, found: number): number {
  return found === 0 ? 0 : (hit / found) * 100;
}

// Compute line/function percentages and collect a failure message per breached threshold.
export function evaluateCoverage(
  totals: CoverageTotals,
  thresholds: CoverageThresholds,
): CoverageEvaluation {
  const linePercent = coveragePercent(totals.linesHit, totals.linesFound);
  const functionPercent = coveragePercent(totals.functionsHit, totals.functionsFound);
  const failures: string[] = [];
  if (linePercent < thresholds.minLinePercent) {
    failures.push(
      `Line coverage ${linePercent.toFixed(2)}% is below ${thresholds.minLinePercent}%`,
    );
  }
  if (functionPercent < thresholds.minFunctionPercent) {
    failures.push(
      `Function coverage ${functionPercent.toFixed(2)}% is below ${thresholds.minFunctionPercent}%`,
    );
  }
  return { linePercent, functionPercent, failures };
}
