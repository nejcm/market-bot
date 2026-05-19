import { readFile } from "node:fs/promises";

const MINIMUM_COVERAGE_PERCENT = 80;

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
      return {
        ...acc,
        linesFound: acc.linesFound + Number.parseInt(line.slice(3), 10),
      };
    }

    if (line.startsWith("LH:")) {
      return {
        ...acc,
        linesHit: acc.linesHit + Number.parseInt(line.slice(3), 10),
      };
    }

    return acc;
  },
  {
    linesFound: 0,
    linesHit: 0,
  },
);

const coveragePercent = totals.linesFound === 0 ? 0 : (totals.linesHit / totals.linesFound) * 100;

process.stdout.write(`Line coverage: ${coveragePercent.toFixed(2)}%\n`);

if (coveragePercent < MINIMUM_COVERAGE_PERCENT) {
  process.stderr.write(
    `Coverage ${coveragePercent.toFixed(2)}% is below ${MINIMUM_COVERAGE_PERCENT}%\n`,
  );
  process.exit(1);
}
