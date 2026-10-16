import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  EVALS_ROOT,
  evalLabelDir,
  formatEvalCompare,
  liveTokenEstimate,
  readEvalSummary,
  runEvalSample,
  runEvalBatch,
} from "../tests/support/run-fixtures/eval";
import { validateLiveStage } from "../tests/support/run-fixtures/llm-cassette";

const USAGE =
  "Usage: bun run scripts/eval-deep.ts --fixtures a,b --label <name> [--samples N] [--live-stages <stage>] [--yes]\n" +
  "       bun run scripts/eval-deep.ts --compare <base-label> <new-label>";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    fixtures: { type: "string" },
    samples: { type: "string", default: "2" },
    label: { type: "string" },
    compare: { type: "boolean", default: false },
    "live-stages": { type: "string" },
    yes: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

if (values.compare) {
  const [base, next] = positionals;
  if (base === undefined || next === undefined || positionals.length !== 2) {
    throw new Error(USAGE);
  }
  const summaries = [
    await readEvalSummary(EVALS_ROOT, base),
    await readEvalSummary(EVALS_ROOT, next),
  ];
  process.stdout.write(formatEvalCompare(summaries[0]!, summaries[1]!));
  process.exit(0);
}

const fixtures = values.fixtures?.split(",").filter((name) => name.length > 0) ?? [];
const samples = Number(values.samples);
const { label } = values;
if (
  fixtures.length === 0 ||
  label === undefined ||
  !Number.isInteger(samples) ||
  samples < 1 ||
  positionals.length > 0
) {
  throw new Error(USAGE);
}
const liveStages =
  values["live-stages"] === undefined ? undefined : validateLiveStage(values["live-stages"]);
if (existsSync(evalLabelDir(EVALS_ROOT, label))) {
  throw new Error(
    `Eval label already exists; pick a new --label: ${evalLabelDir(EVALS_ROOT, label)}`,
  );
}

if (liveStages !== undefined) {
  process.stdout.write(
    `Selected stage: ${liveStages}; includes every loop/repair call within phase limits.\n`,
  );
  process.stdout.write(
    "Other model outputs stay recorded; downstream reasoning is not reevaluated.\n",
  );
  process.stdout.write(
    "Adaptive Web Gather/evidence requests must match the source cassette; an unseen request invalidates the sample and blocks subsequent model calls.\n",
  );
}
const estimates = [];
for (const fixture of fixtures) {
  // oxlint-disable-next-line no-await-in-loop -- offline planning shares process-level index overrides
  estimates.push(await liveTokenEstimate(fixture, liveStages));
}
let estimate = 0;
for (const [
  index,
  { recorded, perRun, boundedCalls, observedCalls, maxInputTokens },
] of estimates.entries()) {
  const fixture = fixtures[index]!;
  estimate += perRun * samples;
  process.stdout.write(
    `${fixture}: ${String(samples)} live-LLM run(s)${liveStages !== undefined ? ` (live stage: ${liveStages})` : ""}, recorded cassette ${String(recorded)} tokens, planning ${String(perRun)}/run\n`,
  );
  if (boundedCalls !== undefined) {
    process.stdout.write(
      `  Offline preflight: ${String(observedCalls)} selected call(s), ~${String(maxInputTokens)} maximum input tokens (characters/4); planning ${String(boundedCalls)} bounded call(s) with 25% headroom.\n`,
    );
    if (observedCalls === 0) {
      process.stdout.write("  Selected stage was not exercised in offline preflight.\n");
    }
  }
}
process.stdout.write(
  "Planning estimates are not provider-enforced cost caps; live response token estimates are reported separately from replayed tokens.\n",
);
process.stdout.write(
  `Planned: ${String(fixtures.length * samples)} live-LLM run(s), ~${String(estimate)} tokens, into ${evalLabelDir(EVALS_ROOT, label)}\n`,
);
if (!values.yes) {
  process.stdout.write("Nothing run. Re-run with --yes to spend.\n");
  process.exit(0);
}

process.exitCode = await runEvalBatch({
  root: EVALS_ROOT,
  label,
  fixtures,
  samples,
  runSample: async (fixture, sample) => {
    const result = await runEvalSample({
      label,
      fixture,
      sample,
      llm: "live",
      ...(liveStages !== undefined ? { liveStages } : {}),
    });
    process.stdout.write(
      `${fixture}/${sample}: ${result.status}, ${String(result.cassetteMisses.count)} HTTP cassette miss(es), ${String(result.modelReplayMisses.count)} model replay miss(es)${result.error !== undefined ? `, ${result.error}` : ""}\n`,
    );
    return result;
  },
});
process.stdout.write(`${evalLabelDir(EVALS_ROOT, label)}/summary.json\n`);
