/**
 * Verified Market Snapshot report contract (ADR 0019).
 *
 * Single home for everything Phase A.2 numeric verification must match:
 * the citeable Source ID, the report Source record, the prompt citation
 * rule, and the missing-snapshot gap disclosure. The collector
 * (src/sources/verified-market-snapshot.ts) stays fetch + compute only.
 */

import type { IndicatorMap, MarketSnapshot, Source, VerifiedMarketSnapshot } from "../domain/types";
import { verifiedMarketSnapshotSourceId } from "../sources/verified-market-snapshot";

type RequiredKeys<T> = {
  [Key in keyof T]-?: Pick<T, Key> extends Required<Pick<T, Key>> ? Key : never;
}[keyof T];

const ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS = [
  "sourceId",
  "assetClass",
  "symbol",
  "name",
  "identity",
  "benchmark",
  "price",
  "changePercent24h",
  "volume",
  "marketCap",
  "open",
  "previousClose",
  "averageVolume",
  "fiftyDayAverage",
  "fundamentals",
  "observedAt",
] as const satisfies readonly (keyof MarketSnapshot)[];

type MissingRequiredPromptKey = Exclude<
  RequiredKeys<MarketSnapshot>,
  (typeof ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS)[number]
>;

const CHECKED_ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS: MissingRequiredPromptKey extends never
  ? typeof ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS
  : never = ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS;
const ALLOWED_PROMPT_MARKET_SNAPSHOT_KEY_SET = new Set<string>(
  CHECKED_ALLOWED_PROMPT_MARKET_SNAPSHOT_KEYS,
);

// This projection is deliberately an allow-list of the MarketSnapshot fields exposed to prompts.
// New MarketSnapshot fields stay model-invisible until they are deliberately added here.
// This projection must not be converted to a delete-list.
// This projection deliberately preserves surviving input key order because key order changes prompt bytes.
// The required-key check makes a new required field fail compilation until its prompt visibility is decided.
export function forPrompt(snapshots: readonly MarketSnapshot[]): readonly MarketSnapshot[] {
  return snapshots.map(
    (snapshot) =>
      Object.fromEntries(
        Object.entries(snapshot).filter(([key]) => ALLOWED_PROMPT_MARKET_SNAPSHOT_KEY_SET.has(key)),
      ) as MarketSnapshot,
  );
}

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
