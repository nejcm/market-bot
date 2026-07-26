import type { ReportIntegrity, ResearchReport } from "../../src/domain/types";
import { isRecord, readString, readStringArray } from "../../src/guards";
import type { ModelProvider } from "../../src/model/types";
import { assertSafeReportLanguage, validatePredictions } from "../../src/report/schema";
import type { StageOutput } from "../../src/research/final-synthesis";
import {
  persistResearchJob,
  type PersistedResearchJobResult,
  type RunResearchJobInput,
} from "../../src/research/orchestrator";

export const DEEP_EQUITY_PIPELINE_VARIANTS = ["legacy", "simplified"] as const;

export type DeepEquityPipelineVariant = (typeof DEEP_EQUITY_PIPELINE_VARIANTS)[number];

export const PAIRWISE_JUDGE_DIMENSIONS = [
  "evidence-grounding-citations",
  "financial-valuation-reasoning",
  "catalysts-material-events",
  "downside-counterevidence",
  "scenario-prediction-specificity",
  "uncertainty-gap-disclosure",
] as const;

export type PairwiseJudgeDimension = (typeof PAIRWISE_JUDGE_DIMENSIONS)[number];

type BlindLabel = "A" | "B";

export async function runDeepEquityPipelineVariant(
  variant: DeepEquityPipelineVariant,
  input: RunResearchJobInput,
): Promise<PersistedResearchJobResult> {
  if (
    input.command.jobType !== "equity" ||
    input.command.assetClass !== "equity" ||
    input.command.depth !== "deep"
  ) {
    throw new Error("deep-equity evaluation requires an equity <symbol> --deep command");
  }
  return persistResearchJob({ ...input, reasoningVariant: variant });
}

interface BlindDimensionScore {
  readonly A: number;
  readonly B: number;
  readonly rationale: string;
}

interface BlindJudgeResponse {
  readonly dimensions: Readonly<Record<PairwiseJudgeDimension, BlindDimensionScore>>;
  readonly winner: BlindLabel | "tie";
  readonly rationale: string;
  readonly criticalMaterialEvidenceOmissions: Readonly<Record<BlindLabel, readonly string[]>>;
}

export interface PairwiseJudgeResult {
  readonly version: 1;
  readonly judgeModel: string;
  readonly blindOrder: readonly BlindLabel[];
  readonly blindLabels: Readonly<Record<DeepEquityPipelineVariant, BlindLabel>>;
  readonly dimensions: readonly {
    readonly dimension: PairwiseJudgeDimension;
    readonly legacyScore: number;
    readonly simplifiedScore: number;
    readonly rationale: string;
  }[];
  readonly decision: DeepEquityPipelineVariant | "tie";
  readonly rationale: string;
  readonly criticalMaterialEvidenceOmissions: Readonly<
    Record<DeepEquityPipelineVariant, readonly string[]>
  >;
  readonly tokenEstimate: number;
}

export interface DeepEquityVariantEvaluationMetrics {
  readonly researchOnlyBoundaryPassed: boolean;
  readonly persistedPredictionsValidate: boolean;
  readonly validPredictionCount: number;
  readonly citedSourceUtilization: number;
  readonly allCitedSourceIdsResolve: boolean;
  readonly modelTokenEstimate: number;
  readonly coreReasoningCallCount: number;
  readonly totalReasoningCallCount: number;
  readonly reportIntegrity: ReportIntegrity | "missing";
  readonly deterministicEvidenceCoverageRatio: number | null;
}

export interface DeepEquityEvaluationRunRecord {
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: Readonly<
    Record<DeepEquityPipelineVariant, DeepEquityVariantEvaluationMetrics>
  >;
  readonly judge?: PairwiseJudgeResult;
}

export interface DeepEquityScenarioAggregate {
  readonly scenario: string;
  readonly repetitions: readonly number[];
  readonly simplifiedWins: number;
  readonly simplifiedLosses: number;
  readonly ties: number;
  readonly legacyMedianValidPredictionCount: number;
  readonly simplifiedMedianValidPredictionCount: number;
  readonly validPredictionMedianDifference: number;
}

