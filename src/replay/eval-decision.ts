import type { AnalysisStage } from "../research/analysis-phase";

const SPECIALIST_CONSUMERS = [
  "instrument-evidence-analysis",
  "market-behavior-analysis",
  "critique",
] as const;

// Each nonterminal arm skips its stage and regenerates the consumers live; its control regenerates the same consumers with the stage kept.
export const ABLATION_ARMS = {
  critique: { stage: "critique", removed: ["critique"], regenerated: [], control: "baseline" },
  "specialist-analysis": {
    stage: "specialist-analysis",
    removed: ["specialist-analysis"],
    regenerated: SPECIALIST_CONSUMERS,
    control: "specialist-analysis-control",
  },
  "specialist-analysis-control": {
    stage: "specialist-analysis",
    removed: [],
    regenerated: SPECIALIST_CONSUMERS,
  },
  "market-behavior-analysis": {
    stage: "market-behavior-analysis",
    removed: ["market-behavior-analysis"],
    regenerated: ["critique"],
    control: "market-behavior-analysis-control",
  },
  "market-behavior-analysis-control": {
    stage: "market-behavior-analysis",
    removed: [],
    regenerated: ["critique"],
  },
} as const satisfies Record<
  string,
  {
    readonly stage: AnalysisStage;
    readonly removed: readonly AnalysisStage[];
    readonly regenerated: readonly AnalysisStage[];
    readonly control?: string;
  }
>;

type ArmScores = Readonly<Record<string, readonly (number | null)[]>>;

const MARGIN = 0.5;
const RESAMPLES = 10_000;
const SEED = 0x5e_ed;
const CONVEYED_SHARE = 2 / 3;
const INSUFFICIENT_EVIDENCE_GUARD_POINTS = 10;

interface JudgedCount {
  readonly insufficientEvidence: number;
  readonly judged: number;
}

// Guard counts (abstentions plus unsupported on clipped evidence) from contradiction units; the aggregate also counts conveyance.
export function insufficientEvidenceCount(
  units: readonly { readonly kind: string; readonly verdict: string }[],
): JudgedCount {
  const judged = units.filter((unit) => unit.kind === "contradiction");
  return {
    insufficientEvidence: judged.filter(
      (unit) => unit.verdict === "insufficient-evidence" || unit.verdict === "unsupported-clipped",
    ).length,
    judged: judged.length,
  };
}

// Strictly more than the guard in percentage points, cross-multiplied so 30/100 vs 40/100 is not a veto.
const exceedsGuard = (control: JudgedCount, ablation: JudgedCount) => {
  const controlJudged = Math.max(control.judged, 1);
  const ablationJudged = Math.max(ablation.judged, 1);
  return (
    100 *
      (ablation.insufficientEvidence * controlJudged -
        control.insufficientEvidence * ablationJudged) >
    INSUFFICIENT_EVIDENCE_GUARD_POINTS * ablationJudged * controlJudged
  );
};

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const share = (count: JudgedCount) => count.insufficientEvidence / Math.max(count.judged, 1);
const conveyedShare = (values: readonly boolean[]) =>
  values.filter(Boolean).length / Math.max(values.length, 1);

// Statistics for the pre-registered stage deletion rule (docs/testing.md); deciding a deletion stays a human call.
export function stageDeletionStatistics(input: {
  readonly arm: keyof typeof ABLATION_ARMS;
  readonly control: ArmScores;
  readonly ablation: ArmScores;
  readonly conveyance?: Readonly<
    Record<string, { readonly control: readonly boolean[]; readonly ablation: readonly boolean[] }>
  >;
  // Pooled per arm over every sample's judged contradiction units.
  readonly insufficientEvidence: { readonly control: JudgedCount; readonly ablation: JudgedCount };
}): {
  readonly arm: string;
  readonly control: string;
  readonly removedStages: readonly string[];
  readonly captures: number;
  readonly meanDifference: number;
  readonly upperBound: number;
  readonly margin: number;
  readonly insufficientEvidenceShare: { readonly control: number; readonly ablation: number };
  readonly vetoes: readonly string[];
} {
  const definition: { readonly removed: readonly string[]; readonly control?: string } =
    ABLATION_ARMS[input.arm];
  if (definition.control === undefined) {
    throw new Error(`${input.arm} is a control arm, not an ablation`);
  }
  const captures = Object.keys(input.control).toSorted();
  if (
    captures.length === 0 ||
    captures.join("\n") !== Object.keys(input.ablation).toSorted().join("\n") ||
    captures.some((capture) => input.control[capture]!.length !== input.ablation[capture]!.length)
  ) {
    throw new Error("Arms must cover the same captures with the same sample count per capture");
  }
  const insufficientEvidenceShare = {
    control: share(input.insufficientEvidence.control),
    ablation: share(input.insufficientEvidence.ablation),
  };
  const scope = {
    arm: input.arm,
    control: definition.control,
    removedStages: definition.removed,
    captures: captures.length,
    margin: MARGIN,
    insufficientEvidenceShare,
  };
  const vetoes: string[] = [];
  if (exceedsGuard(input.insufficientEvidence.control, input.insufficientEvidence.ablation)) {
    vetoes.push(
      `insufficient-evidence share: ablation ${insufficientEvidenceShare.ablation.toFixed(3)} vs control ${insufficientEvidenceShare.control.toFixed(3)}`,
    );
  }
  for (const capture of captures) {
    for (const [arm, rows] of [
      ["control", input.control[capture]!],
      ["ablation", input.ablation[capture]!],
    ] as const) {
      if (rows.length === 0 || rows.some((row) => row === null)) {
        vetoes.push(`failed or missing sample: ${capture} ${arm}`);
      }
    }
  }
  for (const [caseId, rows] of Object.entries(input.conveyance ?? {})) {
    if (
      conveyedShare(rows.control) >= CONVEYED_SHARE &&
      conveyedShare(rows.ablation) < CONVEYED_SHARE
    ) {
      vetoes.push(`omission regression: ${caseId}`);
    }
  }
  if (vetoes.length > 0) {
    return { ...scope, meanDifference: Number.NaN, upperBound: Number.NaN, vetoes };
  }
  // Paired by sample index: canceled judge requests make each score relative to its control, not absolute.
  const differences = captures.map((capture) =>
    input.ablation[capture]!.map((value, index) => value! - input.control[capture]![index]!),
  );
  const random = mulberry32(SEED);
  const resample = (rows: readonly number[]) =>
    mean(rows.map(() => rows[Math.floor(random() * rows.length)]!));
  // Stratified: captures are the fixed corpus, only paired differences within each capture are resampled.
  const means = Array.from({ length: RESAMPLES }, () =>
    mean(differences.map((rows) => resample(rows))),
  ).toSorted((a, b) => a - b);
  return {
    ...scope,
    meanDifference: mean(differences.map((rows) => mean(rows))),
    upperBound: means[Math.ceil(0.95 * RESAMPLES) - 1]!,
    vetoes,
  };
}
