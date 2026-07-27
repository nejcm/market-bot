import type { ResearchReport } from "../../src/domain/types";
import { isRecord, readNumber, readString, readStringArray } from "../../src/guards";
import type { ModelMessage, ModelProvider } from "../../src/model/types";

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

export type PairwiseJudgeFailureCode =
  | "configuration-error"
  | "invalid-json"
  | "missing-dimensions"
  | "schema-validation"
  | "transport-error"
  | "not-requested"
  | "variant-failure";

export interface PairwiseJudgeFailureReason {
  readonly code: PairwiseJudgeFailureCode;
  readonly message: string;
  readonly attempts: 0 | 1 | 2;
  readonly tokenEstimate: number | null;
}

export type PairwiseJudgeOutcome =
  | { readonly status: "judged"; readonly judge: PairwiseJudgeResult }
  | { readonly status: "unjudged"; readonly reason: PairwiseJudgeFailureReason };

export interface BlindPairwiseJudgeInput {
  readonly provider: ModelProvider;
  readonly judgeModel: string;
  readonly synthesisModels: readonly string[];
  readonly reports: Readonly<Record<DeepEquityPipelineVariant, ResearchReport>>;
  readonly random?: () => number;
}

class PairwiseJudgeError extends Error {
  readonly reason: PairwiseJudgeFailureReason;

  constructor(
    code: PairwiseJudgeFailureCode,
    message: string,
    attempts: PairwiseJudgeFailureReason["attempts"] = 0,
    tokenEstimate: number | null = null,
  ) {
    super(message);
    this.name = "PairwiseJudgeError";
    this.reason = { code, message, attempts, tokenEstimate };
  }
}

function defaultRandom(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4_294_967_296;
}

function score(value: unknown, dimension: PairwiseJudgeDimension, label: BlindLabel): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
    throw new PairwiseJudgeError(
      "schema-validation",
      `pairwise judge ${dimension}.${label} must be an integer from 1 to 5`,
    );
  }
  return value;
}

function parseJsonResponse(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new PairwiseJudgeError("invalid-json", "pairwise judge response must be valid JSON");
  }
}

