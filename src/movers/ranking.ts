import type { MarketSnapshot, Mover } from "../domain/types";

const MINIMUM_VOLUME = 10_000;
const UNUSUAL_VOLUME_THRESHOLD = 1.5;
const UNUSUAL_VOLUME_BOOST_DIVISOR = 8;
const MAX_UNUSUAL_VOLUME_BOOST = 0.25;
const GAP_THRESHOLD_PERCENT = 1;
const GAP_BOOST_DIVISOR = 50;
const MAX_GAP_BOOST = 0.2;

function finitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundFeature(value: number): number {
  return Number(value.toFixed(4));
}

function moverReasons(
  movementMagnitude: number,
  benchmarkSymbol: string | undefined,
  relativeChangePercent24h: number | undefined,
  liquidityLog: number,
  unusualVolumeRatio: number | undefined,
  volumeIsUnusual: boolean,
  gapPercent: number | undefined,
  gapIsNotable: boolean,
): readonly string[] {
  return [
    `${roundFeature(movementMagnitude)}% absolute 24h move`,
    ...(benchmarkSymbol !== undefined && relativeChangePercent24h !== undefined
      ? [`${roundFeature(relativeChangePercent24h)}pp move vs ${benchmarkSymbol}`]
      : []),
    `log10 volume ${roundFeature(liquidityLog)}`,
    ...(volumeIsUnusual && unusualVolumeRatio !== undefined
      ? [`volume ${roundFeature(unusualVolumeRatio)}x average`]
      : []),
    ...(gapIsNotable && gapPercent !== undefined
      ? [`${roundFeature(Math.abs(gapPercent))}% absolute opening gap`]
      : []),
  ];
}

function buildMover(snapshot: MarketSnapshot): Omit<Mover, "rank"> {
  const movementMagnitude = Math.abs(snapshot.changePercent24h);
  const relativeChangePercent24h =
    snapshot.benchmark !== undefined
      ? snapshot.changePercent24h - snapshot.benchmark.changePercent24h
      : undefined;
  const relativeMovementMagnitude =
    relativeChangePercent24h !== undefined ? Math.abs(relativeChangePercent24h) : undefined;
  const liquidityLog = Math.log10(snapshot.volume);
  const baseScore = movementMagnitude * liquidityLog;
  const unusualVolumeRatio = finitePositive(snapshot.averageVolume)
    ? snapshot.volume / snapshot.averageVolume
    : undefined;
  const volumeIsUnusual =
    unusualVolumeRatio !== undefined && unusualVolumeRatio >= UNUSUAL_VOLUME_THRESHOLD;
  const unusualVolumeBoost =
    volumeIsUnusual && unusualVolumeRatio !== undefined
      ? Math.min(
          Math.log2(unusualVolumeRatio) / UNUSUAL_VOLUME_BOOST_DIVISOR,
          MAX_UNUSUAL_VOLUME_BOOST,
        )
      : 0;
  const gapPercent =
    finitePositive(snapshot.open) && finitePositive(snapshot.previousClose)
      ? ((snapshot.open - snapshot.previousClose) / snapshot.previousClose) * 100
      : undefined;
  const gapIsNotable = gapPercent !== undefined && Math.abs(gapPercent) >= GAP_THRESHOLD_PERCENT;
  const gapBoost =
    gapIsNotable && gapPercent !== undefined
      ? Math.min(Math.abs(gapPercent) / GAP_BOOST_DIVISOR, MAX_GAP_BOOST)
      : 0;
  const finalMultiplier = 1 + unusualVolumeBoost + gapBoost;

  return {
    snapshot,
    score: baseScore * finalMultiplier,
    features: {
      movementMagnitude: roundFeature(movementMagnitude),
      ...(snapshot.benchmark !== undefined
        ? {
            benchmarkSymbol: snapshot.benchmark.symbol,
            benchmarkChangePercent24h: roundFeature(snapshot.benchmark.changePercent24h),
          }
        : {}),
      ...(relativeChangePercent24h !== undefined
        ? { relativeChangePercent24h: roundFeature(relativeChangePercent24h) }
        : {}),
      ...(relativeMovementMagnitude !== undefined
        ? { relativeMovementMagnitude: roundFeature(relativeMovementMagnitude) }
        : {}),
      liquidityLog: roundFeature(liquidityLog),
      baseScore: roundFeature(baseScore),
      ...(unusualVolumeRatio !== undefined
        ? { unusualVolumeRatio: roundFeature(unusualVolumeRatio) }
        : {}),
      unusualVolumeBoost: roundFeature(unusualVolumeBoost),
      ...(gapPercent !== undefined ? { gapPercent: roundFeature(gapPercent) } : {}),
      gapBoost: roundFeature(gapBoost),
      finalMultiplier: roundFeature(finalMultiplier),
      reasons: moverReasons(
        movementMagnitude,
        snapshot.benchmark?.symbol,
        relativeChangePercent24h,
        liquidityLog,
        unusualVolumeRatio,
        volumeIsUnusual,
        gapPercent,
        gapIsNotable,
      ),
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
