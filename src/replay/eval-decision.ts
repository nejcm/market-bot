type ArmDefects = Readonly<Record<string, readonly (number | null)[]>>;

const MARGIN = 0.5;
const RESAMPLES = 10_000;
const SEED = 0x5e_ed;
const CONVEYED_SHARE = 2 / 3;

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
const conveyedShare = (values: readonly boolean[]) =>
  values.filter(Boolean).length / Math.max(values.length, 1);

// Pre-registered stage deletion rule (docs/testing.md): per-capture paired difference, cluster bootstrap, vetoes.
export function stageDeletionVerdict(input: {
  readonly baseline: ArmDefects;
  readonly ablation: ArmDefects;
  readonly conveyance?: Readonly<
    Record<string, { readonly baseline: readonly boolean[]; readonly ablation: readonly boolean[] }>
  >;
}): {
  readonly pass: boolean;
  readonly meanDifference: number;
  readonly upperBound: number;
  readonly vetoes: readonly string[];
} {
  const captures = Object.keys(input.baseline).toSorted();
  if (
    captures.length === 0 ||
    captures.join("\n") !== Object.keys(input.ablation).toSorted().join("\n") ||
    captures.some((capture) => input.baseline[capture]!.length !== input.ablation[capture]!.length)
  ) {
    throw new Error("Arms must cover the same captures with the same sample count per capture");
  }
  const vetoes: string[] = [];
  for (const capture of captures) {
    for (const [arm, rows] of [
      ["baseline", input.baseline[capture]!],
      ["ablation", input.ablation[capture]!],
    ] as const) {
      if (rows.length === 0 || rows.some((row) => row === null)) {
        vetoes.push(`failed or missing sample: ${capture} ${arm}`);
      }
    }
  }
  for (const [caseId, rows] of Object.entries(input.conveyance ?? {})) {
    if (
      conveyedShare(rows.baseline) >= CONVEYED_SHARE &&
      conveyedShare(rows.ablation) < CONVEYED_SHARE
    ) {
      vetoes.push(`omission regression: ${caseId}`);
    }
  }
  if (vetoes.length > 0) {
    return { pass: false, meanDifference: Number.NaN, upperBound: Number.NaN, vetoes };
  }
  const differences = captures.map(
    (capture) =>
      mean(input.ablation[capture] as readonly number[]) -
      mean(input.baseline[capture] as readonly number[]),
  );
  const random = mulberry32(SEED);
  const means = Array.from({ length: RESAMPLES }, () =>
    mean(differences.map(() => differences[Math.floor(random() * differences.length)]!)),
  ).toSorted((a, b) => a - b);
  const upperBound = means[Math.ceil(0.95 * RESAMPLES) - 1]!;
  return { pass: upperBound <= MARGIN, meanDifference: mean(differences), upperBound, vetoes };
}
