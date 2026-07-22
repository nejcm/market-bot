import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  measureFixtureBaselines,
  measureHistoricalArtifacts,
  PHASE0_BASELINE_PATH,
  readPhase0Baseline,
  type Phase0EquityBaseline,
} from "../tests/support/phase0-equity-baseline";

const flag = process.argv[2] ?? "--check";
if (flag !== "--check" && flag !== "--write") {
  throw new Error("Usage: bun run scripts/phase0-equity-baseline.ts [--check|--write]");
}

const fixtureRuns = await measureFixtureBaselines();
if (flag === "--write") {
  const baseline: Phase0EquityBaseline = {
    version: 1,
    description:
      "Phase 0 deep-equity coverage baseline before FPI normalization and earnings-date gating",
    fixtureRuns,
    historicalArtifacts: await measureHistoricalArtifacts(),
  };
  await mkdir(dirname(PHASE0_BASELINE_PATH), { recursive: true });
  await writeFile(PHASE0_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  process.stdout.write(`${PHASE0_BASELINE_PATH}\n`);
} else {
  const baseline = await readPhase0Baseline();
  if (JSON.stringify(fixtureRuns) !== JSON.stringify(baseline.fixtureRuns)) {
    throw new Error(
      `Phase 0 fixture baseline drifted; inspect and run bun run scripts/phase0-equity-baseline.ts --write if intentional`,
    );
  }
  process.stdout.write("Phase 0 fixture baseline matches.\n");
}