export interface DeepEquityEvaluationAggregate {
  readonly version: 1;
  readonly runCount: number;
  readonly rubric: {
    readonly evaluatedPairCount: number;
    readonly meanDifference: number | null;
    readonly pairedBootstrap95PercentCi: {
      readonly lowerBound: number | null;
      readonly upperBound: number | null;
      readonly iterations: number;
    };
  };
  readonly pairwise: {
    readonly evaluatedPairCount: number;
    readonly unevaluatedPairCount: number;
    readonly simplifiedWins: number;
    readonly simplifiedLosses: number;
    readonly ties: number;
    readonly simplifiedWinRate: number;
    readonly simplifiedLossRate: number;
    readonly tieRate: number;
  };
  readonly scenarios: readonly DeepEquityScenarioAggregate[];
  readonly citedSourceUtilizationDelta: number | null;
  readonly medianModelTokenImprovement: number | null;
  readonly reasoningCalls: {
    readonly allRunsUseThreeCoreCalls: boolean;
    readonly allRunsUseAtMostFiveTotalCalls: boolean;
    readonly maximumCoreCallCount: number | null;
    readonly maximumTotalCallCount: number | null;
  };
}

export interface DeepEquityHardGateInputs {
  readonly allReportsValidate: boolean;
  readonly allCitedSourceIdsResolve: boolean;
  readonly zeroResearchOnlyBoundaryViolations: boolean;
  readonly zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: boolean;
  readonly noAdditionalLowIntegrityReports: boolean;
  readonly noDeterministicEvidenceCoverageRegression: boolean;
  readonly noInvalidPredictionsPersist: boolean;
  readonly humanReviewApproved: boolean;
  readonly liveSmokePassed: boolean;
}

export const DEEP_EQUITY_GATE_NAMES = [
  "all-reports-validate",
  "all-cited-source-ids-resolve",
  "zero-research-only-boundary-violations",
  "zero-critical-material-evidence-omissions",
  "no-additional-low-integrity-reports",
  "no-deterministic-evidence-coverage-regression",
  "no-invalid-predictions-persist",
  "rubric-non-inferiority",
  "pairwise-loss-rate",
  "scenario-repetition-losses",
  "valid-prediction-count",
  "cited-source-utilization",
  "model-token-improvement",
  "reasoning-call-budget",
  "human-review-approval",
  "live-smoke",
] as const;

export type DeepEquityGateName = (typeof DEEP_EQUITY_GATE_NAMES)[number];
export type DeepEquityGateCategory = "hard" | "non-inferiority" | "human-review" | "live-smoke";

export interface DeepEquityGateResult {
  readonly name: DeepEquityGateName;
  readonly category: DeepEquityGateCategory;
  readonly passed: boolean;
  readonly actual: boolean | number | null | string;
  readonly requirement: string;
}

export interface DeepEquityGateVerdict {
  readonly status: "pass" | "fail";
  readonly passed: boolean;
  readonly gates: readonly DeepEquityGateResult[];
  readonly failingGates: readonly DeepEquityGateName[];
}

// Plan thresholds: line 187 rubric; 188 loss; 171/189 repetitions; 190 predictions.
export const MIN_RUBRIC_CI_LOWER_BOUND = -0.25;
export const MAX_SIMPLIFIED_PAIRWISE_LOSS_RATE = 0.2;
export const REQUIRED_SCENARIO_REPETITIONS = 3;
export const MAX_VALID_PREDICTION_MEDIAN_DEFICIT = 1;
// Plan thresholds: line 191 citations; 192 tokens; 193 core/total calls.
export const MIN_CITED_SOURCE_UTILIZATION_DELTA = -0.05;
export const MIN_MEDIAN_MODEL_TOKEN_IMPROVEMENT = 0.3;
export const REQUIRED_CORE_REASONING_CALLS = 3;
export const MAX_TOTAL_REASONING_CALLS = 5;

const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_BOOTSTRAP_SEED = 1_511_467_046;
const RANDOM_MODULUS = 2_147_483_647;
const RANDOM_MULTIPLIER = 48_271;
const LOWER_PERCENTILE = 0.025;
const UPPER_PERCENTILE = 0.975;
const CORE_REASONING_STAGES = new Set(["equity-analysis", "critique", "final-synthesis"]);

interface BlindPairwiseJudgeInput {
  readonly provider: ModelProvider;
  readonly judgeModel: string;
  readonly synthesisModels: readonly string[];
  readonly reports: Readonly<Record<DeepEquityPipelineVariant, ResearchReport>>;
  readonly random?: () => number;
}

function defaultRandom(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4_294_967_296;
}

