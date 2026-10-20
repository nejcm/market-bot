import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  EVALS_ROOT,
  evalLabelDir,
  formatEvalCompare,
  liveTokenEstimate,
  readEvalSummary,
  unreplayableFixtureError,
  runEvalSample,
  runEvalBatch,
} from "../tests/support/run-fixtures/eval";
import { validateLiveStage } from "../src/replay/llm-cassette";
import {
  ABLATION_ARMS,
  estimateSynthesisFile,
  replaySynthesisFile,
} from "../src/replay/replay-synthesis";
import { parseEvalCases, type OmissionCase } from "../src/replay/eval-cases";
import { freshEvalDir, writeEvalJson } from "../src/replay/eval-output";
import { createProvider } from "../src/model/factory";
import { resolveConfig } from "../src/config";
import { join } from "node:path";

const USAGE =
  "Usage: bun run scripts/eval-deep.ts --fixtures a,b --label <name> [--samples N] [--live-stages <stage>] [--yes]\n" +
  "       bun run scripts/eval-deep.ts --input <file> --label <name> [--samples N] [--ablate <arm>] [--yes]\n" +
  "       bun run scripts/eval-deep.ts --compare <base-label> <new-label>";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    fixtures: { type: "string" },
    input: { type: "string" },
    samples: { type: "string", default: "2" },
    label: { type: "string" },
    compare: { type: "boolean", default: false },
    "live-stages": { type: "string" },
    ablate: { type: "string" },
    yes: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const ablate = Object.keys(ABLATION_ARMS).find((arm) => arm === values.ablate) as
  | keyof typeof ABLATION_ARMS
  | undefined;
if (values.input !== undefined) {
  if (
    (values.ablate !== undefined && ablate === undefined) ||
    values.fixtures !== undefined ||
    values.compare ||
    values.label === undefined ||
    positionals.length > 0 ||
    (values["live-stages"] !== undefined && values["live-stages"] !== "final-synthesis") ||
    !Number.isInteger(Number(values.samples)) ||
    Number(values.samples) < 1
  ) {
    throw new Error(USAGE);
  }
  const labelDir = evalLabelDir(EVALS_ROOT, values.label);
  if (existsSync(labelDir)) {
    throw new Error(`Eval label already exists: ${labelDir}`);
  }
  const omissionCases = parseEvalCases(
    await Bun.file(join(import.meta.dir, "../tests/fixtures/eval-cases/cases.json")).json(),
  ).filter((row): row is OmissionCase => row.check === "omission");
  const estimate = await estimateSynthesisFile(values.input, ablate, omissionCases);
  const samplesCount = Number(values.samples);
  process.stdout.write(
    `Final synthesis input${estimate.arm === undefined ? "" : ` arm ${estimate.arm.name} (removed: ${estimate.arm.removed.join(", ")}; regenerated live: ${estimate.arm.regenerated.join(", ") || "none"})`}: ${String(estimate.observedCalls)} recorded synthesis call(s). Generation expected ~${String(estimate.expectedPerRun * samplesCount)} tokens at the recorded call count and token use; worst case (all ${String(estimate.boundedCalls)} bounded synthesis calls/sample, 25% headroom) ~${String(estimate.perRun * samplesCount)}. k=3 report judge: ${String(estimate.judgeItems)} item(s)/sample, ~${String(estimate.judgePerRun * samplesCount)} tokens. Total expected ~${String(estimate.totalExpectedPerRun * samplesCount)}, worst case ~${String(estimate.totalWorstPerRun * samplesCount)}. Not a provider-enforced cost cap.\n`,
  );
  if (!values.yes) {
    process.stdout.write("Nothing run. Re-run with --yes to spend.\n");
    process.exit(0);
  }
  const dir = await freshEvalDir(values.label);
  const config = resolveConfig(process.env, { validateAlphaSearchOptions: false });
  const provider = createProvider(config);
  const samples = [];
  for (let sample = 1; sample <= samplesCount; sample += 1) {
    samples.push(
      // oxlint-disable-next-line no-await-in-loop -- each sample writes an isolated directory
      await replaySynthesisFile({
        input: values.input,
        label: String(sample),
        root: dir,
        ablation: ablate,
        omissionCases,
        judge: { provider, model: config.synthesisModel },
        provider,
        models: { quick: config.quickModel, synthesis: config.synthesisModel },
      }),
    );
  }
  await writeEvalJson(dir, "summary.json", {
    scope: "final-synthesis-only",
    arm: estimate.arm,
    samples,
  });
  process.stdout.write(`${join(dir, "summary.json")}\n`);
  process.exit(samples.every((sample) => sample.status === "completed") ? 0 : 1);
}

if (values.ablate !== undefined) {
  throw new Error(USAGE);
}

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
for (const fixture of fixtures) {
  // oxlint-disable-next-line no-await-in-loop -- reject before any replay starts
  const error = await unreplayableFixtureError(fixture);
  if (error !== undefined) {
    // oxlint-disable-next-line no-await-in-loop -- flush before exiting on the first rejected fixture
    await Bun.write(Bun.stderr, `${error}\n`);
    process.exit(1);
  }
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
let expected: number | undefined = 0;
for (const [
  index,
  { recorded, perRun, boundedCalls, observedCalls, maxInputTokens, expectedPerRun },
] of estimates.entries()) {
  const fixture = fixtures[index]!;
  estimate += perRun * samples;
  expected =
    expected === undefined || expectedPerRun === undefined
      ? undefined
      : expected + expectedPerRun * samples;
  process.stdout.write(
    `${fixture}: ${String(samples)} live-LLM run(s)${liveStages !== undefined ? ` (live stage: ${liveStages})` : ""}, recorded cassette ${String(recorded)} tokens, planning ${String(perRun)}/run\n`,
  );
  if (boundedCalls !== undefined) {
    process.stdout.write(
      `  Offline preflight: ${String(observedCalls)} selected call(s), ~${String(maxInputTokens)} maximum input tokens (characters/4); expected ~${String(expectedPerRun)}/run summed over observed calls, worst case ${String(boundedCalls)} bounded call(s) with 25% headroom.\n`,
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
  `Planned: ${String(fixtures.length * samples)} live-LLM run(s), ${expected === undefined ? "" : `expected ~${String(expected)} tokens, `}worst case ~${String(estimate)}, into ${evalLabelDir(EVALS_ROOT, label)}\n`,
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
