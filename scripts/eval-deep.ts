import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  EVALS_ROOT,
  evalLabelDir,
  formatEvalCompare,
  liveTokenEstimate,
  readEvalSummary,
  runEvalSample,
  writeEvalSummary,
} from "../tests/support/run-fixtures/eval";

const USAGE =
  "Usage: bun run scripts/eval-deep.ts --fixtures a,b --label <name> [--samples N] [--yes]\n" +
  "       bun run scripts/eval-deep.ts --compare <base-label> <new-label>";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    fixtures: { type: "string" },
    samples: { type: "string", default: "2" },
    label: { type: "string" },
    compare: { type: "boolean", default: false },
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
if (existsSync(evalLabelDir(EVALS_ROOT, label))) {
  throw new Error(
    `Eval label already exists; pick a new --label: ${evalLabelDir(EVALS_ROOT, label)}`,
  );
}

const estimates = await Promise.all(fixtures.map((fixture) => liveTokenEstimate(fixture)));
let estimate = 0;
for (const [index, { recorded, perRun }] of estimates.entries()) {
  const fixture = fixtures[index]!;
  estimate += perRun * samples;
  process.stdout.write(
    `${fixture}: ${String(samples)} live-LLM run(s), recorded cassette ${String(recorded)} tokens, planning ${String(perRun)}/run\n`,
  );
}
process.stdout.write(
  `Planned: ${String(fixtures.length * samples)} live-LLM run(s), ~${String(estimate)} tokens, into ${evalLabelDir(EVALS_ROOT, label)}\n`,
);
if (!values.yes) {
  process.stdout.write("Nothing run. Re-run with --yes to spend.\n");
  process.exit(0);
}

for (const fixture of fixtures) {
  for (let sample = 1; sample <= samples; sample += 1) {
    // Sequential on purpose: each sample is a paid live run and source rate limits are per process.
    // eslint-disable-next-line no-await-in-loop
    const result = await runEvalSample({ label, fixture, sample: String(sample), llm: "live" });
    process.stdout.write(
      `${fixture}/${String(sample)}: ${result.status}, ${String(result.cassetteMisses.count)} cassette miss(es)${result.error !== undefined ? `, ${result.error}` : ""}\n`,
    );
    // Rewritten after every sample so an interrupted batch still leaves a comparable summary.
    // eslint-disable-next-line no-await-in-loop
    await writeEvalSummary(EVALS_ROOT, label);
  }
}
process.stdout.write(`${evalLabelDir(EVALS_ROOT, label)}/summary.json\n`);