export function createSeededEvaluationRandom(seed: number): () => number {
  if (!Number.isInteger(seed)) {
    throw new TypeError("evaluation seed must be an integer");
  }
  let state = Math.abs(seed) % RANDOM_MODULUS || 1;
  return () => {
    state = (state * RANDOM_MULTIPLIER) % RANDOM_MODULUS;
    return (state - 1) / (RANDOM_MODULUS - 1);
  };
}

function citationReferences(value: unknown, references: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      citationReferences(item, references);
    }
    return references;
  }
  if (value === null || typeof value !== "object") {
    return references;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "sourceIds" && Array.isArray(item)) {
      references.push(
        ...item.filter((sourceId): sourceId is string => typeof sourceId === "string"),
      );
    } else {
      citationReferences(item, references);
    }
  }
  return references;
}

function excludedReasoningCall(output: StageOutput): boolean {
  if (output.stage === "financial-table-mapping" || output.stage === "forecast-disagreement") {
    return true;
  }
  return (
    output.stage === "final-synthesis" &&
    output.repromptReason !== undefined &&
    output.repromptReason.predictionCompletion === undefined
  );
}

function passesValidation(check: () => void): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

export function deepEquityVariantEvaluationMetrics(
  result: Pick<PersistedResearchJobResult, "report" | "stageOutputs" | "trace">,
): DeepEquityVariantEvaluationMetrics {
  const references = new Set(citationReferences(result.report));
  const sourceIds = new Set(result.report.sources.map((source) => source.id));
  const predictionValidation = validatePredictions(result.report.predictions, sourceIds);
  const budgetedCalls = result.stageOutputs.filter((output) => !excludedReasoningCall(output));
  return {
    researchOnlyBoundaryPassed: passesValidation(() => {
      assertSafeReportLanguage(result.report);
    }),
    persistedPredictionsValidate:
      predictionValidation.errors.length === 0 &&
      predictionValidation.valid.length === result.report.predictions.length,
    validPredictionCount: result.report.predictions.length,
    citedSourceUtilization:
      result.report.sources.length === 0 ? 0 : references.size / result.report.sources.length,
    allCitedSourceIdsResolve: [...references].every((sourceId) => sourceIds.has(sourceId)),
    modelTokenEstimate: result.trace.tokenEstimate,
    coreReasoningCallCount: budgetedCalls.filter(
      (output) => output.repromptReason === undefined && CORE_REASONING_STAGES.has(output.stage),
    ).length,
    totalReasoningCallCount: budgetedCalls.length,
    reportIntegrity: result.report.reportIntegrity ?? "missing",
    deterministicEvidenceCoverageRatio: result.trace.evidenceLanes?.coverageRatio ?? null,
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("mean requires at least one value");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median requires at least one value");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2
    : (sorted[midpoint] ?? 0);
}

function rubricDifference(result: PairwiseJudgeResult): number {
  if (result.dimensions.length === 0) {
    throw new Error("pairwise judge result must contain rubric dimensions");
  }
  return mean(
    result.dimensions.map((dimension) => dimension.simplifiedScore - dimension.legacyScore),
  );
}

function percentile(sorted: readonly number[], proportion: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * proportion) - 1);
  return sorted[index] ?? sorted.at(-1) ?? 0;
}

function pairedBootstrapConfidenceInterval(
  differences: readonly number[],
  iterations: number,
  random: () => number,
): { readonly lowerBound: number; readonly upperBound: number } {
  const estimates = Array.from({ length: iterations }, () => {
    const sample = Array.from({ length: differences.length }, () => {
      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
        throw new TypeError("evaluation RNG must return a finite value in [0, 1)");
      }
      return differences[Math.floor(draw * differences.length)] ?? 0;
    });
    return mean(sample);
  });
  const sorted = estimates.toSorted((left, right) => left - right);
  return {
    lowerBound: percentile(sorted, LOWER_PERCENTILE),
    upperBound: percentile(sorted, UPPER_PERCENTILE),
  };
}

interface AggregateEvaluationOptions {
  readonly bootstrapIterations?: number;
  readonly random?: () => number;
}

