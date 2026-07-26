import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  aggregateDeepEquityEvaluation,
  createSeededEvaluationRandom,
  deepEquityVariantEvaluationMetrics,
  evaluateDeepEquityGates,
  type DeepEquityEvaluationRunRecord,
  type DeepEquityHardGateInputs,
  type DeepEquityVariantEvaluationMetrics,
} from "../tests/support/deep-equity-evaluation";
import {
  deriveEvaluationStreamSeed,
  EVALUATION_RANDOM_STREAM_DERIVATION,
  EVALUATION_RANDOM_STREAM_SALTS,
} from "../tests/support/evaluation-random";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import {
  runFixture,
  runFixturePair,
  type RunFixtureVariantOutcome,
} from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

interface ParsedArguments {
  readonly fixtureNames: readonly string[];
  readonly live: boolean;
  readonly writeGolden: boolean;
  readonly paired: boolean;
  readonly judgeModel?: string;
  readonly repetitions: number;
  readonly seed?: number;
}

interface PairedEvaluationTask {
  readonly fixtureName: string;
  readonly repetition: number;
}

interface ExecutedPairedEvaluation {
  readonly aggregateRecord?: DeepEquityEvaluationRunRecord;
  readonly perRunRecord: Readonly<Record<string, unknown>>;
}

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [<fixture-name> ...] [--live] [--write-golden] [--paired [--repetitions <count>] [--seed <integer>] [--judge-model <model>]]",
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

function parseArguments(args: readonly string[]): ParsedArguments {
  const fixtureNames: string[] = [];
  let live = false;
  let writeGolden = false;
  let paired = false;
  let judgeModel: string | undefined = undefined;
  let repetitions = 1;
  let seed: number | undefined = undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--live") {
      live = true;
    } else if (argument === "--write-golden") {
      writeGolden = true;
    } else if (argument === "--paired") {
      paired = true;
    } else if (argument === "--judge-model") {
      judgeModel = args[index + 1];
      if (judgeModel === undefined || judgeModel.startsWith("--")) {
        usage();
      }
      index += 1;
    } else if (argument === "--repetitions") {
      repetitions = positiveInteger(args[index + 1], "--repetitions");
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
  if (
    fixtureNames.length === 0 ||
    (!paired && fixtureNames.length !== 1) ||
    (!paired && (judgeModel !== undefined || repetitions !== 1 || seed !== undefined)) ||
    (paired && writeGolden)
  ) {
    usage();
  }
  return {
    fixtureNames,
    live,
    writeGolden,
    paired,
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    repetitions,
    ...(seed !== undefined ? { seed } : {}),
  };
}

function successfulMetrics(
  outcome: RunFixtureVariantOutcome,
): DeepEquityVariantEvaluationMetrics | undefined {
  return outcome.status === "success"
    ? deepEquityVariantEvaluationMetrics(outcome.result)
    : undefined;
}

function outcomeSummary(
  outcome: RunFixtureVariantOutcome,
  metrics: DeepEquityVariantEvaluationMetrics | undefined,
): Readonly<Record<string, unknown>> {
  return outcome.status === "success"
    ? {
        status: outcome.status,
        runDir: outcome.result.artifacts.runDir,
        metrics,
      }
    : { status: outcome.status, error: outcome.error.message };
}

function noIntegrityRegression(records: readonly DeepEquityEvaluationRunRecord[]): boolean {
  return records.every((record) => {
    const legacy = record.variants.legacy.reportIntegrity;
    const simplified = record.variants.simplified.reportIntegrity;
    return simplified !== "low" || legacy === "low";
  });
}

function noEvidenceCoverageRegression(records: readonly DeepEquityEvaluationRunRecord[]): boolean {
  return records.every((record) => {
    const legacy = record.variants.legacy.deterministicEvidenceCoverageRatio;
    const simplified = record.variants.simplified.deterministicEvidenceCoverageRatio;
    return legacy !== null && simplified !== null && simplified >= legacy;
  });
}

function annotateGateEvidence(verdict: ReturnType<typeof evaluateDeepEquityGates>) {
  const evidence = {
    "all-reports-validate": {
      kind: "derived-proxy",
      source: "both persistResearchJob variant executions completed successfully",
      limitation:
        "This relies on the pipeline's mandatory validateResearchReport boundary; it is not an independent artifact revalidation.",
    },
    "zero-research-only-boundary-violations": {
      kind: "per-run-validation",
      source: "assertSafeReportLanguage(final report)",
    },
    "no-invalid-predictions-persist": {
      kind: "per-run-validation",
      source: "validatePredictions(final report predictions, final report source IDs)",
    },
  } as const;
  return {
    ...verdict,
    gates: verdict.gates.map((gate) => ({
      ...gate,
      ...(gate.name in evidence ? { evidence: evidence[gate.name as keyof typeof evidence] } : {}),
    })),
  };
}

