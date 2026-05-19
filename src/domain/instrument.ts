import type { AssetClass, Instrument } from "./types";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,24}$/;

export function createInstrument(symbol: string, assetClass: AssetClass): Instrument {
  const normalizedSymbol = symbol.trim().toUpperCase();

  if (!SYMBOL_PATTERN.test(normalizedSymbol)) {
    throw new Error("Symbol must be 1-25 characters using letters, numbers, dot, underscore, or hyphen");
  }

  return {
    symbol: normalizedSymbol,
    assetClass,
  };
}

export function instrumentKey(instrument: Instrument): string {
  return `${instrument.assetClass}:${instrument.symbol}`;
}
