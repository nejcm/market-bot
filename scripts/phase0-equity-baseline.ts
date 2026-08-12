import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  measurePhase4EarningsCoverageComparison,
  PHASE4_EARNINGS_COMPARISON_PATH,
  readPhase4EarningsCoverageComparison,
} from "../tests/support/phase0-equity-baseline";

const flag = process.argv[2] ?? "--check";
if (flag !== "--check" && flag !== "--write") {
  throw new Error("Usage: bun run scripts/phase0-equity-baseline.ts [--check|--write]");
}

const comparison = await measurePhase4EarningsCoverageComparison();
if (flag === "--write") {
  await mkdir(dirname(PHASE4_EARNINGS_COMPARISON_PATH), { recursive: true });
  await writeFile(
    PHASE4_EARNINGS_COMPARISON_PATH,
    `${JSON.stringify(comparison, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${PHASE4_EARNINGS_COMPARISON_PATH}\n`);
} else {
  const committedComparison = await readPhase4EarningsCoverageComparison();
  if (JSON.stringify(comparison) !== JSON.stringify(committedComparison)) {
    throw new Error(
      `Phase 4 earnings coverage comparison drifted; inspect and run bun run scripts/phase0-equity-baseline.ts --write if intentional`,
    );
  }
  process.stdout.write(
    `Phase 4 vs Phase 0: earnings predictions ${String(comparison.totals.delta.earningsPredictionCount)}, calibration coverage ${String(comparison.totals.delta.calibrationEligiblePredictionCount)}.\n`,
  );
}
