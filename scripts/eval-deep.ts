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
  approvalSubsetEstimate,
  estimateSynthesisFile,
  formatSynthesisEstimate,
  replayPairedSample,
  replaySynthesisFile,
} from "../src/replay/replay-synthesis";
import { ABLATION_ARMS } from "../src/replay/eval-decision";
import { parseEvalCases, type OmissionCase } from "../src/replay/eval-cases";
import { freshEvalDir, writeEvalJson } from "../src/replay/eval-output";
import { createProvider } from "../src/model/factory";
import { resolveConfig } from "../src/config";
import { join, resolve } from "node:path";
import {
  calibrateJudge,
  captureOf,
  overheadDisclosure,
  readJudgeTelemetry,
} from "../src/replay/judge-telemetry";

const measuredShare = (value: number | undefined) =>
  value === undefined ? "none measured" : `${(value * 100).toFixed(1)}%`;

const USAGE =
  "Usage: bun run scripts/eval-deep.ts --fixtures a,b --label <name> [--samples N] [--live-stages <stage>] [--yes]\n" +
  "       bun run scripts/eval-deep.ts --input <file> --label <name> [--samples N] [--ablate <arm> | --no-judge] [--yes]\n" +
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
    "no-judge": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const ablate = Object.keys(ABLATION_ARMS).find((arm) => arm === values.ablate) as
  | keyof typeof ABLATION_ARMS
  | undefined;
if (values.input !== undefined) {
  // The stage-deletion rule needs judged verdicts, so an ablation always judges.
  if (
    (values.ablate !== undefined && (ablate === undefined || values["no-judge"])) ||
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
  let identity: { provider: string; model: string } | undefined = undefined;
  try {
    const config = resolveConfig(process.env, { validateAlphaSearchOptions: false });
    identity = { provider: config.provider, model: config.synthesisModel };
  } catch {
    identity = undefined;
  }
  const overheadNote = overheadDisclosure(
    estimate.captureIdentity,
    identity,
    estimate.callOverhead,
  );
  const judge = !values["no-judge"];
  process.stdout.write(formatSynthesisEstimate(estimate, samplesCount, judge, overheadNote));
  const control =
    estimate.arm !== undefined && "control" in estimate.arm ? estimate.arm.control : undefined;
  if (control !== undefined && judge) {
    const paired = await estimateSynthesisFile(
      values.input,
      control === "baseline" ? undefined : (control as keyof typeof ABLATION_ARMS),
      omissionCases,
    );
    const telemetryFile = join(
      import.meta.dir,
      "../tests/fixtures/eval-cases/judge-telemetry.json",
    );
    const telemetry = await readJudgeTelemetry(EVALS_ROOT, telemetryFile);
    const capture = captureOf(resolve(values.input));
    const calibration =
      identity === undefined
        ? undefined
        : calibrateJudge(telemetry.samples, identity, {
            capture,
            ablation: estimate.arm!.name,
            control,
          });
    const subset = approvalSubsetEstimate(estimate, paired, samplesCount, calibration);
    const who =
      identity === undefined
        ? "an unresolved provider/model"
        : `${identity.provider}/${identity.model}`;
    const basis =
      calibration === undefined
        ? `HEURISTIC FALLBACK, no judge telemetry for ${who}: early stop on every item / on none, ${overheadNote}; only always-identical code-assembled digest units deducted as canceled`
        : `judge calibrated on ${String(calibration.samples)} sample(s) judged by ${who}: ${calibration.votesPerJudgedItem.toFixed(2)} votes/judged item, ~${String(Math.round(calibration.tokensPerCall))} tokens/call; cancellation measured on this capture and arm: ablation ${measuredShare(calibration.cancelShare.ablation)}, control ${measuredShare(calibration.cancelShare.control)}${calibration.cancelShare.ablation === undefined || calibration.cancelShare.control === undefined ? " (provable digest units deducted instead)" : ""}`;
    const skipped =
      telemetry.skipped === 0
        ? ""
        : `; ${String(telemetry.skipped)} telemetry record(s) skipped as unidentified or unusable`;
    process.stdout.write(
      `Approval subset (${String(estimate.arm!.name)} + control ${control}, ${String(samplesCount)} pre-paired sample(s) each, run together): expected ~${subset.earlyStop === subset.expected ? String(subset.expected) : `${String(subset.earlyStop)}-${String(subset.expected)}`} (${basis}), worst case ~${String(subset.worst)}${skipped}.\n`,
    );
  }
  if (!values.yes) {
    process.stdout.write("Nothing run. Re-run with --yes to spend.\n");
    process.exit(0);
  }
  const dir = await freshEvalDir(values.label);
  const config = resolveConfig(process.env, { validateAlphaSearchOptions: false });
  const provider = createProvider(config);
  const shared = {
    input: values.input,
    root: dir,
    omissionCases,
    ...(judge ? { judge: { provider, model: config.synthesisModel } } : {}),
    provider,
    models: { quick: config.quickModel, synthesis: config.synthesisModel },
  };
  const samples = [];
  for (let sample = 1; sample <= samplesCount; sample += 1) {
    if (ablate !== undefined && control !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- each pair writes isolated directories
      const pair = await replayPairedSample({
        ...shared,
        judge: { provider, model: config.synthesisModel },
        index: sample,
        ablation: ablate,
      });
      samples.push(pair.control, pair.ablation);
    } else {
      samples.push(
        // oxlint-disable-next-line no-await-in-loop -- each sample writes an isolated directory
        await replaySynthesisFile({ ...shared, label: String(sample), ablation: ablate }),
      );
    }
  }
  await writeEvalJson(dir, "summary.json", {
    scope: "final-synthesis-only",
    arm: estimate.arm,
    judgeMode: judge ? "k=3" : "skipped",
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
