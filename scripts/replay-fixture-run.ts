import { runFixture } from "../tests/support/run-fixtures";
import { liveTokenEstimate, runEvalSample } from "../tests/support/run-fixtures/eval";

const args = process.argv.slice(2);
const fixtureNames = args.filter((argument) => !argument.startsWith("--"));
const flags = args.filter((argument) => argument.startsWith("--"));
if (fixtureNames.length !== 1 || flags.some((flag) => flag !== "--live" && flag !== "--yes")) {
  throw new Error("Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live [--yes]]");
}
const fixtureName = fixtureNames[0]!;
const live = flags.includes("--live");
if (flags.includes("--yes") && !live) {
  throw new Error("--yes only applies to --live");
}
if (live) {
  const { recorded, perRun } = await liveTokenEstimate(fixtureName);
  process.stdout.write(
    `Planned: 1 live-LLM run of ${fixtureName}, recorded cassette ${String(recorded)} tokens, planning ~${String(perRun)}\n`,
  );
  if (!flags.includes("--yes")) {
    process.stdout.write("Nothing run. Re-run with --live --yes to spend.\n");
    process.exit(0);
  }
  const label = `replay-live-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
  const sample = await runEvalSample({ label, fixture: fixtureName, sample: "1", llm: "live" });
  process.stdout.write(`${sample.runDir ?? sample.sampleDir}\n`);
  if (sample.error !== undefined) {
    throw new Error(sample.error);
  }
  process.exit(0);
}
const result = await runFixture(fixtureName, { llm: "replay", keepDataDir: true });
process.stdout.write(`${result.artifacts.runDir}\n`);