export function aggregateDeepEquityEvaluation(
  records: readonly DeepEquityEvaluationRunRecord[],
  options: AggregateEvaluationOptions = {},
): DeepEquityEvaluationAggregate {
  const iterations = options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new TypeError("bootstrap iterations must be a positive integer");
  }
  const judgedRecords = records.filter(
    (record): record is DeepEquityEvaluationRunRecord & { readonly judge: PairwiseJudgeResult } =>
      record.judge !== undefined,
  );
  const rubricDifferences = judgedRecords.map((record) => rubricDifference(record.judge));
  const confidenceInterval =
    rubricDifferences.length === 0
      ? undefined
      : pairedBootstrapConfidenceInterval(
          rubricDifferences,
          iterations,
          options.random ?? createSeededEvaluationRandom(DEFAULT_BOOTSTRAP_SEED),
        );
  const simplifiedWins = judgedRecords.filter(
    (record) => record.judge.decision === "simplified",
  ).length;
  const simplifiedLosses = judgedRecords.filter(
    (record) => record.judge.decision === "legacy",
  ).length;
  const ties = judgedRecords.length - simplifiedWins - simplifiedLosses;
  const scenarioNames = [...new Set(records.map((record) => record.scenario))].toSorted();
  const scenarios = scenarioNames.map((scenario): DeepEquityScenarioAggregate => {
    const scenarioRecords = records.filter((record) => record.scenario === scenario);
    const scenarioJudges = scenarioRecords.flatMap((record) =>
      record.judge === undefined ? [] : [record.judge],
    );
    const legacyMedianValidPredictionCount = median(
      scenarioRecords.map((record) => record.variants.legacy.validPredictionCount),
    );
    const simplifiedMedianValidPredictionCount = median(
      scenarioRecords.map((record) => record.variants.simplified.validPredictionCount),
    );
    return {
      scenario,
      repetitions: scenarioRecords.map((record) => record.repetition).toSorted((a, b) => a - b),
      simplifiedWins: scenarioJudges.filter((judge) => judge.decision === "simplified").length,
      simplifiedLosses: scenarioJudges.filter((judge) => judge.decision === "legacy").length,
      ties: scenarioJudges.filter((judge) => judge.decision === "tie").length,
      legacyMedianValidPredictionCount,
      simplifiedMedianValidPredictionCount,
      validPredictionMedianDifference:
        simplifiedMedianValidPredictionCount - legacyMedianValidPredictionCount,
    };
  });
  const citedSourceUtilizationDelta =
    records.length === 0
      ? null
      : mean(
          records.map(
            (record) =>
              record.variants.simplified.citedSourceUtilization -
              record.variants.legacy.citedSourceUtilization,
          ),
        );
  const medianModelTokenImprovement =
    records.length === 0
      ? null
      : median(
          records.map((record) => {
            const legacy = record.variants.legacy.modelTokenEstimate;
            if (!Number.isFinite(legacy) || legacy <= 0) {
              throw new Error("legacy model token estimate must be positive");
            }
            return (legacy - record.variants.simplified.modelTokenEstimate) / legacy;
          }),
        );
  const simplifiedMetrics = records.map((record) => record.variants.simplified);
  const evaluatedPairCount = judgedRecords.length;
  return {
    version: 1,
    runCount: records.length,
    rubric: {
      evaluatedPairCount,
      meanDifference: rubricDifferences.length === 0 ? null : mean(rubricDifferences),
      pairedBootstrap95PercentCi: {
        lowerBound: confidenceInterval?.lowerBound ?? null,
        upperBound: confidenceInterval?.upperBound ?? null,
        iterations,
      },
    },
    pairwise: {
      evaluatedPairCount,
      unevaluatedPairCount: records.length - evaluatedPairCount,
      simplifiedWins,
      simplifiedLosses,
      ties,
      simplifiedWinRate: evaluatedPairCount === 0 ? 0 : simplifiedWins / evaluatedPairCount,
      simplifiedLossRate: evaluatedPairCount === 0 ? 0 : simplifiedLosses / evaluatedPairCount,
      tieRate: evaluatedPairCount === 0 ? 0 : ties / evaluatedPairCount,
    },
    scenarios,
    citedSourceUtilizationDelta,
    medianModelTokenImprovement,
    reasoningCalls: {
      allRunsUseThreeCoreCalls:
        simplifiedMetrics.length > 0 &&
        simplifiedMetrics.every(
          (metrics) => metrics.coreReasoningCallCount === REQUIRED_CORE_REASONING_CALLS,
        ),
      allRunsUseAtMostFiveTotalCalls:
        simplifiedMetrics.length > 0 &&
        simplifiedMetrics.every(
          (metrics) => metrics.totalReasoningCallCount <= MAX_TOTAL_REASONING_CALLS,
        ),
      maximumCoreCallCount:
        simplifiedMetrics.length === 0
          ? null
          : Math.max(...simplifiedMetrics.map((metrics) => metrics.coreReasoningCallCount)),
      maximumTotalCallCount:
        simplifiedMetrics.length === 0
          ? null
          : Math.max(...simplifiedMetrics.map((metrics) => metrics.totalReasoningCallCount)),
    },
  };
}

