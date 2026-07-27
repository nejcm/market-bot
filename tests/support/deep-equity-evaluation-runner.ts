import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, readNumber, readString, readStringArray } from "../../src/guards";
import type { ModelProvider } from "../../src/model/types";
import {
  aggregateDeepEquityEvaluation,
  createSeededEvaluationRandom,
  deepEquityVariantEvaluationMetrics,
  evaluateDeepEquityGates,
  validateDeepEquityEvaluationPlan,
  type DeepEquityEvaluationPlan,
  type DeepEquityEvaluationRunRecord,
  type DeepEquityHardGateInputs,
  type DeepEquityVariantEvaluationMetrics,
  type PairwiseJudgeFailureReason,
  type PairwiseJudgeResult,
} from "./deep-equity-evaluation";
import { isUsablePairwiseJudgeResult, judgeDeepEquityPairSafely } from "./deep-equity-judge";
import {
  discoverResumableEvaluationPairs,
  type ResumableEvaluationPair,
} from "./deep-equity-evaluation-resume";
import {
  deriveEvaluationStreamSeed,
  EVALUATION_RANDOM_STREAM_DERIVATION,
  EVALUATION_RANDOM_STREAM_SALTS,
} from "./evaluation-random";
import {
  runFixturePair,
  type RunFixturePairResult,
  type RunFixtureVariantOutcome,
} from "./run-fixtures";

export const DEEP_EQUITY_EVALUATION_FILE = "evaluation.json";

type EvaluationPlanOrigin = "run-input" | "operator-recovery-input";
type EvaluationPlanLoadSource = "fresh-run" | "existing-artifact" | "operator-recovery";

interface SuccessfulVariantRecord {
  readonly status: "success";
  readonly runDir: string;
  readonly synthesisModel: string;
  /** Optional so artifacts written before quick-model recording still parse. */
  readonly quickModel?: string;
  readonly metrics: DeepEquityVariantEvaluationMetrics;
}

interface FailedVariantRecord {
  readonly status: "error";
  readonly error: string;
  /**
   * Where the failed variant's surviving artifacts were preserved. Optional because a run can fail
   * before any directory exists. Forensics only: an error record is never judged or aggregated.
   */
  readonly runDir?: string;
}

type EvaluationVariantRecord = SuccessfulVariantRecord | FailedVariantRecord;

export interface DeepEquityEvaluationPairArtifactRecord {
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: {
    readonly legacy: EvaluationVariantRecord;
    readonly simplified: EvaluationVariantRecord;
  };
  readonly judge?: PairwiseJudgeResult;
  readonly unjudged?: PairwiseJudgeFailureReason;
}

interface EvaluationContext {
  readonly root: string;
  readonly mode: "live-model-fixed-data" | "stub-cassette-replay";
  readonly evidenceWeight: string;
  readonly fixtures: readonly string[];
  readonly repetitions: number;
  readonly expectedPairCount: number;
  readonly seed: number;
  readonly planOrigin: EvaluationPlanOrigin;
  readonly planLoadSource: EvaluationPlanLoadSource;
}