function parseJudgeResponse(content: string): BlindJudgeResponse {
  const parsed = parseJsonResponse(content);
  if (!isRecord(parsed)) {
    throw new PairwiseJudgeError("schema-validation", "pairwise judge response must be an object");
  }
  const rawDimensions = parsed.dimensions;
  if (!isRecord(rawDimensions)) {
    throw new PairwiseJudgeError(
      "missing-dimensions",
      "pairwise judge response must contain a dimensions object",
    );
  }
  const dimensions = Object.fromEntries(
    PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => {
      const value = rawDimensions[dimension];
      if (!isRecord(value)) {
        throw new PairwiseJudgeError(
          "schema-validation",
          `pairwise judge response is missing dimension ${dimension}`,
        );
      }
      const rationale = readString(value, "rationale");
      if (rationale === undefined) {
        throw new PairwiseJudgeError(
          "schema-validation",
          `pairwise judge ${dimension}.rationale must be non-empty`,
        );
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
    throw new PairwiseJudgeError("schema-validation", "pairwise judge winner must be A, B, or tie");
  }
  const rationale = readString(parsed, "rationale");
  const omissions = parsed.criticalMaterialEvidenceOmissions;
  if (rationale === undefined || !isRecord(omissions)) {
    throw new PairwiseJudgeError(
      "schema-validation",
      "pairwise judge response must contain rationale and criticalMaterialEvidenceOmissions",
    );
  }
  const A = readStringArray(omissions, "A");
  const B = readStringArray(omissions, "B");
  if (A === undefined || B === undefined) {
    throw new PairwiseJudgeError(
      "schema-validation",
      "pairwise judge omission labels must be string arrays",
    );
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

function repairInstruction(reason: PairwiseJudgeFailureReason): string {
  return JSON.stringify({
    stage: "deep-equity-pairwise-judge-repair",
    validationError: reason.message,
    instruction:
      "Return the complete expected object. Do not omit dimensions or any rubric key. Return strict JSON only.",
    requiredShape: {
      dimensions: Object.fromEntries(
        PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => [
          dimension,
          { A: "integer 1-5", B: "integer 1-5", rationale: "non-empty string" },
        ]),
      ),
      winner: "A | B | tie",
      rationale: "non-empty string",
      criticalMaterialEvidenceOmissions: { A: ["string"], B: ["string"] },
    },
  });
}

function variantForLabel(
  labels: Readonly<Record<DeepEquityPipelineVariant, BlindLabel>>,
  label: BlindLabel,
): DeepEquityPipelineVariant {
  return labels.legacy === label ? "legacy" : "simplified";
}

function responseFailure(error: unknown, attempts: 1 | 2): PairwiseJudgeFailureReason {
  if (error instanceof PairwiseJudgeError) {
    return { ...error.reason, attempts };
  }
  return {
    code: "transport-error",
    message: error instanceof Error ? error.message : String(error),
    attempts,
    tokenEstimate: null,
  };
}

export async function judgeDeepEquityPair(
  input: BlindPairwiseJudgeInput,
): Promise<PairwiseJudgeResult> {
  const judgeModel = input.judgeModel.trim();
  if (judgeModel === "") {
    throw new PairwiseJudgeError("configuration-error", "judge model must be non-empty");
  }
  const synthesisModels = [...new Set(input.synthesisModels.map((model) => model.trim()))].filter(
    Boolean,
  );
  if (synthesisModels.includes(judgeModel)) {
    throw new PairwiseJudgeError(
      "configuration-error",
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
  const baseMessages: readonly ModelMessage[] = [
    {
      role: "system",
      content:
        "You are an independent evaluator of research-only market reports. Apply the supplied rubric consistently and return strict JSON only.",
    },
    { role: "user", content: judgePrompt(ordered) },
  ];
  let messages = baseMessages;
  let judged: BlindJudgeResponse | undefined = undefined;
  let tokenEstimate = 0;
  for (const attempt of [1, 2] as const) {
    let response: Awaited<ReturnType<ModelProvider["generate"]>> | undefined = undefined;
    try {
      response = await input.provider.generate({
        model: judgeModel,
        responseFormat: "json",
        params: { temperature: 0 },
        messages,
      });
    } catch (error) {
      const failure = responseFailure(error, attempt);
      if (attempt === 2) {
        throw new PairwiseJudgeError(
          failure.code,
          failure.message,
          failure.attempts,
          tokenEstimate > 0 ? tokenEstimate : failure.tokenEstimate,
        );
      }
      messages = [...baseMessages, { role: "user", content: repairInstruction(failure) }];
      continue;
    }
    tokenEstimate += response.tokenEstimate;
    try {
      judged = parseJudgeResponse(response.content);
      break;
    } catch (error) {
      const failure = responseFailure(error, attempt);
      if (attempt === 2) {
        throw new PairwiseJudgeError(
          failure.code,
          failure.message,
          failure.attempts,
          tokenEstimate,
        );
      }
      messages = [
        ...baseMessages,
        { role: "assistant", content: response.content },
        { role: "user", content: repairInstruction(failure) },
      ];
    }
  }
  if (judged === undefined) {
    throw new PairwiseJudgeError(
      "schema-validation",
      "pairwise judge did not produce a usable response",
      2,
      tokenEstimate > 0 ? tokenEstimate : null,
    );
  }
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
    tokenEstimate,
  };
}

export async function judgeDeepEquityPairSafely(
  input: BlindPairwiseJudgeInput,
): Promise<PairwiseJudgeOutcome> {
  try {
    return { status: "judged", judge: await judgeDeepEquityPair(input) };
  } catch (error) {
    if (error instanceof PairwiseJudgeError) {
      return { status: "unjudged", reason: error.reason };
    }
    return {
      status: "unjudged",
      reason: responseFailure(error, 1),
    };
  }
}

export function isUsablePairwiseJudgeResult(value: unknown): value is PairwiseJudgeResult {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    readString(value, "judgeModel") === undefined ||
    !Array.isArray(value.blindOrder) ||
    value.blindOrder.length !== 2 ||
    !value.blindOrder.every((label) => label === "A" || label === "B") ||
    !isRecord(value.blindLabels) ||
    (value.blindLabels.legacy !== "A" && value.blindLabels.legacy !== "B") ||
    (value.blindLabels.simplified !== "A" && value.blindLabels.simplified !== "B") ||
    value.blindLabels.legacy === value.blindLabels.simplified ||
    !Array.isArray(value.dimensions) ||
    readString(value, "rationale") === undefined ||
    !isRecord(value.criticalMaterialEvidenceOmissions) ||
    readStringArray(value.criticalMaterialEvidenceOmissions, "legacy") === undefined ||
    readStringArray(value.criticalMaterialEvidenceOmissions, "simplified") === undefined ||
    readNumber(value, "tokenEstimate") === undefined
  ) {
    return false;
  }
  const dimensions = value.dimensions.filter((dimension) => {
    if (!isRecord(dimension)) {
      return false;
    }
    const dimensionName = readString(dimension, "dimension");
    const legacyScore = readNumber(dimension, "legacyScore");
    const simplifiedScore = readNumber(dimension, "simplifiedScore");
    return (
      dimensionName !== undefined &&
      PAIRWISE_JUDGE_DIMENSIONS.includes(dimensionName as PairwiseJudgeDimension) &&
      legacyScore !== undefined &&
      Number.isInteger(legacyScore) &&
      legacyScore >= 1 &&
      legacyScore <= 5 &&
      simplifiedScore !== undefined &&
      Number.isInteger(simplifiedScore) &&
      simplifiedScore >= 1 &&
      simplifiedScore <= 5 &&
      readString(dimension, "rationale") !== undefined
    );
  });
  return (
    dimensions.length === PAIRWISE_JUDGE_DIMENSIONS.length &&
    new Set(dimensions.map((dimension) => (dimension as Record<string, unknown>).dimension))
      .size === PAIRWISE_JUDGE_DIMENSIONS.length &&
    (value.decision === "legacy" || value.decision === "simplified" || value.decision === "tie")
  );
}
