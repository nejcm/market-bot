import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  EVALS_ROOT,
  liveTokenEstimate,
  unreplayableFixtureError,
  runEvalSample,
  runEvalBatch,
} from "../tests/support/run-fixtures/eval";

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
  const error = await unreplayableFixtureError(fixtureName);
  if (error !== undefined) {
    await Bun.write(Bun.stderr, `${error}\n`);
    process.exit(1);
  }
  const { recorded, perRun } = await liveTokenEstimate(fixtureName);
  process.stdout.write(
    `Planned: 1 live-LLM run of ${fixtureName}, recorded cassette ${String(recorded)} tokens, planning ~${String(perRun)}\n`,
  );
  if (!flags.includes("--yes")) {
    process.stdout.write("Nothing run. Re-run with --live --yes to spend.\n");
    process.exit(0);
  }
}
const root = live
  ? EVALS_ROOT
  : await mkdtemp(join(tmpdir(), `market-bot-${basename(fixtureName)}-`));
const label = live ? `replay-live-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}` : "replay";
process.exitCode = await runEvalBatch({
  root,
  label,
  fixtures: [fixtureName],
  samples: 1,
  runSample: async (fixture, sample) => {
    const result = await runEvalSample({
      root,
      label,
      fixture,
      sample,
      llm: live ? "live" : "replay",
    });
    process.stdout.write(`${result.runDir ?? result.sampleDir}\n`);
    if (live) {
      process.stderr.write(
        `${result.status}: ${String(result.cassetteMisses.count)} HTTP cassette miss(es), ${String(result.modelReplayMisses.count)} model replay miss(es)\n`,
      );
    }
    if (result.error !== undefined) {
      process.stderr.write(`${result.error}\n`);
    }
    return result;
  },
});