export interface DeepEquityEvaluationArtifact {
  readonly version: 2;
  readonly runtime: { readonly bunVersion: string };
  readonly mode: EvaluationContext["mode"];
  readonly evidenceWeight: string;
  readonly fixtures: readonly string[];
  readonly repetitions: number;
  readonly plan: {
    readonly provenance: EvaluationPlanOrigin;
    readonly loadSource: EvaluationPlanLoadSource;
    readonly scenarios: readonly string[];
    readonly repetitions: readonly number[];
    readonly expectedPairCount: number;
  };
  readonly seed: number;
  readonly randomStreams: {
    readonly derivation: string;
    readonly streamSalts: typeof EVALUATION_RANDOM_STREAM_SALTS;
    readonly derivedSeeds: {
      readonly variantOrder: number;
      readonly blindLabels: number;
      readonly pairedBootstrap: number;
    };
  };
  readonly records: readonly DeepEquityEvaluationPairArtifactRecord[];
  readonly judging: {
    readonly expectedPairCount: number;
    readonly judgedPairCount: number;
    readonly unjudgedPairCount: number;
    readonly incompletePairCount: number;
    readonly tokenEstimates: {
      readonly judgedPairs: number;
      readonly unjudgedPairs: number;
      readonly totalRecorded: number;
      readonly unjudgedPairsWithoutEstimate: number;
    };
    readonly unjudgedPairs: readonly {
      readonly scenario: string;
      readonly repetition: number;
      readonly reason: PairwiseJudgeFailureReason;
    }[];
  };
  readonly aggregate: ReturnType<typeof aggregateDeepEquityEvaluation>;
  readonly tokenMetrics: {
    readonly wholeRunTraceTokenImprovement: {
      readonly definition: string;
      readonly gateMetric: true;
      readonly requiredMinimum: number;
      readonly medianImprovement: number | null;
    };
    readonly reasoningPromptTokenEstimateReduction: {
      readonly definition: string;
      readonly gateMetric: false;
      readonly evaluatedPairCount: number;
      readonly unavailablePairCount: number;
      readonly medianImprovement: number | null;
    };
  };
  readonly hardGateInputs: DeepEquityHardGateInputs;
  readonly gateVerdict: ReturnType<typeof annotateGateEvidence>;
}

export interface RunPairedEvaluationInput {
  readonly root: string;
  readonly fixtureNames: readonly string[];
  readonly repetitions: number;
  readonly seed: number;
  readonly live: boolean;
  readonly judgeModel?: string;
  readonly provider?: ModelProvider;
}

