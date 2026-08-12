export const EVALUATION_RANDOM_STREAM_DERIVATION =
  "MurmurHash3 fmix32((seed uint32) XOR stream salt)";

export const EVALUATION_RANDOM_STREAM_SALTS = {
  variantOrder: 608_135_816,
  blindLabels: 2_242_054_355,
  pairedBootstrap: 320_440_878,
} as const;

export type EvaluationRandomStreamName = keyof typeof EVALUATION_RANDOM_STREAM_SALTS;

const UINT32_RANGE = 4_294_967_296;

function toUint32(value: number): number {
  const remainder = value % UINT32_RANGE;
  return remainder < 0 ? remainder + UINT32_RANGE : remainder;
}

function mixUint32(value: number): number {
  let mixed = value;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 2_246_822_507);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 3_266_489_909);
  return toUint32(mixed ^ (mixed >>> 16));
}

export function deriveEvaluationStreamSeed(
  seed: number,
  stream: EvaluationRandomStreamName,
): number {
  if (!Number.isInteger(seed)) {
    throw new TypeError("evaluation seed must be an integer");
  }
  return mixUint32(toUint32(seed) ^ EVALUATION_RANDOM_STREAM_SALTS[stream]);
}
