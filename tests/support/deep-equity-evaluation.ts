import type { ResearchReport } from "../../src/domain/types";
import { isRecord, readString, readStringArray } from "../../src/guards";
import type { ModelProvider } from "../../src/model/types";
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

export class SimplifiedPipelineNotImplementedError extends Error {
  readonly variant = "simplified";

  constructor() {
    super("simplified pipeline not yet implemented");
    this.name = "SimplifiedPipelineNotImplementedError";
  }
}

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
  if (variant === "simplified") {
    throw new SimplifiedPipelineNotImplementedError();
  }
  return persistResearchJob(input);
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
