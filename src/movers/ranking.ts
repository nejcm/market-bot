import type { MarketSnapshot, Mover } from "../domain/types";

const MINIMUM_VOLUME = 10_000;

function scoreSnapshot(snapshot: MarketSnapshot): number {
  if (snapshot.volume < MINIMUM_VOLUME) {
    return 0;
  }

  return Math.abs(snapshot.changePercent24h) * Math.log10(snapshot.volume);
}

export function rankMovers(snapshots: readonly MarketSnapshot[], limit: number): readonly Mover[] {
  return snapshots
    .filter(
      (snapshot) =>
        Number.isFinite(snapshot.price) &&
        Number.isFinite(snapshot.changePercent24h) &&
        snapshot.volume >= MINIMUM_VOLUME,
    )
    .map((snapshot) => ({
      snapshot,
      rank: 0,
      score: scoreSnapshot(snapshot),
    }))
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