export function evaluateDeepEquityGates(
  aggregate: DeepEquityEvaluationAggregate,
  hardGates: DeepEquityHardGateInputs,
): DeepEquityGateVerdict {
  const ciLowerBound = aggregate.rubric.pairedBootstrap95PercentCi.lowerBound;
  const scenarioRepetitionGate =
    aggregate.scenarios.length > 0 &&
    aggregate.scenarios.every(
      (scenario) =>
        scenario.repetitions.length === REQUIRED_SCENARIO_REPETITIONS &&
        scenario.simplifiedLosses < 2,
    );
  const validPredictionGate =
    aggregate.scenarios.length > 0 &&
    aggregate.scenarios.every(
      (scenario) =>
        scenario.validPredictionMedianDifference >= -MAX_VALID_PREDICTION_MEDIAN_DEFICIT,
    );
  const reasoningCallGate =
    aggregate.reasoningCalls.allRunsUseThreeCoreCalls &&
    aggregate.reasoningCalls.allRunsUseAtMostFiveTotalCalls;
  const gates: readonly DeepEquityGateResult[] = [
    {
      name: "all-reports-validate",
      category: "hard",
      passed: hardGates.allReportsValidate,
      actual: hardGates.allReportsValidate,
      requirement: "all reports validate",
    },
    {
      name: "all-cited-source-ids-resolve",
      category: "hard",
      passed: hardGates.allCitedSourceIdsResolve,
      actual: hardGates.allCitedSourceIdsResolve,
      requirement: "all cited source IDs resolve",
    },
    {
      name: "zero-research-only-boundary-violations",
      category: "hard",
      passed: hardGates.zeroResearchOnlyBoundaryViolations,
      actual: hardGates.zeroResearchOnlyBoundaryViolations,
      requirement: "zero research-only boundary violations",
    },
    {
      name: "zero-critical-material-evidence-omissions",
      category: "hard",
      passed: hardGates.zeroCriticalMaterialEvidenceOmissionsAfterAdjudication,
      actual: hardGates.zeroCriticalMaterialEvidenceOmissionsAfterAdjudication,
      requirement: "zero critical material-evidence omissions after adjudication",
    },
    {
      name: "no-additional-low-integrity-reports",
      category: "hard",
      passed: hardGates.noAdditionalLowIntegrityReports,
      actual: hardGates.noAdditionalLowIntegrityReports,
      requirement: "no additional low-integrity reports",
    },
    {
      name: "no-deterministic-evidence-coverage-regression",
      category: "hard",
      passed: hardGates.noDeterministicEvidenceCoverageRegression,
      actual: hardGates.noDeterministicEvidenceCoverageRegression,
      requirement: "no regression in deterministic evidence coverage",
    },
    {
      name: "no-invalid-predictions-persist",
      category: "hard",
      passed: hardGates.noInvalidPredictionsPersist,
      actual: hardGates.noInvalidPredictionsPersist,
      requirement: "no invalid predictions persist",
    },
    {
      name: "rubric-non-inferiority",
      category: "non-inferiority",
      passed: ciLowerBound !== null && ciLowerBound >= MIN_RUBRIC_CI_LOWER_BOUND,
      actual: ciLowerBound,
      requirement: `paired-bootstrap 95% CI lower bound >= ${String(MIN_RUBRIC_CI_LOWER_BOUND)}`,
    },
    {
      name: "pairwise-loss-rate",
      category: "non-inferiority",
      passed:
        aggregate.pairwise.evaluatedPairCount > 0 &&
        aggregate.pairwise.simplifiedLossRate <= MAX_SIMPLIFIED_PAIRWISE_LOSS_RATE,
      actual: aggregate.pairwise.simplifiedLossRate,
      requirement: `simplified pairwise loss rate <= ${String(MAX_SIMPLIFIED_PAIRWISE_LOSS_RATE)}`,
    },
    {
      name: "scenario-repetition-losses",
      category: "non-inferiority",
      passed: scenarioRepetitionGate,
      actual: scenarioRepetitionGate,
      requirement: "three repetitions per scenario and fewer than two simplified losses",
    },
    {
      name: "valid-prediction-count",
      category: "non-inferiority",
      passed: validPredictionGate,
      actual: validPredictionGate,
      requirement: "each simplified scenario median is at most one prediction below legacy",
    },
    {
      name: "cited-source-utilization",
      category: "non-inferiority",
      passed:
        aggregate.citedSourceUtilizationDelta !== null &&
        aggregate.citedSourceUtilizationDelta >= MIN_CITED_SOURCE_UTILIZATION_DELTA,
      actual: aggregate.citedSourceUtilizationDelta,
      requirement: `mean cited-source utilization delta >= ${String(MIN_CITED_SOURCE_UTILIZATION_DELTA)}`,
    },
    {
      name: "model-token-improvement",
      category: "non-inferiority",
      passed:
        aggregate.medianModelTokenImprovement !== null &&
        aggregate.medianModelTokenImprovement >= MIN_MEDIAN_MODEL_TOKEN_IMPROVEMENT,
      actual: aggregate.medianModelTokenImprovement,
      requirement: `median model-token improvement >= ${String(MIN_MEDIAN_MODEL_TOKEN_IMPROVEMENT)}`,
    },
    {
      name: "reasoning-call-budget",
      category: "non-inferiority",
      passed: reasoningCallGate,
      actual: reasoningCallGate,
      requirement: `${String(REQUIRED_CORE_REASONING_CALLS)} core calls and <= ${String(MAX_TOTAL_REASONING_CALLS)} total calls`,
    },
    {
      name: "human-review-approval",
      category: "human-review",
      passed: hardGates.humanReviewApproved,
      actual: hardGates.humanReviewApproved,
      requirement: "required blinded review completed and cutover explicitly approved",
    },
    {
      name: "live-smoke",
      category: "live-smoke",
      passed: hardGates.liveSmokePassed,
      actual: hardGates.liveSmokePassed,
      requirement: "AAPL, ASTS, NBIS, and SAP.DE paired live smoke passes",
    },
  ];
  const failingGates = gates.filter((gate) => !gate.passed).map((gate) => gate.name);
  return {
    status: failingGates.length === 0 ? "pass" : "fail",
    passed: failingGates.length === 0,
    gates,
    failingGates,
  };
}

