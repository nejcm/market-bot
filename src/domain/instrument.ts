import type { AssetClass } from "./job-type";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,24}$/u;

export function createInstrument(symbol: string, assetClass: AssetClass): Instrument {
  const normalizedSymbol = symbol.trim().toUpperCase();

  if (!SYMBOL_PATTERN.test(normalizedSymbol)) {
    throw new Error(
      "Symbol must be 1-25 characters using letters, numbers, dot, underscore, or hyphen",
    );
  }

  return {
    symbol: normalizedSymbol,
    assetClass,
  };
}

export function instrumentKey(instrument: Instrument): string {
  return `${instrument.assetClass}:${instrument.symbol}`;
}

export interface Instrument {
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly identity?: InstrumentIdentity;
}

export interface ProviderInstrumentId {
  readonly provider: string;
  readonly idKind: string;
  readonly value: string;
}

export interface InstrumentIdentity {
  readonly exchange?: string;
  readonly quoteCurrency?: string;
  readonly displayName?: string;
  readonly providerIds?: readonly ProviderInstrumentId[];
  readonly aliases?: readonly ProviderInstrumentId[];
}
