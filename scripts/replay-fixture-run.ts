import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { createProvider } from "../src/model/factory";
import type { ModelProvider } from "../src/model/types";
import {
  DEEP_EQUITY_EVALUATION_FILE,
  resumePairedEvaluation,
  runPairedEvaluation,
} from "../tests/support/deep-equity-evaluation-runner";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import { loadFixture, runFixture } from "../tests/support/run-fixtures";
import { makeReplayProvider } from "../tests/support/run-fixtures/llm-cassette";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

interface ParsedArguments {
  readonly fixtureNames: readonly string[];
  readonly live: boolean;
  readonly writeGolden: boolean;
  readonly paired: boolean;
  readonly resumeRoot?: string;
  readonly recoveryFixtures?: readonly string[];
  readonly forceRejudge: boolean;
  readonly judgeModel?: string;
  readonly approvalRecordPath?: string;
  readonly repetitions: number;
  readonly seed?: number;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bun run scripts/replay-fixture-run.ts <fixture-name> [--live] [--write-golden]",
      "  bun run scripts/replay-fixture-run.ts <fixture-name> [<fixture-name> ...] --paired [--live] [--repetitions <count>] [--seed <integer>] [--judge-model <model>] [--approval-record <path>]",
      "  bun run scripts/replay-fixture-run.ts --resume-evaluation <data/evaluations/root> --judge-model <model> [--live] [--seed <integer>] [--fixtures <fixture-a,fixture-b> --repetitions <count>] [--force-rejudge] [--approval-record <path>]",
    ].join("\n"),
  );
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function integer(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${flag} must be an integer`);
  }
  return parsed;
}

function requiredFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

function fixtureList(value: string): readonly string[] {
  const fixtures = value.split(",").map((fixture) => fixture.trim());
  if (
    fixtures.length === 0 ||
    fixtures.some((fixture) => fixture === "") ||
    new Set(fixtures).size !== fixtures.length
  ) {
    throw new TypeError("--fixtures must be a comma-separated list of unique fixture names");
  }
  return fixtures;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const fixtureNames: string[] = [];
  let live = false;
  let writeGolden = false;
  let paired = false;
  let resumeRoot: string | undefined = undefined;
  let recoveryFixtures: readonly string[] | undefined = undefined;
  let forceRejudge = false;
  let judgeModel: string | undefined = undefined;
  let approvalRecordPath: string | undefined = undefined;
  let repetitions = 1;
  let repetitionsSpecified = false;
  let seed: number | undefined = undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--live") {
      live = true;
    } else if (argument === "--write-golden") {
      writeGolden = true;
    } else if (argument === "--paired") {
      paired = true;
    } else if (argument === "--force-rejudge") {
      forceRejudge = true;
    } else if (argument === "--resume-evaluation") {
      resumeRoot = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (argument === "--judge-model") {
      judgeModel = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (argument === "--approval-record") {
      approvalRecordPath = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (argument === "--fixtures") {
      recoveryFixtures = fixtureList(requiredFlagValue(args, index, argument));
      index += 1;
    } else if (argument === "--repetitions") {
      repetitions = positiveInteger(args[index + 1], "--repetitions");
      repetitionsSpecified = true;
      index += 1;
    } else if (argument === "--seed") {
      seed = integer(args[index + 1], "--seed");
      index += 1;
    } else if (argument?.startsWith("--") === true || argument === undefined) {
      usage();
    } else {
      fixtureNames.push(argument);
    }
  }
  const resumeMode = resumeRoot !== undefined;
  const validResume =
    resumeMode &&
    fixtureNames.length === 0 &&
    !paired &&
    !writeGolden &&
    judgeModel !== undefined &&
    ((recoveryFixtures === undefined && !repetitionsSpecified) ||
      (recoveryFixtures !== undefined && repetitionsSpecified));
  const validPaired =
    !resumeMode &&
    paired &&
    fixtureNames.length > 0 &&
    recoveryFixtures === undefined &&
    !writeGolden &&
    !forceRejudge;
  const validSingle =
    !resumeMode &&
    !paired &&
    fixtureNames.length === 1 &&
    judgeModel === undefined &&
    recoveryFixtures === undefined &&
    repetitions === 1 &&
    seed === undefined &&
    !forceRejudge &&
    approvalRecordPath === undefined;
  if (!validResume && !validPaired && !validSingle) {
    usage();
  }
  return {
    fixtureNames,
    live,
    writeGolden,
    paired,
    ...(resumeRoot !== undefined ? { resumeRoot } : {}),
    ...(recoveryFixtures !== undefined ? { recoveryFixtures } : {}),
    forceRejudge,
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    ...(approvalRecordPath !== undefined ? { approvalRecordPath } : {}),
    repetitions,
    ...(seed !== undefined ? { seed } : {}),
  };
}

function evaluationSeed(seed: number | undefined): number {
  return seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1_511_467_046;
}

function liveResumeProvider(): ModelProvider {
  const config = resolveConfig(process.env, { validateAlphaSearchOptions: false });
  return createProvider(config);
}

const parsed = parseArguments(process.argv.slice(2));

if (parsed.resumeRoot !== undefined) {
  let liveProvider: ModelProvider | null = null;
  await resumePairedEvaluation({
    root: parsed.resumeRoot,
    live: parsed.live,
    judgeModel: parsed.judgeModel!,
    ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
    ...(parsed.recoveryFixtures !== undefined
      ? {
          plan: {
            scenarios: parsed.recoveryFixtures,
            repetitions: Array.from({ length: parsed.repetitions }, (_, index) => index + 1),
          },
        }
      : {}),
    forceRejudge: parsed.forceRejudge,
    ...(parsed.approvalRecordPath !== undefined
      ? { approvalRecordPath: parsed.approvalRecordPath }
      : {}),
    providerForScenario: async (scenario) => {
      if (parsed.live) {
        liveProvider ??= liveResumeProvider();
        return liveProvider;
      }
      const fixture = await loadFixture(scenario);
      return makeReplayProvider(fixture.llmCassette);
    },
  });
  process.stdout.write(`${join(parsed.resumeRoot, DEEP_EQUITY_EVALUATION_FILE)}\n`);
} else if (parsed.paired) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const pairRoot = join("data", "evaluations", `deep-equity-${timestamp}`);
  await runPairedEvaluation({
    root: pairRoot,
    fixtureNames: parsed.fixtureNames,
    repetitions: parsed.repetitions,
    seed: evaluationSeed(parsed.seed),
    live: parsed.live,
    ...(parsed.judgeModel !== undefined ? { judgeModel: parsed.judgeModel } : {}),
    ...(parsed.approvalRecordPath !== undefined
      ? { approvalRecordPath: parsed.approvalRecordPath }
      : {}),
  });
  process.stdout.write(`${join(pairRoot, DEEP_EQUITY_EVALUATION_FILE)}\n`);
} else {
  const fixtureName = parsed.fixtureNames[0]!;
  const result = await runFixture(fixtureName, {
    llm: parsed.live ? "live" : "replay",
    keepDataDir: !parsed.writeGolden,
    ...(parsed.writeGolden ? {} : { dataDir: join("data", "runs") }),
  });
  try {
    if (parsed.writeGolden) {
      await writeGoldenOutput(result.artifacts.runDir, fixtureName);
      await assertNoSecretsInFiles([goldenOutputPath(fixtureName)], knownSecretValues(process.env));
      process.stdout.write(`${goldenOutputPath(fixtureName)}\n`);
    } else {
      process.stdout.write(`${result.artifacts.runDir}\n`);
    }
  } finally {
    await result.cleanup();
  }
}