function score(value: unknown, dimension: PairwiseJudgeDimension, label: BlindLabel): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`pairwise judge ${dimension}.${label} must be an integer from 1 to 5`);
  }
  return value;
}

function parseJudgeResponse(content: string): BlindJudgeResponse {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("pairwise judge response must be an object");
  }
  const rawDimensions = parsed.dimensions;
  if (!isRecord(rawDimensions)) {
    throw new Error("pairwise judge response must contain a dimensions object");
  }
  const dimensions = Object.fromEntries(
    PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => {
      const value = rawDimensions[dimension];
      if (!isRecord(value)) {
        throw new Error(`pairwise judge response is missing dimension ${dimension}`);
      }
      const rationale = readString(value, "rationale");
      if (rationale === undefined) {
        throw new Error(`pairwise judge ${dimension}.rationale must be non-empty`);
      }
      return [
        dimension,
        {
          A: score(value.A, dimension, "A"),
          B: score(value.B, dimension, "B"),
          rationale,
        },
      ];
    }),
  ) as Record<PairwiseJudgeDimension, BlindDimensionScore>;
  const { winner } = parsed;
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    throw new Error("pairwise judge winner must be A, B, or tie");
  }
  const rationale = readString(parsed, "rationale");
  const omissions = parsed.criticalMaterialEvidenceOmissions;
  if (rationale === undefined || !isRecord(omissions)) {
    throw new Error(
      "pairwise judge response must contain rationale and criticalMaterialEvidenceOmissions",
    );
  }
  const A = readStringArray(omissions, "A");
  const B = readStringArray(omissions, "B");
  if (A === undefined || B === undefined) {
    throw new Error("pairwise judge omission labels must be string arrays");
  }
  return {
    dimensions,
    winner,
    rationale,
    criticalMaterialEvidenceOmissions: { A, B },
  };
}

