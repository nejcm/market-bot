import { readFile } from "node:fs/promises";
import { aggregateLcov, evaluateCoverage } from "./lcov-coverage";

const MINIMUM_LINE_COVERAGE_PERCENT = 80;
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
const evaluation = evaluateCoverage(aggregateLcov(lcov), {
  minLinePercent: MINIMUM_LINE_COVERAGE_PERCENT,
  minFunctionPercent: MINIMUM_FUNCTION_COVERAGE_PERCENT,
});

process.stdout.write(`Line coverage:     ${evaluation.linePercent.toFixed(2)}%\n`);
process.stdout.write(`Function coverage: ${evaluation.functionPercent.toFixed(2)}%\n`);

for (const failure of evaluation.failures) {
  process.stderr.write(`${failure}\n`);
}

if (evaluation.failures.length > 0) {
  process.exit(1);
}