export interface ResumePairedEvaluationInput {
  readonly root: string;
  readonly live: boolean;
  readonly judgeModel: string;
  readonly seed?: number;
  readonly plan?: DeepEquityEvaluationPlan;
  readonly forceRejudge?: boolean;
  readonly providerForScenario: (scenario: string) => Promise<ModelProvider>;
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

function aggregateRecord(
  record: DeepEquityEvaluationPairArtifactRecord,
): DeepEquityEvaluationRunRecord | undefined {
  const { legacy, simplified } = record.variants;
  if (legacy.status !== "success" || simplified.status !== "success") {
    return undefined;
  }
  return {
    scenario: record.scenario,
    repetition: record.repetition,
    variants: { legacy: legacy.metrics, simplified: simplified.metrics },
    ...(record.judge !== undefined ? { judge: record.judge } : {}),
  };
}

function randomStreamSeeds(seed: number) {
  return {
    variantOrder: deriveEvaluationStreamSeed(seed, "variantOrder"),
    blindLabels: deriveEvaluationStreamSeed(seed, "blindLabels"),
    pairedBootstrap: deriveEvaluationStreamSeed(seed, "pairedBootstrap"),
  };
}

function buildArtifact(
  context: EvaluationContext,
  records: readonly DeepEquityEvaluationPairArtifactRecord[],
): DeepEquityEvaluationArtifact {
  const aggregateRecords = records.flatMap((record) => {
    const aggregate = aggregateRecord(record);
    return aggregate === undefined ? [] : [aggregate];
  });
  const seeds = randomStreamSeeds(context.seed);
  const aggregate = aggregateDeepEquityEvaluation(aggregateRecords, {
    random: createSeededEvaluationRandom(seeds.pairedBootstrap),
    plan: {
      scenarios: context.fixtures,
      repetitions: Array.from({ length: context.repetitions }, (_, index) => index + 1),
    },
  });
  const allReportsValidate = aggregateRecords.length === context.expectedPairCount;
  const hardGateInputs: DeepEquityHardGateInputs = {
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
  const unjudgedPairs = records.flatMap((record) =>
    record.unjudged === undefined
      ? []
      : [
          {
            scenario: record.scenario,
            repetition: record.repetition,
            reason: record.unjudged,
          },
        ],
  );
  const judgedTokenEstimate = records.reduce(
    (total, record) => total + (record.judge?.tokenEstimate ?? 0),
    0,
  );
  const unjudgedTokenEstimate = unjudgedPairs.reduce(
    (total, pair) => total + (pair.reason.tokenEstimate ?? 0),
    0,
  );
  return {
    version: 2,
    runtime: { bunVersion: Bun.version },
    mode: context.mode,
    evidenceWeight: context.evidenceWeight,
    fixtures: context.fixtures,
    repetitions: context.repetitions,
    plan: {
      provenance: context.planOrigin,
      loadSource: context.planLoadSource,
      scenarios: context.fixtures,
      repetitions: Array.from({ length: context.repetitions }, (_, index) => index + 1),
      expectedPairCount: context.expectedPairCount,
    },
    seed: context.seed,
    randomStreams: {
      derivation: EVALUATION_RANDOM_STREAM_DERIVATION,
      streamSalts: EVALUATION_RANDOM_STREAM_SALTS,
      derivedSeeds: seeds,
    },
    records,
    judging: {
      expectedPairCount: context.expectedPairCount,
      judgedPairCount: records.filter((record) => record.judge !== undefined).length,
      unjudgedPairCount: unjudgedPairs.length,
      incompletePairCount: context.expectedPairCount - records.length,
      tokenEstimates: {
        judgedPairs: judgedTokenEstimate,
        unjudgedPairs: unjudgedTokenEstimate,
        totalRecorded: judgedTokenEstimate + unjudgedTokenEstimate,
        unjudgedPairsWithoutEstimate: unjudgedPairs.filter(
          (pair) => pair.reason.tokenEstimate === null,
        ).length,
      },
      unjudgedPairs,
    },
    aggregate,
    tokenMetrics: {
      wholeRunTraceTokenImprovement: {
        definition:
          "(legacy trace.tokenEstimate - simplified trace.tokenEstimate) / legacy trace.tokenEstimate; aggregate is the paired-run median",
        gateMetric: true,
        requiredMinimum: 0.3,
        medianImprovement: aggregate.medianModelTokenImprovement,
      },
      reasoningPromptTokenEstimateReduction: {
        definition:
          "(legacy prompt estimate - simplified prompt estimate) / legacy prompt estimate, where each estimate is ceil(stable prompt characters / 4) summed across variant model calls",
        gateMetric: false,
        evaluatedPairCount: aggregate.reasoningPromptTokens.evaluatedPairCount,
        unavailablePairCount: aggregate.reasoningPromptTokens.unavailablePairCount,
        medianImprovement: aggregate.reasoningPromptTokens.medianImprovement,
      },
    },
    hardGateInputs,
    gateVerdict: annotateGateEvidence(evaluateDeepEquityGates(aggregate, hardGateInputs)),
  };
}

async function writeArtifact(
  context: EvaluationContext,
  records: readonly DeepEquityEvaluationPairArtifactRecord[],
): Promise<DeepEquityEvaluationArtifact> {
  const artifact = buildArtifact(context, records);
  const artifactPath = join(context.root, DEEP_EQUITY_EVALUATION_FILE);
  const temporaryPath = `${artifactPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await rename(temporaryPath, artifactPath);
  return artifact;
}

function outcomeRecord(
  outcome: RunFixtureVariantOutcome,
  metrics: DeepEquityVariantEvaluationMetrics | undefined,
): EvaluationVariantRecord {
  if (outcome.status === "success" && metrics !== undefined) {
    return {
      status: "success",
      runDir: outcome.result.artifacts.runDir,
      synthesisModel: outcome.result.trace.synthesisModel,
      quickModel: outcome.result.trace.quickModel,
      metrics,
    };
  }
  const runDir = outcome.status === "error" ? outcome.runDir : outcome.result.artifacts.runDir;
  return {
    status: "error",
    error: outcome.status === "error" ? outcome.error.message : "variant metrics unavailable",
    ...(runDir !== undefined ? { runDir } : {}),
  };
}

function inlinePairRecord(
  fixtureName: string,
  repetition: number,
  result: RunFixturePairResult,
  judgeRequested: boolean,
): DeepEquityEvaluationPairArtifactRecord {
  const legacyMetrics =
    result.variants.legacy.status === "success"
      ? deepEquityVariantEvaluationMetrics(
          result.variants.legacy.result,
          result.variants.legacy.reasoningPromptTokenEstimate,
        )
      : undefined;
  const simplifiedMetrics =
    result.variants.simplified.status === "success"
      ? deepEquityVariantEvaluationMetrics(
          result.variants.simplified.result,
          result.variants.simplified.reasoningPromptTokenEstimate,
        )
      : undefined;
  const variants = {
    legacy: outcomeRecord(result.variants.legacy, legacyMetrics),
    simplified: outcomeRecord(result.variants.simplified, simplifiedMetrics),
  };
  const unjudged =
    result.unjudged ??
    (result.judge === undefined
      ? {
          code:
            variants.legacy.status === "success" && variants.simplified.status === "success"
              ? ("not-requested" as const)
              : ("variant-failure" as const),
          message: judgeRequested
            ? "pair could not be judged because a variant failed"
            : "pairwise judging was not requested",
          attempts: 0 as const,
          tokenEstimate: null,
        }
      : undefined);
  return {
    scenario: fixtureName,
    repetition,
    variants,
    ...(result.judge !== undefined ? { judge: result.judge } : {}),
    ...(unjudged !== undefined ? { unjudged } : {}),
  };
}

export async function runPairedEvaluation(
  input: RunPairedEvaluationInput,
): Promise<DeepEquityEvaluationArtifact> {
  await mkdir(input.root, { recursive: true });
  const expectedPairCount = input.fixtureNames.length * input.repetitions;
  const context: EvaluationContext = {
    root: input.root,
    mode: input.live ? "live-model-fixed-data" : "stub-cassette-replay",
    evidenceWeight: input.live
      ? "Candidate evaluation output; human adjudication and the required live smoke remain separate."
      : "Stub-cassette artifact with no evidentiary weight; never use it as gate evidence.",
    fixtures: input.fixtureNames,
    repetitions: input.repetitions,
    expectedPairCount,
    seed: input.seed,
    planOrigin: "run-input",
    planLoadSource: "fresh-run",
  };
  const seeds = randomStreamSeeds(input.seed);
  const variantOrderRandom = createSeededEvaluationRandom(seeds.variantOrder);
  const blindLabelRandom = createSeededEvaluationRandom(seeds.blindLabels);
  const records: DeepEquityEvaluationPairArtifactRecord[] = [];
  await writeArtifact(context, records);
  for (const fixtureName of input.fixtureNames) {
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      const result = await runFixturePair(fixtureName, {
        llm: input.live ? "live" : "replay",
        keepDataDir: true,
        dataDir: join(input.root, fixtureName, `repetition-${String(repetition)}`),
        variantOrderRandom,
        blindLabelRandom,
        judge: input.judgeModel !== undefined,
        ...(input.judgeModel !== undefined ? { judgeModel: input.judgeModel } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      });
      records.push(
        inlinePairRecord(fixtureName, repetition, result, input.judgeModel !== undefined),
      );
      await writeArtifact(context, records);
    }
  }
  return buildArtifact(context, records);
}

function recordKey(scenario: string, repetition: number): string {
  return `${scenario}\n${String(repetition)}`;
}

async function readExistingArtifact(root: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function existingSeed(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const seed = readNumber(value, "seed");
  return seed !== undefined && Number.isInteger(seed) ? seed : undefined;
}

function plansEqual(left: DeepEquityEvaluationPlan, right: DeepEquityEvaluationPlan): boolean {
  return (
    left.scenarios.length === right.scenarios.length &&
    left.scenarios.every((scenario, index) => scenario === right.scenarios[index]) &&
    left.repetitions.length === right.repetitions.length &&
    left.repetitions.every((repetition, index) => repetition === right.repetitions[index])
  );
}

function validatedPlan(plan: DeepEquityEvaluationPlan, source: string): DeepEquityEvaluationPlan {
  try {
    validateDeepEquityEvaluationPlan(plan);
    return plan;
  } catch (error) {
    throw new Error(
      `${source} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function supportedPlanOrigin(value: unknown): value is EvaluationPlanOrigin {
  return value === "run-input" || value === "operator-recovery-input";
}

function supportedPlanLoadSource(value: unknown): value is EvaluationPlanLoadSource {
  return value === "fresh-run" || value === "existing-artifact" || value === "operator-recovery";
}

function existingPlan(value: unknown): {
  readonly plan: DeepEquityEvaluationPlan;
  readonly origin: EvaluationPlanOrigin;
} {
  if (!isRecord(value)) {
    throw new Error("resume evaluation.json must contain an authoritative plan");
  }
  const fixtures = readStringArray(value, "fixtures");
  const repetitionCount = readNumber(value, "repetitions");
  if (
    fixtures === undefined ||
    repetitionCount === undefined ||
    !Number.isInteger(repetitionCount) ||
    repetitionCount <= 0
  ) {
    throw new Error(
      "resume evaluation.json must contain valid fixtures and repetitions plan fields",
    );
  }
  const plan = validatedPlan(
    {
      scenarios: fixtures,
      repetitions: Array.from({ length: repetitionCount }, (_, index) => index + 1),
    },
    "resume evaluation.json plan",
  );
  if (!isRecord(value.plan)) {
    throw new Error("resume evaluation.json explicit plan is malformed");
  }
  const provenance = readString(value.plan, "provenance");
  if (!supportedPlanOrigin(provenance)) {
    throw new Error("resume evaluation.json explicit plan provenance is unsupported");
  }
  const loadSource = readString(value.plan, "loadSource");
  if (loadSource !== undefined && !supportedPlanLoadSource(loadSource)) {
    throw new Error("resume evaluation.json explicit plan load source is unsupported");
  }
  const scenarios = readStringArray(value.plan, "scenarios");
  const { repetitions } = value.plan;
  const expectedPairCount = readNumber(value.plan, "expectedPairCount");
  if (
    scenarios === undefined ||
    !Array.isArray(repetitions) ||
    !repetitions.every((repetition) => typeof repetition === "number") ||
    expectedPairCount === undefined
  ) {
    throw new Error("resume evaluation.json explicit plan is malformed");
  }
  const explicitPlan = validatedPlan(
    { scenarios, repetitions },
    "resume evaluation.json explicit plan",
  );
  if (
    !plansEqual(plan, explicitPlan) ||
    expectedPairCount !== plan.scenarios.length * plan.repetitions.length
  ) {
    throw new Error("resume evaluation.json plan fields disagree");
  }
  return { plan, origin: provenance };
}

function resumePlan(
  existing: unknown | undefined,
  suppliedPlan: DeepEquityEvaluationPlan | undefined,
): {
  readonly plan: DeepEquityEvaluationPlan;
  readonly origin: EvaluationPlanOrigin;
  readonly loadSource: EvaluationPlanLoadSource;
} {
  if (existing === undefined) {
    if (suppliedPlan === undefined) {
      throw new Error(
        "resume without evaluation.json requires an authoritative --fixtures and --repetitions plan",
      );
    }
    return {
      plan: validatedPlan(suppliedPlan, "operator recovery plan"),
      origin: "operator-recovery-input",
      loadSource: "operator-recovery",
    };
  }
  if (isRecord(existing) && existing.plan === undefined) {
    if (suppliedPlan === undefined) {
      throw new Error(
        "resume evaluation.json has no explicit authoritative plan; supply --fixtures and --repetitions to recover this legacy artifact",
      );
    }
    return {
      plan: validatedPlan(suppliedPlan, "operator recovery plan"),
      origin: "operator-recovery-input",
      loadSource: "operator-recovery",
    };
  }
  if (
    isRecord(existing) &&
    isRecord(existing.plan) &&
    readString(existing.plan, "provenance") === "existing-artifact"
  ) {
    if (suppliedPlan === undefined) {
      throw new Error(
        "resume evaluation.json has circular plan provenance existing-artifact; supply --fixtures and --repetitions to recover it",
      );
    }
    return {
      plan: validatedPlan(suppliedPlan, "operator recovery plan"),
      origin: "operator-recovery-input",
      loadSource: "operator-recovery",
    };
  }
  const recorded = existingPlan(existing);
  if (suppliedPlan !== undefined) {
    const validatedSuppliedPlan = validatedPlan(suppliedPlan, "operator recovery plan");
    if (!plansEqual(recorded.plan, validatedSuppliedPlan)) {
      throw new Error("operator recovery plan does not match the recorded evaluation plan");
    }
  }
  return {
    plan: recorded.plan,
    origin: recorded.origin,
    loadSource: "existing-artifact",
  };
}

function existingJudges(value: unknown): ReadonlyMap<string, PairwiseJudgeResult> {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return new Map();
  }
  const judges = new Map<string, PairwiseJudgeResult>();
  for (const record of value.records) {
    if (!isRecord(record)) {
      continue;
    }
    const scenario = readString(record, "scenario");
    const repetition = readNumber(record, "repetition");
    if (
      scenario !== undefined &&
      repetition !== undefined &&
      Number.isInteger(repetition) &&
      isUsablePairwiseJudgeResult(record.judge)
    ) {
      judges.set(recordKey(scenario, repetition), record.judge);
    }
  }
  return judges;
}

function existingUnjudgedReasons(value: unknown): ReadonlyMap<string, PairwiseJudgeFailureReason> {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return new Map();
  }
  const reasons = new Map<string, PairwiseJudgeFailureReason>();
  for (const record of value.records) {
    if (!isRecord(record) || !isRecord(record.unjudged)) {
      continue;
    }
    const scenario = readString(record, "scenario");
    const repetition = readNumber(record, "repetition");
    const code = readString(record.unjudged, "code");
    const message = readString(record.unjudged, "message");
    const attempts = readNumber(record.unjudged, "attempts");
    const tokenEstimate = readNumber(record.unjudged, "tokenEstimate");
    if (
      scenario === undefined ||
      repetition === undefined ||
      !Number.isInteger(repetition) ||
      message === undefined ||
      (attempts !== 0 && attempts !== 1 && attempts !== 2) ||
      (code !== "configuration-error" &&
        code !== "invalid-json" &&
        code !== "missing-dimensions" &&
        code !== "schema-validation" &&
        code !== "transport-error" &&
        code !== "not-requested" &&
        code !== "variant-failure")
    ) {
      continue;
    }
    reasons.set(recordKey(scenario, repetition), {
      code,
      message,
      attempts,
      tokenEstimate: tokenEstimate ?? null,
    });
  }
  return reasons;
}

function pendingJudgeReason(): PairwiseJudgeFailureReason {
  return {
    code: "not-requested",
    message: "pair is awaiting resumed judging",
    attempts: 0,
    tokenEstimate: null,
  };
}

function resumePairRecord(
  pair: ResumableEvaluationPair,
  judge?: PairwiseJudgeResult,
  unjudged?: PairwiseJudgeFailureReason,
): DeepEquityEvaluationPairArtifactRecord {
  return {
    scenario: pair.scenario,
    repetition: pair.repetition,
    variants: {
      legacy: {
        status: "success",
        runDir: pair.variants.legacy.runDir,
        synthesisModel: pair.variants.legacy.trace.synthesisModel,
        ...(pair.variants.legacy.quickModel !== undefined
          ? { quickModel: pair.variants.legacy.quickModel }
          : {}),
        metrics: pair.variants.legacy.metrics,
      },
      simplified: {
        status: "success",
        runDir: pair.variants.simplified.runDir,
        synthesisModel: pair.variants.simplified.trace.synthesisModel,
        ...(pair.variants.simplified.quickModel !== undefined
          ? { quickModel: pair.variants.simplified.quickModel }
          : {}),
        metrics: pair.variants.simplified.metrics,
      },
    },
    ...(judge !== undefined ? { judge } : {}),
    ...(unjudged !== undefined ? { unjudged } : {}),
  };
}

export async function resumePairedEvaluation(
  input: ResumePairedEvaluationInput,
): Promise<DeepEquityEvaluationArtifact> {
  const existing = await readExistingArtifact(input.root);
  const { plan, origin, loadSource } = resumePlan(existing, input.plan);
  const recordedSeed = existingSeed(existing);
  if (recordedSeed !== undefined && input.seed !== undefined && recordedSeed !== input.seed) {
    throw new Error(
      `resume seed ${String(input.seed)} does not match recorded seed ${String(recordedSeed)}`,
    );
  }
  const seed = recordedSeed ?? input.seed;
  if (seed === undefined) {
    throw new Error("resume requires --seed when evaluation.json has no recorded seed");
  }
  const discovered = await discoverResumableEvaluationPairs(input.root);
  if (discovered.length === 0) {
    throw new Error(`resume found no completed variant pairs under ${input.root}`);
  }
  const plannedScenarios = new Set(plan.scenarios);
  const plannedRepetitions = new Set(plan.repetitions);
  const unexpectedPair = discovered.find(
    (pair) => !plannedScenarios.has(pair.scenario) || !plannedRepetitions.has(pair.repetition),
  );
  if (unexpectedPair !== undefined) {
    throw new Error(
      `resume discovered pair outside the authoritative plan: ${unexpectedPair.scenario} repetition ${String(unexpectedPair.repetition)}`,
    );
  }
  const fixtureOrder = plan.scenarios;
  const fixtureIndex = new Map(fixtureOrder.map((fixture, index) => [fixture, index]));
  const pairs = discovered.toSorted(
    (left, right) =>
      (fixtureIndex.get(left.scenario) ?? Number.MAX_SAFE_INTEGER) -
        (fixtureIndex.get(right.scenario) ?? Number.MAX_SAFE_INTEGER) ||
      left.repetition - right.repetition,
  );
  const repetitions = plan.repetitions.length;
  const context: EvaluationContext = {
    root: input.root,
    mode: input.live ? "live-model-fixed-data" : "stub-cassette-replay",
    evidenceWeight: input.live
      ? "Candidate evaluation output; human adjudication and the required live smoke remain separate."
      : "Stub-cassette artifact with no evidentiary weight; never use it as gate evidence.",
    fixtures: fixtureOrder,
    repetitions,
    expectedPairCount: fixtureOrder.length * repetitions,
    seed,
    planOrigin: origin,
    planLoadSource: loadSource,
  };
  const storedJudges = existingJudges(existing);
  const storedUnjudgedReasons = existingUnjudgedReasons(existing);
  const blindRandom = createSeededEvaluationRandom(randomStreamSeeds(seed).blindLabels);
  const records = pairs.map((pair) => {
    const key = recordKey(pair.scenario, pair.repetition);
    const storedJudge = storedJudges.get(key);
    return resumePairRecord(
      pair,
      storedJudge,
      storedJudge === undefined
        ? (storedUnjudgedReasons.get(key) ?? pendingJudgeReason())
        : undefined,
    );
  });
  for (const [pairIndex, pair] of pairs.entries()) {
    const blindDraw = blindRandom();
    const storedJudge = storedJudges.get(recordKey(pair.scenario, pair.repetition));
    if (storedJudge !== undefined && input.forceRejudge !== true) {
      continue;
    }
    const provider = await input.providerForScenario(pair.scenario);
    const outcome = await judgeDeepEquityPairSafely({
      provider,
      judgeModel: input.judgeModel,
      synthesisModels: [
        pair.variants.legacy.trace.synthesisModel,
        pair.variants.simplified.trace.synthesisModel,
      ],
      reports: {
        legacy: pair.variants.legacy.report,
        simplified: pair.variants.simplified.report,
      },
      random: () => blindDraw,
    });
    records[pairIndex] =
      outcome.status === "judged"
        ? resumePairRecord(pair, outcome.judge)
        : resumePairRecord(pair, undefined, outcome.reason);
    await writeArtifact(context, records);
  }
  return writeArtifact(context, records);
}
