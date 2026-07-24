/**
 * Verified Market Snapshot report contract (ADR 0019).
 *
 * Single home for everything Phase A.2 numeric verification must match:
 * the citeable Source ID, the report Source record, the prompt citation
 * rule, and the missing-snapshot gap disclosure. The collector
 * (src/sources/verified-market-snapshot.ts) stays fetch + compute only.
 */

import type { IndicatorMap, Source, VerifiedMarketSnapshot } from "../domain/types";
import { verifiedMarketSnapshotSourceId } from "../sources/verified-market-snapshot";

/** Locked indicator key schema (ADR 0019). Phase A.2 matches these keys by name. */
export const INDICATOR_KEYS = [
  "ema10",
  "sma50",
  "sma200",
  "rsi14",
  "macd",
  "macdSignal",
  "macdHistogram",
  "bollUpper",
  "bollMiddle",
  "bollLower",
  "atr14",
] as const satisfies readonly (keyof IndicatorMap)[];

// Single construction point for the citeable report Source ID. Used by the
// Report source list, the evidence payload, and (later) Phase A.2 verification.
export function verifiedSnapshotSourceId(symbol: string): string {
  return verifiedMarketSnapshotSourceId(symbol);
}

// Citeable report Source for exact numeric technical claims.
export function verifiedSnapshotSource(snapshot: VerifiedMarketSnapshot): Source {
  return {
    id: verifiedSnapshotSourceId(snapshot.symbol),
    title: `${snapshot.symbol} verified market snapshot (OHLCV + indicators, ${snapshot.latestSessionDate})`,
    fetchedAt: snapshot.fetchedAt,
    kind: "market-data",
    assetClass: "equity",
    symbol: snapshot.symbol,
    provider: "yahoo",
  };
}

// Citation rule injected into every stage prompt alongside the snapshot.
// The key enumeration derives from INDICATOR_KEYS so it cannot drift from the schema.
export function verifiedSnapshotCitationRule(symbol: string): string {
  return `Exact indicator values (${INDICATOR_KEYS.join(", ")}) MUST cite source ID "${verifiedSnapshotSourceId(symbol)}". Do not state indicator values that are not present in verifiedMarketSnapshot. Current-session price values cite the market-data source. Never mix bar-close indicators with live quote price in one claim — they legitimately disagree intraday.`;
}

// Deterministic gap line disclosed when an equity ticker run has no snapshot.
export function missingVerifiedSnapshotGapText(symbol: string): string {
  return `No Verified Market Snapshot for ${symbol}: exact numeric technical-indicator claims are ungrounded for this run`;
}
