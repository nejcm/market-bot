import { readFile } from "node:fs/promises";

const MINIMUM_LINE_COVERAGE_PERCENT = 80;
// Bun's lcov reporter emits function records (FNF/FNH) but no branch records, so
// The gate pairs line coverage with function coverage to catch whole functions
// That are never exercised — a gap that line coverage alone can mask.
const MINIMUM_FUNCTION_COVERAGE_PERCENT = 80;

const proc = Bun.spawn(["bun", "test", "--coverage", "--coverage-reporter=lcov"], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

const lcov = await readFile("coverage/lcov.info", "utf8");

const totals = lcov.split("\n").reduce(
  (acc, line) => {
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
  },
  { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
);

const percent = (hit: number, found: number): number => (found === 0 ? 0 : (hit / found) * 100);

const lineCoverage = percent(totals.linesHit, totals.linesFound);
const functionCoverage = percent(totals.functionsHit, totals.functionsFound);

process.stdout.write(`Line coverage:     ${lineCoverage.toFixed(2)}%\n`);
process.stdout.write(`Function coverage: ${functionCoverage.toFixed(2)}%\n`);

let failed = false;
if (lineCoverage < MINIMUM_LINE_COVERAGE_PERCENT) {
  process.stderr.write(
    `Line coverage ${lineCoverage.toFixed(2)}% is below ${MINIMUM_LINE_COVERAGE_PERCENT}%\n`,
  );
  failed = true;
}
if (functionCoverage < MINIMUM_FUNCTION_COVERAGE_PERCENT) {
  process.stderr.write(
    `Function coverage ${functionCoverage.toFixed(2)}% is below ${MINIMUM_FUNCTION_COVERAGE_PERCENT}%\n`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}