function judgePrompt(
  ordered: readonly {
    readonly label: BlindLabel;
    readonly report: ResearchReport;
  }[],
): string {
  return JSON.stringify({
    stage: "deep-equity-pairwise-judge",
    task: "Blindly compare two research-only deep-equity reports from the same evidence state.",
    scoring: "Score each report from 1 (poor) to 5 (excellent) on every rubric dimension.",
    rubric: {
      "evidence-grounding-citations":
        "Claims are grounded in the supplied evidence and citations are relevant and sufficient.",
      "financial-valuation-reasoning":
        "Financial statements, operating performance, valuation, and peer evidence are interpreted coherently.",
      "catalysts-material-events":
        "Material events and catalysts are identified, dated, and weighted appropriately.",
      "downside-counterevidence":
        "Risks, downside evidence, contradictions, and counterarguments are treated seriously.",
      "scenario-prediction-specificity":
        "Scenarios and observable predictions are specific, measurable, and evidence-supported.",
      "uncertainty-gap-disclosure":
        "Uncertainty, missing evidence, provider gaps, and limitations are disclosed clearly.",
    },
    instructions: [
      "The labels are randomized and contain no pipeline identity. Do not infer or discuss implementation identity.",
      "Judge only the supplied reports. Do not add investment advice or trade-action language.",
      "Return strict JSON with dimensions keyed by every rubric key.",
      "Each dimension value must be {A:1-5,B:1-5,rationale:string}.",
      "Also return winner as A, B, or tie; an overall rationale; and criticalMaterialEvidenceOmissions as {A:string[],B:string[]}.",
    ],
    reports: ordered,
  });
}

function variantForLabel(
  labels: Readonly<Record<DeepEquityPipelineVariant, BlindLabel>>,
  label: BlindLabel,
): DeepEquityPipelineVariant {
  return labels.legacy === label ? "legacy" : "simplified";
}

export async function judgeDeepEquityPair(
  input: BlindPairwiseJudgeInput,
): Promise<PairwiseJudgeResult> {
  const judgeModel = input.judgeModel.trim();
  if (judgeModel === "") {
    throw new Error("judge model must be non-empty");
  }
  const synthesisModels = [...new Set(input.synthesisModels.map((model) => model.trim()))].filter(
    Boolean,
  );
  if (synthesisModels.includes(judgeModel)) {
    throw new Error(
      `judge model "${judgeModel}" must differ from synthesis model(s): ${synthesisModels.join(", ")}`,
    );
  }
  const legacyFirst = (input.random ?? defaultRandom)() < 0.5;
  const labels: Readonly<Record<DeepEquityPipelineVariant, BlindLabel>> = legacyFirst
    ? { legacy: "A", simplified: "B" }
    : { legacy: "B", simplified: "A" };
  const ordered = (["A", "B"] as const).map((label) => {
    const variant = variantForLabel(labels, label);
    return { label, report: input.reports[variant] };
  });
  const response = await input.provider.generate({
    model: judgeModel,
    responseFormat: "json",
    params: { temperature: 0 },
    messages: [
      {
        role: "system",
        content:
          "You are an independent evaluator of research-only market reports. Apply the supplied rubric consistently and return strict JSON only.",
      },
      { role: "user", content: judgePrompt(ordered) },
    ],
  });
  const judged = parseJudgeResponse(response.content);
  const scoreFor = (
    dimension: PairwiseJudgeDimension,
    variant: DeepEquityPipelineVariant,
  ): number => judged.dimensions[dimension][labels[variant]];
  return {
    version: 1,
    judgeModel,
    blindOrder: ordered.map((entry) => entry.label),
    blindLabels: labels,
    dimensions: PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => ({
      dimension,
      legacyScore: scoreFor(dimension, "legacy"),
      simplifiedScore: scoreFor(dimension, "simplified"),
      rationale: judged.dimensions[dimension].rationale,
    })),
    decision: judged.winner === "tie" ? "tie" : variantForLabel(labels, judged.winner),
    rationale: judged.rationale,
    criticalMaterialEvidenceOmissions: {
      legacy: judged.criticalMaterialEvidenceOmissions[labels.legacy],
      simplified: judged.criticalMaterialEvidenceOmissions[labels.simplified],
    },
    tokenEstimate: response.tokenEstimate,
  };
}