async function executePairedEvaluation(
  task: PairedEvaluationTask,
  parsedArguments: ParsedArguments,
  pairRoot: string,
  variantOrderRandom: () => number,
  blindLabelRandom: () => number,
): Promise<ExecutedPairedEvaluation> {
  const result = await runFixturePair(task.fixtureName, {
    llm: parsedArguments.live ? "live" : "replay",
    keepDataDir: true,
    dataDir: join(pairRoot, task.fixtureName, `repetition-${String(task.repetition)}`),
    variantOrderRandom,
    blindLabelRandom,
    judge: parsedArguments.judgeModel !== undefined,
    ...(parsedArguments.judgeModel !== undefined ? { judgeModel: parsedArguments.judgeModel } : {}),
  });
  const legacyMetrics = successfulMetrics(result.variants.legacy);
  const simplifiedMetrics = successfulMetrics(result.variants.simplified);
  const aggregateRecord =
    legacyMetrics === undefined || simplifiedMetrics === undefined
      ? undefined
      : {
          scenario: task.fixtureName,
          repetition: task.repetition,
          variants: { legacy: legacyMetrics, simplified: simplifiedMetrics },
          ...(result.judge !== undefined ? { judge: result.judge } : {}),
        };
  return {
    ...(aggregateRecord !== undefined ? { aggregateRecord } : {}),
    perRunRecord: {
      scenario: task.fixtureName,
      repetition: task.repetition,
      variants: {
        legacy: outcomeSummary(result.variants.legacy, legacyMetrics),
        simplified: outcomeSummary(result.variants.simplified, simplifiedMetrics),
      },
      ...(result.judge !== undefined ? { judge: result.judge } : {}),
    },
  };
}

const parsed = parseArguments(process.argv.slice(2));

if (parsed.paired) {
  const evaluationSeed =
    parsed.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1_511_467_046;
  const randomStreamSeeds = {
    variantOrder: deriveEvaluationStreamSeed(evaluationSeed, "variantOrder"),
    blindLabels: deriveEvaluationStreamSeed(evaluationSeed, "blindLabels"),
    pairedBootstrap: deriveEvaluationStreamSeed(evaluationSeed, "pairedBootstrap"),
  };
  const variantOrderRandom = createSeededEvaluationRandom(randomStreamSeeds.variantOrder);
  const blindLabelRandom = createSeededEvaluationRandom(randomStreamSeeds.blindLabels);
  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const pairRoot = join("data", "evaluations", `deep-equity-${timestamp}`);
  await mkdir(pairRoot, { recursive: true });
  const tasks = parsed.fixtureNames.flatMap((fixtureName) =>
    Array.from({ length: parsed.repetitions }, (_, index) => ({
      fixtureName,
      repetition: index + 1,
    })),
  );
  const executed = await tasks.reduce<Promise<readonly ExecutedPairedEvaluation[]>>(
    (pending, task) =>
      pending.then(async (records) => [
        ...records,
        await executePairedEvaluation(task, parsed, pairRoot, variantOrderRandom, blindLabelRandom),
      ]),
    Promise.resolve([]),
  );
  const aggregateRecords = executed.flatMap((record) =>
    record.aggregateRecord === undefined ? [] : [record.aggregateRecord],
  );
  const perRunRecords = executed.map((record) => record.perRunRecord);
  const aggregate = aggregateDeepEquityEvaluation(aggregateRecords, {
    random: createSeededEvaluationRandom(randomStreamSeeds.pairedBootstrap),
  });
  const expectedPairCount = parsed.fixtureNames.length * parsed.repetitions;
  const allReportsValidate = aggregateRecords.length === expectedPairCount;
  const hardGates: DeepEquityHardGateInputs = {
    allReportsValidate,
    allCitedSourceIdsResolve:
      allReportsValidate &&
      aggregateRecords.every(
        (record) =>
          record.variants.legacy.allCitedSourceIdsResolve &&
          record.variants.simplified.allCitedSourceIdsResolve,
      ),
    zeroResearchOnlyBoundaryViolations:
      allReportsValidate &&
      aggregateRecords.every(
        (record) =>
          record.variants.legacy.researchOnlyBoundaryPassed &&
          record.variants.simplified.researchOnlyBoundaryPassed,
      ),
    zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
    noAdditionalLowIntegrityReports: allReportsValidate && noIntegrityRegression(aggregateRecords),
    noDeterministicEvidenceCoverageRegression:
      allReportsValidate && noEvidenceCoverageRegression(aggregateRecords),
    noInvalidPredictionsPersist:
      allReportsValidate &&
      aggregateRecords.every(
        (record) =>
          record.variants.legacy.persistedPredictionsValidate &&
          record.variants.simplified.persistedPredictionsValidate,
      ),
    humanReviewApproved: false,
    liveSmokePassed: false,
  };
  const gateVerdict = annotateGateEvidence(evaluateDeepEquityGates(aggregate, hardGates));
  const comparison = {
    version: 1,
    runtime: { bunVersion: Bun.version },
    mode: parsed.live ? "live-model-fixed-data" : "stub-cassette-replay",
    evidenceWeight: parsed.live
      ? "Candidate evaluation output; human adjudication and the required live smoke remain separate."
      : "Stub-cassette artifact with no evidentiary weight; never use it as gate evidence.",
    fixtures: parsed.fixtureNames,
    repetitions: parsed.repetitions,
    seed: evaluationSeed,
    randomStreams: {
      derivation: EVALUATION_RANDOM_STREAM_DERIVATION,
      streamSalts: EVALUATION_RANDOM_STREAM_SALTS,
      derivedSeeds: randomStreamSeeds,
    },
    records: perRunRecords,
    aggregate,
    hardGateInputs: hardGates,
    gateVerdict,
  };
  const comparisonPath = join(pairRoot, "evaluation.json");
  await writeFile(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  process.stdout.write(`${comparisonPath}\n`);
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
