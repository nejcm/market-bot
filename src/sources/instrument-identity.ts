/**
 * Canonical Instrument Identity derivation for equity ticker runs (ADR 0019).
 *
 * No second quote fetch in the happy path — the ticker quote is already
 * fetched by collectEquity via requestJsonWithQuoteFallback. Derive identity
 * from the already-collected MarketSnapshot.
 *
 * ADR 0008 note: this is run-scoped canonicalization, not a global resolver.
 */

import type { InstrumentIdentity, MarketSnapshot } from "../domain/types";

export interface InstrumentIdentityResult {
  readonly identity?: InstrumentIdentity;
}

// Derive canonical InstrumentIdentity from an already-collected ticker
// MarketSnapshot. Returns the snapshot's identity when present; no extra fetch.
// MarketSnapshots: all collected MarketSnapshots for this run.
// Symbol: ticker symbol to match.
export function deriveCanonicalInstrumentIdentity(
  marketSnapshots: readonly MarketSnapshot[],
  symbol: string,
): InstrumentIdentityResult {
  const tickerSnapshot = marketSnapshots.find((s) => s.symbol === symbol);
  if (tickerSnapshot?.identity !== undefined) {
    return { identity: tickerSnapshot.identity };
  }
  return {};
}
