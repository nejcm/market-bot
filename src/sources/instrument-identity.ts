/**
 * Canonical Instrument Identity derivation for equity ticker runs (ADR 0004).
 *
 * No second quote fetch in the happy path — the ticker quote is already
 * fetched by collectEquity via requestJsonWithQuoteFallback. Derive identity
 * from the already-collected MarketSnapshot.
 *
 * ADR 0004 note: this is run-scoped canonicalization, not a global resolver.
 */

import type { InstrumentIdentity, MarketSnapshot, SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";

export interface InstrumentIdentityResult {
  readonly identity?: InstrumentIdentity;
  readonly gap?: SourceGap;
}

// Derive canonical InstrumentIdentity from an already-collected ticker
// MarketSnapshot. Returns the snapshot's identity when present; no extra fetch.
// When no identity is derivable, a no-cap gap discloses that the run lacks
// Its do-not-substitute identity guard; the missing quote itself already
// Produces its own core gap.
export function deriveCanonicalInstrumentIdentity(
  marketSnapshots: readonly MarketSnapshot[],
  symbol: string,
): InstrumentIdentityResult {
  const tickerSnapshot = marketSnapshots.find((s) => s.symbol === symbol);
  if (tickerSnapshot?.identity !== undefined) {
    return { identity: tickerSnapshot.identity };
  }
  return {
    // No provider attribution: the ticker quote may arrive via the Massive fallback
    gap: sourceGap({
      source: "instrument-identity",
      message: `No canonical instrument identity derivable for ${symbol}: ticker quote snapshot missing or carries no identity`,
      capability: "market-data",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    }),
  };
}
