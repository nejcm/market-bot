import type { MarketSnapshot, Mover } from "../domain/types";

const MINIMUM_VOLUME = 10_000;
const UNUSUAL_VOLUME_THRESHOLD = 1.5;
const MAX_UNUSUAL_VOLUME_BOOST = 0.25;
const GAP_THRESHOLD_PERCENT = 1;
const MAX_GAP_BOOST = 0.2;

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundFeature(value: number): number {
  return Number(value.toFixed(4));
}

function moverReasons(
  movementMagnitude: number,
  liquidityLog: number,
  unusualVolumeRatio: number | undefined,
  gapPercent: number | undefined,
): readonly string[] {
  return [
    `${roundFeature(movementMagnitude)}% absolute 24h move`,
    `log10 volume ${roundFeature(liquidityLog)}`,
    ...(unusualVolumeRatio !== undefined && unusualVolumeRatio >= UNUSUAL_VOLUME_THRESHOLD
      ? [`volume ${roundFeature(unusualVolumeRatio)}x average`]
      : []),
    ...(gapPercent !== undefined && Math.abs(gapPercent) >= GAP_THRESHOLD_PERCENT
      ? [`${roundFeature(Math.abs(gapPercent))}% absolute opening gap`]
      : []),
  ];
}

function buildMover(snapshot: MarketSnapshot): Omit<Mover, "rank"> {
  const movementMagnitude = Math.abs(snapshot.changePercent24h);
  const liquidityLog = Math.log10(snapshot.volume);
  const baseScore = movementMagnitude * liquidityLog;
  const unusualVolumeRatio = finitePositive(snapshot.averageVolume)
    ? snapshot.volume / snapshot.averageVolume
    : undefined;
  const unusualVolumeBoost =
    unusualVolumeRatio !== undefined && unusualVolumeRatio >= UNUSUAL_VOLUME_THRESHOLD
      ? Math.min(Math.log2(unusualVolumeRatio) / 8, MAX_UNUSUAL_VOLUME_BOOST)
      : 0;
  const gapPercent =
    finitePositive(snapshot.open) && finitePositive(snapshot.previousClose)
      ? ((snapshot.open - snapshot.previousClose) / snapshot.previousClose) * 100
      : undefined;
  const gapBoost =
    gapPercent !== undefined && Math.abs(gapPercent) >= GAP_THRESHOLD_PERCENT
      ? Math.min(Math.abs(gapPercent) / 50, MAX_GAP_BOOST)
      : 0;
  const finalMultiplier = 1 + unusualVolumeBoost + gapBoost;

  return {
    snapshot,
    score: baseScore * finalMultiplier,
    features: {
      movementMagnitude: roundFeature(movementMagnitude),
      liquidityLog: roundFeature(liquidityLog),
      baseScore: roundFeature(baseScore),
      ...(unusualVolumeRatio !== undefined
        ? { unusualVolumeRatio: roundFeature(unusualVolumeRatio) }
        : {}),
      unusualVolumeBoost: roundFeature(unusualVolumeBoost),
      ...(gapPercent !== undefined ? { gapPercent: roundFeature(gapPercent) } : {}),
      gapBoost: roundFeature(gapBoost),
      finalMultiplier: roundFeature(finalMultiplier),
      reasons: moverReasons(movementMagnitude, liquidityLog, unusualVolumeRatio, gapPercent),
    },
  };
}

export function rankMovers(snapshots: readonly MarketSnapshot[], limit: number): readonly Mover[] {
  return snapshots
    .filter(
      (snapshot) =>
        Number.isFinite(snapshot.price) &&
        Number.isFinite(snapshot.changePercent24h) &&
        Number.isFinite(snapshot.volume) &&
        snapshot.volume >= MINIMUM_VOLUME,
    )
    .map((snapshot) => ({ ...buildMover(snapshot), rank: 0 }))
    .toSorted((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.snapshot.symbol.localeCompare(right.snapshot.symbol);
    })
    .slice(0, limit)
    .map((mover, index) => ({
      ...mover,
      rank: index + 1,
    }));
}
