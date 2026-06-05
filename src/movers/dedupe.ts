import type { MarketSnapshot } from "../domain/types";

interface SymbolSnapshot {
  readonly snapshot: Pick<MarketSnapshot, "symbol">;
}

export function dedupeMoversBySymbol<T extends SymbolSnapshot>(movers: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  return movers.filter((mover) => {
    const { symbol } = mover.snapshot;
    if (seen.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    return true;
  });
}
